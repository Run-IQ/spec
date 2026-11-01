import { canonicalSha256Hex } from '../canonical.js';
import type { JsonValue } from '../canonical.js';
import { compareCanonicalDecimals, isCanonicalDecimal } from '../decision/decimal.js';
import { matchesValue } from '../decision/output.js';
import type { OutputDeclaration } from '../decision/output.js';
import type { OutputStatus } from '../decision/status.js';
import { ownCopy } from '../values.js';
import { roundDecimal, roundNumber, sumDecimals, sumNumbers } from './arithmetic.js';
import type { Rounding } from './arithmetic.js';
import { append } from './collect.js';
import { topOf } from './highest.js';
import type { Top } from './highest.js';
import { imposedKey } from './output-values.js';
import { inStandingOrder, ruleKey } from './precedence.js';
import type { Standing, Standings } from './precedence.js';
import type { ProofSelection, ProofStep } from './types.js';

/** An output, or an item of an output `per` element, and the applied steps that feed it. */
export interface Target {
  /** How messages cite it: its name, or `name at subject` (written only for a message). */
  cite: () => string;
  declaration: OutputDeclaration;
  status: OutputStatus;
  value?: JsonValue;
  contributors: readonly string[];
  selected?: ProofSelection;
  /** In the order of `applied`. */
  steps: readonly ProofStep[];
  /** True for an output without `per`: the instances of a rule compete for it by rank. */
  whole: boolean;
}

/** What the combination of a target is checked against: the proof's imposed steps, standings. */
export interface Context {
  /** The steps a `shortCircuit` imposed (`imposedKey`). */
  imposed: ReadonlySet<string>;
  standings: Standings;
}

/** The strategies whose value is one contribution, named by `selected` (D-27). */
export const SELECTING: ReadonlySet<string> = new Set(['max', 'min', 'highestPriority']);

/**
 * What the contributions give: a value, no value, no value they can give (the contributors of a
 * `highestPriority` disagree), or nothing to compare (a contribution off its declaration).
 */
type Expected = { value: JsonValue } | { none: true } | { disagree: true } | { unknown: true };

/** The comparison of two values of an ordered output, or `undefined` when either is off form. */
export function comparator(
  declaration: OutputDeclaration,
): (a: JsonValue, b: JsonValue) => number | undefined {
  const { type, values = [] } = declaration;
  switch (type) {
    case 'number':
      return (a, b) =>
        typeof a === 'number' && typeof b === 'number' ? Math.sign(a - b) || 0 : undefined;
    case 'decimal':
      return (a, b) =>
        typeof a === 'string' &&
        typeof b === 'string' &&
        isCanonicalDecimal(a) &&
        isCanonicalDecimal(b)
          ? compareCanonicalDecimals(a, b)
          : undefined;
    case 'enum': {
      const rank = new Map(values.map((value, i) => [value, i]));
      return (a, b) => {
        const x = typeof a === 'string' ? rank.get(a) : undefined;
        const y = typeof b === 'string' ? rank.get(b) : undefined;
        return x === undefined || y === undefined ? undefined : Math.sign(x - y);
      };
    }
    case 'date':
    case 'dateTime':
      // Civil dates and canonical instants sort as their text.
      return (a, b) =>
        typeof a === 'string' && typeof b === 'string' ? (a < b ? -1 : a > b ? 1 : 0) : undefined;
    default:
      return () => undefined;
  }
}

/**
 * A key of a JSON value: two values are the same when their keys are. A scalar is keyed by its
 * type and text (`-0` is `0`, as in the canonical form); a list or an object by its canonical
 * digest.
 */
function keyOf(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return `${typeof value}:${String(value)}`;
  // A snapshot value, counted when it was read.
  return `#${ownCopy(() => canonicalSha256Hex(value))}`;
}

/** `value` rounded as the output's rounding at output says, or `undefined` when off form. */
function finish(value: JsonValue, declaration: OutputDeclaration): JsonValue | undefined {
  const { rounding } = declaration;
  if (rounding === undefined || rounding.at === 'contribution') return value;
  const exact: Rounding = rounding;
  if (declaration.type === 'number')
    return typeof value === 'number' ? roundNumber(value, exact) : undefined;
  if (declaration.type === 'decimal') {
    return typeof value === 'string' && isCanonicalDecimal(value)
      ? roundDecimal(value, exact)
      : undefined;
  }
  return value;
}

