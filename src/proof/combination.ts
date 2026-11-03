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
import type { Ties } from './ties.js';
import type { ProofSection, ProofSelection, ProofStep } from './types.js';
import { isLifted, LIFTS } from './lifts.js';
import type { OutputIdentity } from './lifts.js';
import {
  NativeBoolean,
  NativeMap,
  NativeSet,
  NativeString,
  arrayEvery,
  arrayFilter,
  arrayFind,
  arrayFlat,
  arrayIsArray,
  arrayMap,
  arrayPush,
  arraySome,
  mapGet,
  mapHas,
  mapSet,
  mapValues,
  mathSign,
  setAdd,
  setHas,
  setSize,
  stringStartsWith,
} from '../intrinsics.js';

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
  /** What a step feeding it carries: its output, and its item's subject for an item. */
  place: OutputIdentity;
}

/** What the combination of a target is checked against: the proof's imposed steps, standings. */
export interface Context {
  /** The steps a `shortCircuit` imposed (`imposedKey`). */
  imposed: ReadonlySet<string>;
  standings: Standings;
  /** The ties settled among exceptions that the proof shows (D-7, R15). */
  ties: Ties;
  /**
   * The sections whose redacted entries the checks cannot see (D-16): a check that a hidden
   * entry could satisfy is not made while its section has one (`proofView`).
   */
  hidden: ReadonlySet<ProofSection>;
}

/** The problem of a rule none of whose visible instances has rank 0 (`topOf`). */
const NO_FIRST = 'no instance at rank 0: ';

