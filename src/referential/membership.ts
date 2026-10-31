import { SpecError, unreadableMessage } from '../errors.js';
import {
  dimensionValueProblem,
  normalizeDimensionSpec,
  splitQualified,
} from '../rule/dimensions.js';
import type { DimensionSpec } from '../rule/dimensions.js';
import { isCivilDate } from '../time/civil.js';
import type { CivilDate } from '../time/civil.js';
import { DEFAULT_MAX_GROUP_DEPTH } from './validate.js';
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

/** A value read in a referential: a group name, a valid code, or an unknown membership. */
type ReadValue =
  | { kind: 'group'; name: string }
  | { kind: 'code'; code: string }
  | { kind: 'unknown'; why: string };

/**
 * Whether `value` belongs to `group` of the referential at the civil date `at`, in three values
 * (Kleene), as `Referential` defines it:
 * - `value` equal to `group`: true, `via: []`;
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
 * the order of members. Each group is resolved at most once per call: linear in the size of
 * the referential.
 *
 * Expects a valid referential (`validateReferential`). Throws `SpecError`:
 * `INVALID_REFERENTIAL` for an unknown group (`group ASEAN not in referential ue`), nesting
 * deeper than 64 or a referential that cannot be read; `INVALID_DATE` when `at` is not a civil
 * date; `INVALID_INPUT` for an invalid value.
 */
export function resolveMembership(
  referential: Referential,
  group: string,
  value: string,
  at: CivilDate,
): Membership {
  return guarded(() => {
    requireDate(at);
    const problem = dimensionValueProblem(value, 'value');
    if (problem !== undefined) throw new SpecError('INVALID_INPUT', problem);
    const groups = referential.groups;
    if (!Object.hasOwn(groups, group)) {
      throw new SpecError(
        'INVALID_REFERENTIAL',
        `group ${group} not in referential ${referential.id}`,
      );
    }
    return new Resolver(referential, at).member(group, readValue(referential, value, at));
  });
}

/**
 * Whether the input values of one dimension match a rule's `DimensionSpec` at the civil date
 * `at` (the rule's reference date, D-18), in three values:
 * - without `ref`, an input value matches when it equals a value of the spec;
 * - with `ref`, through the referential of that id in `referentials`: an input value matches
 *   when it belongs to a group of `anyOf` or equals a code of it (OR), and belongs to none of
 *   `except` (NOT OR), each membership judged at `at` by `resolveMembership`;
 * - `match: 'any'` (default) is an OR over the input values, `'all'` an AND.
 *
 * Throws `SpecError`: `INVALID_RULE` for an invalid spec; `INVALID_REFERENTIAL` for a `ref`
 * absent from `referentials` (`unknown referential ue`), a value of the spec the referential
 * does not know when it declares `codes`, or a value of another code system; `INVALID_INPUT`
 * for an empty input list or an invalid input value; `INVALID_DATE` for an invalid `at`.
 */
export function matchDimension(
  spec: DimensionSpec,
  input: string | readonly string[],
  at: CivilDate,
  referentials: ReadonlyMap<string, Referential>,
): DimensionMatch {
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
      const resolver = new Resolver(referential, at);
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
function readInput(input: string | readonly string[]): string[] {
  const list: unknown[] = typeof input === 'string' ? [input] : Array.from(input);
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
  return [...new Set(list as string[])].sort();
}

/** An input value as the referential reads it at `at`. */
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
  if (Object.hasOwn(referential.groups, code)) return { kind: 'group', name: code };
  const codes = referential.codes;
  if (codes === undefined) return { kind: 'code', code };
  if (!Object.hasOwn(codes, code)) {
    return { kind: 'unknown', why: `code ${code} not in referential ${referential.id}` };
  }
  const periods = codes[code] ?? [];
  const valid = periods.some((p) => p.from <= at && (p.until === null || at < p.until));
  return valid
    ? { kind: 'code', code }
    : { kind: 'unknown', why: `code ${code} not valid at ${at}` };
}

/** A value of a rule's spec, as the referential knows it: a group or a code. */
function readTarget(referential: Referential, target: string): ReadValue {
  const { system, code } = splitQualified(target);
  const own = referential.codeSystem;
  if (system !== undefined && system !== own) {
    throw new SpecError(
      'INVALID_REFERENTIAL',
      own === undefined
        ? `${target} is qualified but referential ${referential.id} declares no code system`
        : `${target} is not of code system ${own} of referential ${referential.id}`,
    );
  }
  if (Object.hasOwn(referential.groups, code)) return { kind: 'group', name: code };
  const codes = referential.codes;
  if (codes !== undefined && !Object.hasOwn(codes, code)) {
    throw new SpecError(
      'INVALID_REFERENTIAL',
      `${target} is neither a group nor a code of referential ${referential.id}`,
    );
  }
  return { kind: 'code', code };
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
  ) {}

  /** `value` (already read) in the group or code `target`. */
  target(target: ReadValue, value: ReadValue): Membership {
    if (value.kind === 'unknown') return { result: 'unknown', why: value.why };
    if (target.kind === 'code') {
      return value.kind === 'code' && value.code === target.code
        ? { result: true, via: [] }
        : { result: false };
    }
    return target.kind === 'group' ? this.member(target.name, value) : { result: false };
  }

  /** `value` (already read) in `group`. */
  member(group: string, value: ReadValue): Membership {
    if (value.kind === 'unknown') return { result: 'unknown', why: value.why };
    if (value.kind === 'group' && value.name === group) return { result: true, via: [] };
    const name = value.kind === 'group' ? value.name : value.code;
    const memo = this.memo.get(name) ?? new Map<string, Membership>();
    this.memo.set(name, memo);
    return this.inGroup(group, name, 1, memo);
  }

  private inGroup(
    group: string,
    value: string,
    depth: number,
    memo: Map<string, Membership>,
  ): Membership {
    const known = memo.get(group);
    if (known !== undefined) return known;
    if (depth > DEFAULT_MAX_GROUP_DEPTH) {
      throw new SpecError(
        'INVALID_REFERENTIAL',
        `group nesting deeper than ${DEFAULT_MAX_GROUP_DEPTH}`,
      );
    }
    const groups = this.referential.groups;
    const entry = groups[group];
    const active = (entry?.members ?? []).filter((m) => this.isActive(m));
    let result: Membership;
    if (active.some((m) => m.value === value)) {
      result = { result: true, via: [group] };
    } else {
      const nested = [...new Set(active.map((m) => m.value))]
        .filter((name) => Object.hasOwn(groups, name))
        .sort();
      let unknown: Membership | undefined;
      let found: Membership | undefined;
      for (const name of nested) {
        const sub = this.inGroup(name, value, depth + 1, memo);
        if (sub.result === true) {
          found = { result: true, via: [group, ...sub.via] };
          break;
        }
        if (sub.result === 'unknown' && unknown === undefined) unknown = sub;
      }
      if (found !== undefined) result = found;
      else if (unknown !== undefined) result = unknown;
      else if (entry?.exhaustive === true) result = { result: false };
      else {
        result = {
          result: 'unknown',
          why: `${value} in ${group} is unknown: ${group} is not exhaustive`,
        };
      }
    }
    memo.set(group, result);
    return result;
  }

  private isActive(member: ReferentialMember): boolean {
    const { from, until } = member;
    return (from === undefined || from <= this.at) && (until == null || this.at < until);
  }
}
