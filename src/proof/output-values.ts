import { citeName } from '../errors.js';
import { isCanonicalDecimal, isOnStep, numberToDecimal } from '../decision/decimal.js';
import { matchesValue } from '../decision/output.js';
import type { OutputDeclaration } from '../decision/output.js';
import type { JsonValue } from '../canonical.js';
import { extend } from './collect.js';
import type { ProofBounds, ProofOutput, ProofSection, ProofStep, ProofView } from './types.js';
import { isLifted, LIFTS } from './lifts.js';
import {
  NativeMap,
  NativeSet,
  arrayConcat,
  arrayEvery,
  arrayFlatMap,
  arrayPush,
  arraySome,
  mapGet,
  mapHas,
  mapSet,
  mapValuesArray,
  numberIsFinite,
  setAdd,
  setHas,
} from '../intrinsics.js';

/** The declaration a proof output carries, in its normal form (`validateProof` checked it). */
export function declarationOf(output: ProofOutput): OutputDeclaration {
  const { type, combine, values, rounding, unit, empty, per, dimension, sign } = output;
  const declaration: OutputDeclaration = { type, combine };
  if (values !== undefined) declaration.values = values;
  if (rounding !== undefined) declaration.rounding = rounding;
  if (unit !== undefined) declaration.unit = unit;
  if (empty !== undefined) declaration.empty = empty;
  if (per !== undefined) declaration.per = per;
  if (dimension !== undefined) declaration.dimension = dimension;
  if (sign !== undefined) declaration.sign = sign;
  return declaration;
}

/** The values an output or an item holds besides its contributions: its value, its bounds. */
function heldValues(entry: { value?: JsonValue; bounds?: ProofBounds }): JsonValue[] {
  const held: JsonValue[] = [];
  if (entry.value !== undefined) arrayPush(held, entry.value);
  if (entry.bounds?.min !== undefined) arrayPush(held, entry.bounds.min);
  if (entry.bounds?.max !== undefined) arrayPush(held, entry.bounds.max);
  return held;
}

/** What `offDeclarationValues` and `nonCanonicalDecimals` read: each output and what feeds it. */
interface Fed {
  output: ProofOutput;
  /** Its value and bounds, and those of its items. */
  held: JsonValue[];
  steps: ProofStep[];
}

/**
 * Each listed output (the first of a name), with what it holds and the applied steps feeding
 * it, in the order of `p.outputs`. `imposed` holds the steps whose contribution a
 * `shortCircuit` imposed: a value of the output, never a count's boolean.
 */
function fedOutputs(p: ProofView): Fed[] {
  const byName = new NativeMap<string, Fed>();
  for (let idx81 = 0, list81 = p.outputs; idx81 < list81.length; idx81++) {
    const output = list81[idx81] as (typeof list81)[number];
    if (!mapHas(byName, output.name)) mapSet(byName, output.name, { output, held: [], steps: [] });
  }
  for (let idx82 = 0, list82 = p.outputs; idx82 < list82.length; idx82++) {
    const output = list82[idx82] as (typeof list82)[number];
    const fed = mapGet(byName, output.name);
    if (fed !== undefined) extend(fed.held, heldValues(output));
  }
  for (let idx83 = 0, list83 = p.items; idx83 < list83.length; idx83++) {
    const item = list83[idx83] as (typeof list83)[number];
    // An item of an output without `per` is reported by `outputProblems`.
    const fed = mapGet(byName, item.output);
    if (fed?.output.per !== undefined) extend(fed.held, heldValues(item));
  }
  for (let idx84 = 0, list84 = p.applied; idx84 < list84.length; idx84++) {
    const step = list84[idx84] as (typeof list84)[number];
    const found = mapGet(byName, step.output);
    if (found !== undefined) arrayPush(found.steps, step);
  }
  return arrayConcat(mapValuesArray(byName));
}

/** The key of a rule instance: its qualified id, version and subject. */
export function instanceKey(entry: { ruleId: string; version: number; subject?: string }): string {
  const at = entry.subject === undefined ? '' : ` at ${entry.subject}`;
  return `${entry.ruleId}@${entry.version}${at}`;
}

/** The key of the step of a rule instance on `output`, as `imposedSteps` holds it. */
export function imposedKey(
  entry: { ruleId: string; version: number; subject?: string },
  output: string,
): string {
  return `${instanceKey(entry)}\u0000${output}`;
}

/**
 * The applied steps whose contribution a `shortCircuit` exception of their rule imposed: the
 * step of its carrier instance on the output it targets (`imposedKey`), not another step of it.
 */
export function imposedSteps(p: ProofView): Set<string> {
  const imposed = new NativeSet<string>();
  for (let idx85 = 0, list85 = p.exceptions; idx85 < list85.length; idx85++) {
    const exception = list85[idx85] as (typeof list85)[number];
    if (exception.kind === 'shortCircuit' && exception.output !== undefined) {
      setAdd(imposed, imposedKey(exception, exception.output));
    }
  }
  return imposed;
}

