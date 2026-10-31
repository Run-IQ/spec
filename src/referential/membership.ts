import { SpecError, unreadableMessage } from '../errors.js';
import {
  dimensionValueProblem,
  normalizeDimensionSpec,
  splitQualified,
} from '../rule/dimensions.js';
import type { DimensionSpec } from '../rule/dimensions.js';
import { isCivilDate } from '../time/civil.js';
import type { CivilDate } from '../time/civil.js';
import { readLimits } from './limits.js';
import type { ReferentialLimits } from './limits.js';
import type { Membership, Referential, ReferentialMember } from './types.js';

/**
 * How a rule's dimension matched the input (D-18): `values` lists the input values that
 * matched, sorted; `via` the groups crossed, each once, in the order the matched values
 * (sorted) crossed them first.
 */
export type DimensionMatch =
  | { result: true; values: string[]; via: string[] }
  | { result: false; why: string }
  | { result: 'unknown'; why: string };

/** An input value read in a referential: a valid code, or an unknown membership. */
type ReadValue = { kind: 'code'; code: string } | { kind: 'unknown'; why: string };

/** A value of a rule's spec read in a referential: a group or a code. */
type Target = { kind: 'group'; name: string } | { kind: 'code'; code: string };

/** One group being resolved by `Resolver.inGroup`: its nested groups left to ask. */
interface Frame {
  group: string;
  exhaustive: boolean;
  nested: readonly string[];
  next: number;
  unknown: Membership | undefined;
}

/**
 * Whether `value` belongs to `group` of the referential at the civil date `at`, in three values
 * (Kleene), as `Referential` defines it:
 * - `value` names an entity (a code), never a group: a group name is refused
 *   (`input value UE is a group of ue`);
 * - a value written `<system>:<code>` is read in the referential's `codeSystem` only (another
 *   system, or a referential without one: unknown); with `codes`, a value absent from them
 *   (`code ZZ not in referential ue`) or not valid at `at` (`code YU not valid at 2026-01-01`)
 *   is unknown; a group name is never read as a code;
 * - a group holds the members whose period contains `at` (`from` included, `until` excluded);
 *   the value is in the group when it is one of them, or when a nested group holds it; it is
 *   outside when the group is exhaustive and every nested group answers false; otherwise it is
 *   unknown (`XX in MONDE is unknown: MONDE is not exhaustive`).
 *
 * `via` goes from `group` down to the group that holds the value directly; a direct membership
 * wins, then the nested groups in code-unit order of their names, so `via` does not depend on
 * the order of members. Each group is resolved at most once per call, by an iterative walk:
 * linear in the size of the referential, and no stack overflow whatever its depth.
 *
 * `options` are those of `validateReferential`; `maxDepth` (default 64, at most 1 024) bounds
 * the nesting walked.
 *
 * Expects a valid referential (`validateReferential`). Throws `SpecError`:
 * `INVALID_REFERENTIAL` for an unknown group (`group ASEAN not in referential ue`), nesting
 * deeper than `maxDepth` (a cycle included), a referential that cannot be read, or invalid
 * options; `INVALID_DATE` when `at` is not a civil date; `INVALID_INPUT` for an invalid value
 * or a group name as value.
 */
export function resolveMembership(
  referential: Referential,
  group: string,
  value: string,
  at: CivilDate,
  options: ReferentialLimits = {},
): Membership {
  const { maxDepth } = readLimits(options);
  return guarded(() => {
    requireDate(at);
    const problem = dimensionValueProblem(value, 'value');
    if (problem !== undefined) throw new SpecError('INVALID_INPUT', problem);
    const groups = referential.groups;
    if (typeof group !== 'string' || !Object.hasOwn(groups, group)) {
      throw new SpecError(
        'INVALID_REFERENTIAL',
        `group ${String(group)} not in referential ${referential.id}`,
      );
    }
    const read = readValue(referential, value, at);
    return new Resolver(referential, at, maxDepth).member(group, read);
  });
}