/** The value the steps (in contribution order) give under `declaration`. */
function combine(declaration: OutputDeclaration, steps: readonly ProofStep[]): Expected {
  const values = steps.map((step) => step.contribution);
  const unknown: Expected = { unknown: true };
  const settle = (value: JsonValue | undefined): Expected =>
    value === undefined ? unknown : { value };
  if (values.length === 0) return emptyValue(declaration);
  switch (declaration.combine) {
    case 'sum': {
      if (declaration.type === 'number') {
        const numbers = values.filter((value): value is number => typeof value === 'number');
        if (numbers.length !== values.length) return unknown;
        const rounding =
          declaration.rounding?.at === 'contribution' ? undefined : declaration.rounding;
        return { value: sumNumbers(numbers, rounding) };
      }
      const decimals = values.filter(
        (value): value is string => typeof value === 'string' && isCanonicalDecimal(value),
      );
      if (decimals.length !== values.length) return unknown;
      return settle(finish(sumDecimals(decimals), declaration));
    }
    case 'count':
      if (!values.every((value) => typeof value === 'boolean')) return unknown;
      return { value: values.filter((value) => value === true).length };
    case 'all':
    case 'any': {
      if (!values.every((value) => typeof value === 'boolean')) return unknown;
      const all = declaration.combine === 'all';
      return { value: all ? values.every((v) => v === true) : values.some((v) => v === true) };
    }
    case 'union':
      return unionOf(values);
    case 'max':
    case 'min': {
      const index = extremeIndex(declaration, values);
      return index === undefined ? unknown : settle(finish(values[index] ?? null, declaration));
    }
    case 'highestPriority': {
      const [head] = values;
      if (head === undefined) return unknown;
      const key = keyOf(head);
      if (!values.every((value) => keyOf(value) === key)) return { disagree: true };
      return settle(finish(head, declaration));
    }
  }
}

/** The value of an output no contribution reached (`emptyOutput`). */
function emptyValue(declaration: OutputDeclaration): Expected {
  switch (declaration.combine) {
    case 'sum':
      return { value: declaration.type === 'decimal' ? '0' : 0 };
    case 'count':
      return { value: 0 };
    case 'union':
      return { value: [] };
    case 'any':
      return { value: false };
    case 'all':
      return declaration.empty === true ? { value: true } : { none: true };
    case 'max':
    case 'min':
    case 'highestPriority':
      return { none: true };
  }
}

/** The items of the lists in order, the first of those with the same canonical form kept. */
function unionOf(values: readonly JsonValue[]): Expected {
  const seen = new Set<string>();
  const items: JsonValue[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) return { unknown: true };
    for (const item of value) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return { value: items };
}

/** The index of the first greatest (`max`) or least (`min`) value, `undefined` if off form. */
function extremeIndex(
  declaration: OutputDeclaration,
  values: readonly JsonValue[],
): number | undefined {
  const compare = comparator(declaration);
  const keep = declaration.combine === 'max' ? 1 : -1;
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    const order = compare(values[i] ?? null, values[best] ?? null);
    if (order === undefined) return undefined;
    if (order === keep) best = i;
  }
  return compare(values[best] ?? null, values[best] ?? null) === undefined ? undefined : best;
}

/**
 * The steps in contribution order: by the place of their rule in `contributors`, then in the
 * order of `applied`; those of a rule not named last. Linear: each step goes to the bucket of
 * its place, and the buckets are read in order.
 */
function inContributionOrder(target: Target): ProofStep[] {
  const buckets = new Map<string, ProofStep[]>();
  for (const id of target.contributors) if (!buckets.has(id)) buckets.set(id, []);
  const unnamed: ProofStep[] = [];
  for (const step of target.steps) (buckets.get(step.ruleId) ?? unnamed).push(step);
  return [...[...buckets.values()].flat(), ...unnamed];
}

/**
 * True when `contributors` are the rules of the steps; for a `highestPriority`, the rules at its
 * top (`top`), or, when the top cannot be told (a rule not listed), some of them.
 */
function contributorsMatch(target: Target, top: Top | undefined): boolean {
  const { contributors, steps, declaration } = target;
  const named = new Set(contributors);
  if (named.size !== contributors.length) return false;
  if (top !== undefined)
    return named.size === top.ids.size && contributors.every((id) => top.ids.has(id));
  const fed = new Set(steps.map((step) => step.ruleId));
  if (!contributors.every((id) => fed.has(id))) return false;
  if (declaration.combine !== 'highestPriority') return named.size === fed.size;
  return (named.size === 0) === (fed.size === 0);
}

/** The standing of each contributor of `target`: that of the first step of its rule. */
function contributorStanding(target: Target, standings: Standings) {
  const first = new Map<string, Standing | undefined>();
  for (const step of target.steps) {
    if (!first.has(step.ruleId)) first.set(step.ruleId, standings.get(ruleKey(step)));
  }
  return (id: string): Standing | undefined => first.get(id);
}