/**
 * Internal: each output whose values contradict the declaration the proof carries for it, by
 * output (in the order of `outputs`), each problem reported once per output:
 * - `output value does not match its declaration: name`: its value, a bound, or the value or a
 *   bound of one of its items is not a value of the declaration (`valueMatchesOutputType`: its
 *   type, an enum's `values`, `sign`, a `dimension` value, a count's non-negative integer). A
 *   `decimal` that is not canonical is reported by `nonCanonicalDecimals` instead;
 * - `output value not rounded as declared: name`: a rounded `number` or `decimal` value is not
 *   on the step (`scale` places, or a multiple of `increment`). A `number` `sum` rounded at each
 *   contribution is left to the combination check (`combinationProblems`);
 * - `contribution does not match its output declaration: name`: an applied contribution, or
 *   its `unrounded` value, is not a value of the output (a boolean for a `count`, unless a
 *   `shortCircuit` imposed it: then a value of the output; while `exceptions` has a redacted
 *   entry, `hidden`, any step of a `count` may be one a hidden short circuit imposed: either
 *   form is then accepted);
 * - `contribution not rounded as declared: name`: with `at: 'contribution'`, an applied
 *   contribution is not on the step.
 *
 * Linear in the size of the proof: each list is read once, and each value is checked against
 * its step in time linear in its digits (`isOnStep`).
 */
export function offDeclarationValues(
  p: ProofView,
  hidden: ReadonlySet<ProofSection> = new NativeSet(),
): string[] {
  const imposed = imposedSteps(p);
  const issues: string[] = [];
  for (let idx86 = 0, list86 = fedOutputs(p); idx86 < list86.length; idx86++) {
    const { output, held, steps } = list86[idx86] as (typeof list86)[number];
    const declaration = declarationOf(output);
    const cited = citeName(output.name);
    if (arraySome(held, (value) => !hasForm(value, declaration))) {
      arrayPush(issues, `output value does not match its declaration: ${cited}`);
    } else if (output.value !== undefined && !valueOnStep(output.value, declaration)) {
      arrayPush(issues, `output value not rounded as declared: ${cited}`);
    }
    const contributionForm = (step: ProofStep): boolean => {
      const asValue =
        setHas(imposed, imposedKey(step, step.output)) || declaration.combine !== 'count';
      const form = (value: JsonValue): boolean =>
        asValue
          ? hasForm(value, declaration)
          : typeof value === 'boolean' ||
            (hasForm(value, declaration) &&
              isLifted(hidden, LIFTS.countForm, {
                message: `contribution does not match its output declaration: ${cited}`,
                output: { output: output.name },
              }));
      return form(step.contribution) && (step.unrounded === undefined || form(step.unrounded));
    };
    if (arraySome(steps, (step) => !contributionForm(step))) {
      arrayPush(issues, `contribution does not match its output declaration: ${cited}`);
    } else if (
      declaration.rounding?.at === 'contribution' &&
      arraySome(steps, (step) => !onStep(step.contribution, declaration))
    ) {
      arrayPush(issues, `contribution not rounded as declared: ${cited}`);
    }
  }
  return issues;
}

/**
 * Internal: each `decimal` output (in the order of `outputs`) whose value or bounds, those of
 * its items, or the `contribution` or `unrounded` value of an applied rule feeding it, is not a
 * canonical decimal string (`isCanonicalDecimal`), reported once as
 * `decimal value not canonical: name`. A count of a decimal output does not exist.
 */
export function nonCanonicalDecimals(p: ProofView): string[] {
  const canonical = (value: JsonValue): boolean =>
    typeof value === 'string' && isCanonicalDecimal(value);
  const issues: string[] = [];
  for (let idx87 = 0, list87 = fedOutputs(p); idx87 < list87.length; idx87++) {
    const { output, held, steps } = list87[idx87] as (typeof list87)[number];
    if (output.type !== 'decimal') continue;
    const values = arrayConcat(
      held,
      arrayFlatMap(steps, (step) =>
        step.unrounded === undefined ? [step.contribution] : [step.contribution, step.unrounded],
      ),
    );
    if (!arrayEvery(values, canonical))
      arrayPush(issues, `decimal value not canonical: ${citeName(output.name)}`);
  }
  return issues;
}

/** True when `value` has the form of a value of `declaration`; a non-canonical decimal passes. */
function hasForm(value: JsonValue, declaration: OutputDeclaration): boolean {
  if (declaration.type === 'decimal' && declaration.combine !== 'count') {
    if (typeof value !== 'string' || !isCanonicalDecimal(value)) return true;
  }
  return matchesValue(value, declaration);
}

/**
 * The output value on the step of its rounding. A `number` sum rounded at each contribution is
 * left to the combination check: in 20 significant digits, its sum may leave the step.
 */
function valueOnStep(value: JsonValue, declaration: OutputDeclaration): boolean {
  const { type, combine, rounding } = declaration;
  if (type === 'number' && combine === 'sum' && rounding?.at === 'contribution') return true;
  return onStep(value, declaration);
}

/** True when `value` is on the step of the rounding of `declaration`, or nothing to check. */
function onStep(value: JsonValue, declaration: OutputDeclaration): boolean {
  const { rounding } = declaration;
  if (rounding === undefined) return true;
  if (typeof value === 'number' && numberIsFinite(value)) {
    return isOnStep(numberToDecimal(value), rounding);
  }
  // A decimal that is not canonical is reported by `nonCanonicalDecimals`.
  return typeof value !== 'string' || !isCanonicalDecimal(value) || isOnStep(value, rounding);
}