/**
 * Whether the input values of one dimension match a rule's `DimensionSpec` at the civil date
 * `at` (the rule's reference date, D-18), in three values:
 * - without `ref`, an input value matches when it equals a value of the spec;
 * - with `ref`, through the referential of that id in `referentials`: an input value matches
 *   when it belongs to a group of `anyOf` or equals a code of it (OR), and belongs to none of
 *   `except` (NOT OR), each membership judged at `at` by `resolveMembership` (so an input
 *   value that is a group name is refused);
 * - `match: 'any'` (default) is an OR over the input values, `'all'` an AND.
 *
 * `options` are those of `validateReferential` (`maxDepth` bounds the nesting walked).
 *
 * Throws `SpecError`: `INVALID_RULE` for an invalid spec (a qualified value with `ref`
 * included: the referential fixes the code system); `INVALID_REFERENTIAL` for a `ref` absent
 * from `referentials` (`unknown referential ue`), a value of the spec the referential does not
 * know when it declares `codes`, or invalid options; `INVALID_INPUT` for an input that cannot
 * be read, an empty input list, an invalid input value or a group name as input value;
 * `INVALID_DATE` for an invalid `at`.
 */
export function matchDimension(
  spec: DimensionSpec,
  input: string | readonly string[],
  at: CivilDate,
  referentials: ReadonlyMap<string, Referential>,
  options: ReferentialLimits = {},
): DimensionMatch {
  const { maxDepth } = readLimits(options);
  return guarded(() => {
    const normal = normalizeDimensionSpec(spec);
    requireDate(at);
    const values = readInput(input);
    const anyOf = typeof normal === 'string' ? [normal] : normal.anyOf;
    const except = typeof normal === 'string' ? [] : (normal.except ?? []);
    const ref = typeof normal === 'string' ? undefined : normal.ref;
    const all = typeof normal !== 'string' && normal.match === 'all';

    let judge: (value: string) => Membership;
    if (ref === undefined) {
      judge = (value) => (anyOf.includes(value) ? { result: true, via: [] } : { result: false });
    } else {
      const referential = referentials.get(ref);
      if (referential === undefined) {
        throw new SpecError('INVALID_REFERENTIAL', `unknown referential ${ref}`);
      }
      const targets = [...anyOf, ...except].map((t) => readTarget(referential, t));
      const resolver = new Resolver(referential, at, maxDepth);
      const of = (value: ReadValue, from: number, to: number): Membership =>
        anyMember(targets.slice(from, to).map((target) => resolver.target(target, value)));
      judge = (raw) => {
        const value = readValue(referential, raw, at);
        const inAnyOf = of(value, 0, anyOf.length);
        const inExcept = of(value, anyOf.length, targets.length);
        return andNot(inAnyOf, inExcept);
      };
    }
    return combine(
      values.map((value) => ({ value, membership: judge(value) })),
      all,
    );
  });
}

/** Runs `call`, turning anything but a `SpecError` into `INVALID_REFERENTIAL`. */
function guarded<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    if (error instanceof SpecError) throw error;
    throw new SpecError('INVALID_REFERENTIAL', unreadableMessage('referential', error));
  }
}

function requireDate(at: unknown): void {
  if (!isCivilDate(at)) {
    throw new SpecError('INVALID_DATE', `the date must be a civil date YYYY-MM-DD`);
  }
}

/** The input values, sorted without duplicates; never empty. */
function readInput(input: unknown): string[] {
  if (typeof input === 'string') return checkInput([input], input);
  let list: unknown[];
  try {
    if (!Array.isArray(input)) {
      throw new SpecError('INVALID_INPUT', 'input must be a value or an array of values');
    }
    list = Array.from(input);
  } catch (error) {
    if (error instanceof SpecError) throw error;
    throw new SpecError('INVALID_INPUT', unreadableMessage('input', error));
  }
  return checkInput(list, input);
}