/**
 * Internal: where the value of `target` does not follow from its applied contributions, in this
 * order: `contributors differ from applied steps` (the rules named are not those of the steps:
 * for `highestPriority`, some of them, at least one when any), then, for a settled target,
 * `settled output has no value`, `all output without contribution must be undetermined`,
 * `selected missing`, `selected does not match the value` (it names another step than the one
 * the value was taken from: the first greatest or least in contribution order, the first
 * contributor of a `highestPriority`, a `shortCircuit`'s carrier) and
 * `output value does not follow from its contributions` (the value is not the combination of
 * the contributions: a sum in decimal, exact or to 20 significant digits for a `number`, in
 * contribution order, then rounded at output; a count of `true`; `all`, `any`; a union keeping
 * the first of equal items; an extreme; the agreeing value of a `highestPriority`; the value a
 * `shortCircuit` imposed; the value of an output no rule reached, or none).
 *
 * The contribution order is that of `contributors`, then that of `applied`. Contributions off
 * their declaration are reported by `offDeclarationValues`, and not combined.
 */
export function combinationProblems(target: Target, context: Context): string[] {
  const { declaration } = target;
  const cite = target.cite;
  const issues: string[] = [];
  const carrier = target.steps.find((step) => context.imposed.has(imposedKey(step, step.output)));
  if (carrier !== undefined && target.steps.length > 1) {
    issues.push(`steps beside a short circuit: ${cite()}`);
  }
  const top =
    declaration.combine === 'highestPriority' && carrier === undefined
      ? topOf(target.steps, context.standings, target.whole, cite)
      : undefined;
  if (!contributorsMatch(target, top))
    issues.push(`contributors differ from applied steps: ${cite()}`);
  if (!inStandingOrder(target.contributors, contributorStanding(target, context.standings))) {
    issues.push(`contributors not in contribution order: ${cite()}`);
  }
  if (top !== undefined) append(issues, top.problems);
  if (target.status === 'undetermined') return issues;
  const fed =
    carrier !== undefined
      ? [carrier]
      : top !== undefined
        ? top.winners
        : inContributionOrder(target);
  const expected: Expected =
    carrier !== undefined
      ? imposedValue(declaration, carrier)
      : top !== undefined && top.problems.length > 0
        ? { unknown: true }
        : combine(declaration, fed);
  const has = target.value !== undefined;
  // A value off its declaration is reported by `offDeclarationValues`, and not compared.
  if (target.value !== undefined && !matchesValue(target.value, declaration)) return issues;
  if ('value' in expected && !has) return [...issues, `settled output has no value: ${cite()}`];
  if ('none' in expected && declaration.combine === 'all') {
    return [...issues, `all output without contribution must be undetermined: ${cite()}`];
  }
  if (SELECTING.has(declaration.combine) && has && !('unknown' in expected && top !== undefined)) {
    const from = selectedStep(declaration, fed, carrier);
    const { selected } = target;
    if (selected === undefined) issues.push(`selected missing: ${cite()}`);
    else if (from === undefined || !sameStep(selected, from)) {
      issues.push(`selected does not match the value: ${cite()}`);
    }
  }
  if (!followsFrom(expected, target.value))
    issues.push(`output value does not follow from its contributions: ${cite()}`);
  return issues;
}

/** True when `value` (absent: none) is what the contributions give, or they cannot tell. */
function followsFrom(expected: Expected, value: JsonValue | undefined): boolean {
  if ('unknown' in expected) return true;
  if ('disagree' in expected) return false;
  if ('none' in expected) return value === undefined;
  return value !== undefined && keyOf(value) === keyOf(expected.value);
}

/** The value a `shortCircuit` carrier imposed: its contribution, rounded at output. */
function imposedValue(declaration: OutputDeclaration, carrier: ProofStep): Expected {
  const value = finish(carrier.contribution, declaration);
  return value === undefined ? { unknown: true } : { value };
}

/** The step a selecting output takes its value from, `undefined` when there is none. */
function selectedStep(
  declaration: OutputDeclaration,
  steps: readonly ProofStep[],
  carrier: ProofStep | undefined,
): ProofStep | undefined {
  if (carrier !== undefined || declaration.combine === 'highestPriority') return steps[0];
  const index = extremeIndex(
    declaration,
    steps.map((step) => step.contribution),
  );
  return index === undefined || steps.length === 0 ? undefined : steps[index];
}

function sameStep(selected: ProofSelection, step: ProofStep): boolean {
  return selected.ruleId === step.ruleId && selected.subject === step.subject;
}