/** The strategies whose value is one contribution, named by `selected` (D-27). */
export const SELECTING: ReadonlySet<string> = new NativeSet(['max', 'min', 'highestPriority']);

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
        typeof a === 'number' && typeof b === 'number' ? mathSign(a - b) || 0 : undefined;
    case 'decimal':
      return (a, b) =>
        typeof a === 'string' &&
        typeof b === 'string' &&
        isCanonicalDecimal(a) &&
        isCanonicalDecimal(b)
          ? compareCanonicalDecimals(a, b)
          : undefined;
    case 'enum': {
      const rank = new NativeMap(arrayMap(values, (value, i) => [value, i]));
      return (a, b) => {
        const x = typeof a === 'string' ? mapGet(rank, a) : undefined;
        const y = typeof b === 'string' ? mapGet(rank, b) : undefined;
        return x === undefined || y === undefined ? undefined : mathSign(x - y);
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
  if (value === null || typeof value !== 'object') return `${typeof value}:${NativeString(value)}`;
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
  const values = arrayMap(steps, (step) => step.contribution);
  const unknown: Expected = { unknown: true };
  const settle = (value: JsonValue | undefined): Expected =>
    value === undefined ? unknown : { value };
  if (values.length === 0) return emptyValue(declaration);
  switch (declaration.combine) {
    case 'sum': {
      if (declaration.type === 'number') {
        const numbers = arrayFilter(values, (value): value is number => typeof value === 'number');
        if (numbers.length !== values.length) return unknown;
        const rounding =
          declaration.rounding?.at === 'contribution' ? undefined : declaration.rounding;
        return { value: sumNumbers(numbers, rounding) };
      }
      const decimals = arrayFilter(
        values,
        (value): value is string => typeof value === 'string' && isCanonicalDecimal(value),
      );
      if (decimals.length !== values.length) return unknown;
      return settle(finish(sumDecimals(decimals), declaration));
    }
    case 'count':
      if (!arrayEvery(values, (value) => typeof value === 'boolean')) return unknown;
      return { value: arrayFilter(values, (value) => value === true).length };
    case 'all':
    case 'any': {
      if (!arrayEvery(values, (value) => typeof value === 'boolean')) return unknown;
      const all = declaration.combine === 'all';
      return {
        value: all ? arrayEvery(values, (v) => v === true) : arraySome(values, (v) => v === true),
      };
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
      if (!arrayEvery(values, (value) => keyOf(value) === key)) return { disagree: true };
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
  const seen = new NativeSet<string>();
  const items: JsonValue[] = [];
  for (const value of values) {
    if (!arrayIsArray(value)) return { unknown: true };
    for (const item of value) {
      const key = keyOf(item);
      if (setHas(seen, key)) continue;
      setAdd(seen, key);
      arrayPush(items, item);
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
  const buckets = new NativeMap<string, ProofStep[]>();
  for (const id of target.contributors) if (!mapHas(buckets, id)) mapSet(buckets, id, []);
  const unnamed: ProofStep[] = [];
  for (const step of target.steps) arrayPush(mapGet(buckets, step.ruleId) ?? unnamed, step);
  return [...arrayFlat([...mapValues(buckets)]), ...unnamed];
}

/**
 * True when `contributors` are the rules of the steps; for a `highestPriority`, the rules at its
 * top (`top`), or, when the top cannot be told (a rule not listed), some of them.
 */
function contributorsMatch(target: Target, top: Top | undefined): boolean {
  const { contributors, steps, declaration } = target;
  const named = new NativeSet(contributors);
  if (setSize(named) !== contributors.length) return false;
  if (top !== undefined)
    return (
      setSize(named) === setSize(top.ids) && arrayEvery(contributors, (id) => setHas(top.ids, id))
    );
  const fed = new NativeSet(arrayMap(steps, (step) => step.ruleId));
  if (!arrayEvery(contributors, (id) => setHas(fed, id))) return false;
  if (declaration.combine !== 'highestPriority') return setSize(named) === setSize(fed);
  return (setSize(named) === 0) === (setSize(fed) === 0);
}

/** The standing of each contributor of `target`: that of the first step of its rule. */
function contributorStanding(target: Target, standings: Standings) {
  const first = new NativeMap<string, Standing | undefined>();
  for (const step of target.steps) {
    if (!mapHas(first, step.ruleId)) mapSet(first, step.ruleId, mapGet(standings, ruleKey(step)));
  }
  return (id: string): Standing | undefined => mapGet(first, id);
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
 *
 * While `rules`, `applied` or `exceptions` has a redacted entry (`context.hidden`), the visible
 * steps may be a part of the target's: only `steps beside a short circuit`, `contributors not in
 * contribution order` and the ties among the visible instances (`topOf`, but `no instance at
 * rank 0`) are checked.
 */
export function combinationProblems(target: Target, context: Context): string[] {
  const { declaration } = target;
  const cite = target.cite;
  const issues: string[] = [];
  const carrier = arrayFind(target.steps, (step) =>
    setHas(context.imposed, imposedKey(step, step.output)),
  );
  if (carrier !== undefined && target.steps.length > 1) {
    arrayPush(issues, `steps beside a short circuit: ${cite()}`);
  }
  const top =
    declaration.combine === 'highestPriority' && carrier === undefined
      ? topOf(target.steps, context.standings, target.whole, cite)
      : undefined;
  // A step, the short circuit that imposed one, or the standing of a rule may be redacted: what
  // follows from all of them is not checked, what the visible ones contradict still is.
  // A hidden step feeds this target: what it carries. A standing is read by a
  // `highestPriority` only.
  const standing = declaration.combine === 'highestPriority';
  const lifted = (message: string): boolean =>
    isLifted(context.hidden, LIFTS.outputValue, {
      message,
      output: target.place,
      ...(standing ? {} : { as: { rules: 'none' } }),
    });
  const differ = `contributors differ from applied steps: ${cite()}`;
  if (!contributorsMatch(target, top) && !lifted(differ)) arrayPush(issues, differ);
  if (!inStandingOrder(target.contributors, contributorStanding(target, context.standings))) {
    arrayPush(issues, `contributors not in contribution order: ${cite()}`);
  }
  if (top !== undefined) {
    append(
      issues,
      arrayFilter(
        top.problems,
        (problem) => !stringStartsWith(problem, NO_FIRST) || !lifted(problem),
      ),
    );
  }
  if (target.status === 'undetermined') return issues;
  const following = valueProblems(target, context, carrier, top);
  const hidden = following.length > 0 && arrayEvery(arrayMap(following, lifted), NativeBoolean);
  return hidden ? issues : [...issues, ...following];
}

/**
 * The value of a settled target against what its contributions give (`combine`), and the step
 * a selecting output takes it from.
 */
function valueProblems(
  target: Target,
  context: Context,
  carrier: ProofStep | undefined,
  top: Top | undefined,
): string[] {
  const { declaration, cite } = target;
  const issues: string[] = [];
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
  if (
    setHas(SELECTING, declaration.combine) &&
    has &&
    !('unknown' in expected && top !== undefined)
  ) {
    const from = selectedStep(declaration, fed, carrier);
    const { selected } = target;
    if (selected === undefined) arrayPush(issues, `selected missing: ${cite()}`);
    else if (from === undefined || !sameStep(selected, from)) {
      arrayPush(issues, `selected does not match the value: ${cite()}`);
    }
  }
  if (!followsFrom(expected, target.value))
    arrayPush(issues, `output value does not follow from its contributions: ${cite()}`);
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
    arrayMap(steps, (step) => step.contribution),
  );
  return index === undefined || steps.length === 0 ? undefined : steps[index];
}

function sameStep(selected: ProofSelection, step: ProofStep): boolean {
  return selected.ruleId === step.ruleId && selected.subject === step.subject;
}