/** The values of `list` checked, sorted without duplicates; never empty. */
function checkInput(list: readonly unknown[], input: unknown): string[] {
  if (list.length === 0) {
    throw new SpecError('INVALID_INPUT', 'a dimension input must hold at least one value');
  }
  list.forEach((value, i) => {
    const problem = dimensionValueProblem(
      value,
      typeof input === 'string' ? 'input' : `input[${i}]`,
    );
    if (problem !== undefined) throw new SpecError('INVALID_INPUT', problem);
  });
  return [...new Set(list.map(String))].sort();
}

/**
 * An input value as the referential reads it at `at`. Throws `INVALID_INPUT` for a group
 * name: an input names an entity, not a group.
 */
function readValue(referential: Referential, value: string, at: CivilDate): ReadValue {
  const { system, code } = splitQualified(value);
  if (system !== undefined) {
    const own = referential.codeSystem;
    if (own === undefined) {
      return {
        kind: 'unknown',
        why: `code system ${system} is not declared by referential ${referential.id}`,
      };
    }
    if (system !== own) return { kind: 'unknown', why: `code system ${system} is not ${own}` };
  }
  if (Object.hasOwn(referential.groups, code)) {
    throw new SpecError('INVALID_INPUT', `input value ${value} is a group of ${referential.id}`);
  }
  const codes = referential.codes;
  if (codes === undefined) return { kind: 'code', code };
  if (!Object.hasOwn(codes, code)) {
    return { kind: 'unknown', why: `code ${code} not in referential ${referential.id}` };
  }
  const periods = codes[code] ?? [];
  const valid = periods.some((p) => p.from <= at && (p.until == null || at < p.until));
  return valid
    ? { kind: 'code', code }
    : { kind: 'unknown', why: `code ${code} not valid at ${at}` };
}

/**
 * A value of a rule's spec, as the referential knows it: a group or a code. The spec is
 * normal, so the value is unqualified: with `ref`, the referential fixes the code system.
 */
function readTarget(referential: Referential, target: string): Target {
  if (Object.hasOwn(referential.groups, target)) return { kind: 'group', name: target };
  const codes = referential.codes;
  if (codes !== undefined && !Object.hasOwn(codes, target)) {
    throw new SpecError(
      'INVALID_REFERENTIAL',
      `${target} is neither a group nor a code of referential ${referential.id}`,
    );
  }
  return { kind: 'code', code: target };
}

/** Kleene OR of memberships: the first true (in order), else the first unknown, else false. */
function anyMember(list: readonly Membership[]): Membership {
  const yes = list.find((m) => m.result === true);
  if (yes) return yes;
  return list.find((m) => m.result === 'unknown') ?? { result: false };
}

/** Kleene `a AND NOT b`. */
function andNot(a: Membership, b: Membership): Membership {
  if (a.result === false || b.result === true) return { result: false };
  if (a.result === 'unknown') return a;
  if (b.result === 'unknown') return b;
  return a;
}

function combine(
  judged: readonly { value: string; membership: Membership }[],
  all: boolean,
): DimensionMatch {
  const unknown = judged.find((j) => j.membership.result === 'unknown')?.membership;
  if (all) {
    const failed = judged.find((j) => j.membership.result === false);
    if (failed) return { result: false, why: `input value ${failed.value} does not match` };
  } else if (!judged.some((j) => j.membership.result === true)) {
    return unknown?.result === 'unknown'
      ? { result: 'unknown', why: unknown.why }
      : { result: false, why: 'no input value matches' };
  }
  if (all && unknown?.result === 'unknown') return { result: 'unknown', why: unknown.why };
  const values: string[] = [];
  const via: string[] = [];
  for (const { value, membership } of judged) {
    if (membership.result !== true) continue;
    values.push(value);
    for (const group of membership.via) if (!via.includes(group)) via.push(group);
  }
  return { result: true, values, via };
}

