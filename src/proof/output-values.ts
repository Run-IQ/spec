import { citeName } from '../errors.js';
import { isCanonicalDecimal, isOnStep, numberToDecimal } from '../decision/decimal.js';
import { isOutputText } from '../decision/output.js';
import { isCivilDate, isInstant } from '../time/civil.js';
import type { JsonValue } from '../canonical.js';
import type { ProofOutput, ProofStep, UnsignedProof } from './types.js';

/** The strategies whose output has no value when no contribution reached it (`emptyOutput`). */
const WITHOUT_VALUE: ReadonlySet<string> = new Set(['max', 'min', 'highestPriority', 'all']);

/**
 * Internal: each output whose values contradict the declaration the proof carries for it
 * (`type`, `combine`, `rounding`), by sorted name, each problem reported once per output:
 * - `output value does not match its declaration: name`: the value is not of its type (a
 *   number, a boolean, a string for a string or an enum, an array, an object, a civil date, a
 *   canonical instant; a non-negative safe integer for a `count`). `null` stands for no value
 *   only when no rule contributed and the strategy has none then (`max`, `min`,
 *   `highestPriority`, `all`). A `decimal` is checked by `nonCanonicalDecimals`;
 * - `output value not rounded as declared: name`: a rounded `number` or `decimal` value is not
 *   on the step (`scale` places, or a multiple of `increment`). A `number` `sum` rounded at
 *   each contribution is not checked: the binary sum of rounded numbers is not on the step;
 * - `contribution does not match its output declaration: name`: an applied contribution, or
 *   its `unrounded` value, is not of the output's type (a boolean for a `count`);
 * - `contribution not rounded as declared: name`: with `at: 'contribution'`, an applied
 *   contribution is not on the step.
 *
 * What the proof does not carry yet is not checked here (Task 9J adds it to `ProofOutput`):
 * an enum's `values` (an enum value is only checked to be a string), `sign`, `unit`, `empty`
 * (an `all` without contribution may hold `true` or `null`), `per` and `dimension` (a string
 * value is checked to hold no lone surrogate, not to be a dimension value).
 *
 * Linear in the size of the proof: the applied list is read once, and each value is checked
 * against its step in time linear in its digits (`isOnStep`).
 */
export function offDeclarationValues(p: UnsignedProof): string[] {
  const steps = new Map<string, ProofStep[]>();
  for (const step of p.applied) {
    const list = steps.get(step.output);
    if (list === undefined) steps.set(step.output, [step]);
    else list.push(step);
  }
  const issues: string[] = [];
  for (const name of Object.keys(p.outputs).sort()) {
    const output = p.outputs[name];
    if (output === undefined) continue;
    const cited = citeName(name);
    const noValue =
      output.value === null &&
      output.contributors.length === 0 &&
      WITHOUT_VALUE.has(output.combine);
    if (!noValue && !hasForm(output.value, output)) {
      issues.push(`output value does not match its declaration: ${cited}`);
    } else if (!noValue && !valueOnStep(output.value, output)) {
      issues.push(`output value not rounded as declared: ${cited}`);
    }
    const fed = steps.get(name) ?? [];
    if (fed.some((step) => !contributionHasForm(step, output))) {
      issues.push(`contribution does not match its output declaration: ${cited}`);
    } else if (
      output.rounding?.at === 'contribution' &&
      fed.some((step) => !onStep(step.contribution, output))
    ) {
      issues.push(`contribution not rounded as declared: ${cited}`);
    }
  }
  return issues;
}

/**
 * True when `value` has the form of a value of `output` (a decimal is checked elsewhere; a
 * string with a lone surrogate, which `validateProof` refuses first, is refused here too).
 */
function hasForm(value: JsonValue, output: ProofOutput): boolean {
  if (output.combine === 'count') {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }
  switch (output.type) {
    case 'number':
      return typeof value === 'number';
    case 'decimal':
      return true;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      // The proof does not carry `dimension` yet (Task 9J): checked as a plain string.
      return typeof value === 'string' && isOutputText(value, undefined);
    case 'enum':
      return typeof value === 'string';
    case 'list':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'date':
      return isCivilDate(value);
    case 'dateTime':
      return isInstant(value);
  }
}

function contributionHasForm(step: ProofStep, output: ProofOutput): boolean {
  if (output.combine === 'count') return typeof step.contribution === 'boolean';
  const { unrounded } = step;
  return (
    hasForm(step.contribution, output) && (unrounded === undefined || hasForm(unrounded, output))
  );
}

/**
 * The output value on the step of its rounding. A `number` sum rounded at each contribution is
 * not checked: the binary sum of numbers on the step leaves it (`0.1 + 0.2`). Any other value
 * rounded at each contribution is one of them (`max`, `min`, `highestPriority`) or an exact
 * decimal sum, so it is on the step.
 */
function valueOnStep(value: JsonValue, output: ProofOutput): boolean {
  const { type, combine, rounding } = output;
  if (type === 'number' && combine === 'sum' && rounding?.at === 'contribution') return true;
  return onStep(value, output);
}

/** True when `value` is on the step of the rounding of `output`, or there is none to check. */
function onStep(value: JsonValue, output: ProofOutput): boolean {
  const { rounding } = output;
  if (rounding === undefined) return true;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return isOnStep(numberToDecimal(value), rounding);
  }
  // A decimal that is not canonical is reported by `nonCanonicalDecimals`.
  return typeof value !== 'string' || !isCanonicalDecimal(value) || isOnStep(value, rounding);
}