/** Resolves memberships at one date in one referential, each group at most once per value. */
class Resolver {
  /** For each value, the membership of each group already resolved. */
  private readonly memo = new Map<string, Map<string, Membership>>();

  constructor(
    private readonly referential: Referential,
    private readonly at: CivilDate,
    private readonly maxDepth: number,
  ) {}

  /** `value` (already read) in the group or code `target`. */
  target(target: Target, value: ReadValue): Membership {
    if (value.kind === 'unknown') return { result: 'unknown', why: value.why };
    if (target.kind === 'code') {
      return value.code === target.code ? { result: true, via: [] } : { result: false };
    }
    return this.member(target.name, value);
  }

  /** `value` (already read) in `group`. */
  member(group: string, value: ReadValue): Membership {
    if (value.kind === 'unknown') return { result: 'unknown', why: value.why };
    const memo = this.memo.get(value.code) ?? new Map<string, Membership>();
    this.memo.set(value.code, memo);
    return this.inGroup(group, value.code, memo);
  }

  /**
   * `value` in `group`, by an iterative depth-first walk: a direct member wins, then the nested
   * groups in name order; the first true ends a group, else its first unknown, else its
   * exhaustiveness decides. More than `maxDepth` groups on the walk (a cycle included) throws.
   */
  private inGroup(group: string, value: string, memo: Map<string, Membership>): Membership {
    const stack: Frame[] = [];
    let result = this.open(group, value, memo, stack);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      if (result !== undefined) {
        // `result` answers the nested group `frame.nested[frame.next]`.
        frame.next++;
        if (result.result === true) {
          result = this.close(frame, { result: true, via: [frame.group, ...result.via] }, memo);
          stack.pop();
          continue;
        }
        if (result.result === 'unknown') frame.unknown ??= result;
        result = undefined;
      }
      const name = frame.nested[frame.next];
      if (name === undefined) {
        result = this.close(frame, this.settle(frame, value), memo);
        stack.pop();
        continue;
      }
      result = this.open(name, value, memo, stack);
    }
    return result ?? { result: false };
  }

  /** The membership of `group` if known at once; otherwise pushes its frame. */
  private open(
    group: string,
    value: string,
    memo: Map<string, Membership>,
    stack: Frame[],
  ): Membership | undefined {
    const known = memo.get(group);
    if (known !== undefined) return known;
    if (stack.length >= this.maxDepth) {
      throw new SpecError('INVALID_REFERENTIAL', `group nesting deeper than ${this.maxDepth}`);
    }
    const groups = this.referential.groups;
    const entry = groups[group];
    const active = (entry?.members ?? []).filter((m) => this.isActive(m));
    if (active.some((m) => m.value === value)) {
      const direct: Membership = { result: true, via: [group] };
      memo.set(group, direct);
      return direct;
    }
    const nested = [...new Set(active.map((m) => m.value))]
      .filter((name) => Object.hasOwn(groups, name))
      .sort();
    const exhaustive = entry?.exhaustive === true;
    stack.push({ group, exhaustive, nested, next: 0, unknown: undefined });
    return undefined;
  }

  /** The membership of a group whose nested groups all answered without true. */
  private settle(frame: Frame, value: string): Membership {
    if (frame.unknown !== undefined) return frame.unknown;
    if (frame.exhaustive) return { result: false };
    return {
      result: 'unknown',
      why: `${value} in ${frame.group} is unknown: ${frame.group} is not exhaustive`,
    };
  }

  private close(frame: Frame, result: Membership, memo: Map<string, Membership>): Membership {
    memo.set(frame.group, result);
    return result;
  }

  private isActive(member: ReferentialMember): boolean {
    const { from, until } = member;
    return (from === undefined || from <= this.at) && (until == null || this.at < until);
  }
}
