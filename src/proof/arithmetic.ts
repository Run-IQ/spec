import {
  MAX_DECIMAL_DIGITS,
  MAX_ROUNDING_SCALE,
  boundedResult,
  decimalOfNumber,
  incrementProblem,
  numberToDecimal,
  requireDecimal,
  toCanonicalDecimal,
} from '../decision/decimal.js';
import { newSpecError, quoteText } from '../errors.js';
import { isPlainObject, own } from '../values.js';
import type { RoundingMode } from '../decision/rounding.js';
import {
  NativeBigInt,
  NativeFloat64Array,
  NativeNumber,
  NativeString,
  append,
  arrayJoin,
  arrayMap,
  arraySome,
  bigIntToString,
  float64ArrayLength,
  mathFloor,
  mathMax,
  mathMin,
  numberIsFinite,
  numberIsSafeInteger,
  objectKeys,
  stringIndexOf,
  stringPadEnd,
  stringPadStart,
  stringRepeat,
  stringReplace,
  stringSlice,
  stringStartsWith,
} from '../intrinsics.js';

// Internal to `@run-iq/spec`: the arithmetic `verifyProof` redoes to check that a combined value
// follows from its contributions, as the engine computes it (`@run-iq/core`'s
// `decimalArithmetic`): exact decimal sums, `number` sums in decimal to 20 significant digits
// (ties away from zero), and the seven rounding modes. Every function is linear in the digits
// of its operands: no division or product ever runs on a number as long as a value.

/** The rounding of a valid, normal declaration: `scale` places, or a multiple of `increment`. */
export interface Rounding {
  scale?: number;
  increment?: string;
  mode: RoundingMode;
}

/** Internal, for tests: the digits the functions below have gone through since the start. */
const work = { digits: 0 };

/** Internal, for tests: a copy of the work done so far. */
export function arithmeticWork(): { digits: number } {
  return { ...work };
}

/** The sign, integer digits and fraction digits of a canonical decimal. */
function partsOf(text: string): { negative: boolean; integer: string; fraction: string } {
  const negative = stringStartsWith(text, '-');
  const unsigned = negative ? stringSlice(text, 1) : text;
  const point = stringIndexOf(unsigned, '.');
  return point < 0
    ? { negative, integer: unsigned, fraction: '' }
    : {
        negative,
        integer: stringSlice(unsigned, 0, point),
        fraction: stringSlice(unsigned, point + 1),
      };
}

/** The remainder of the digits `digits` by `divisor`, 15 digits at a time. */
function remainder(digits: string, divisor: bigint): bigint {
  work.digits += digits.length;
  let rest = 0n;
  for (let i = 0; i < digits.length; i += 15) {
    const chunk = stringSlice(digits, i, i + 15);
    rest = (rest * 10n ** NativeBigInt(chunk.length) + NativeBigInt(chunk)) % divisor;
  }
  return rest;
}

/** `digits` (a non-negative integer, leading zeros allowed) plus 1. */
function increment(digits: string): string {
  let i = digits.length - 1;
  while (i >= 0 && digits[i] === '9') i--;
  if (i < 0) return `1${stringRepeat('0', digits.length)}`;
  return (
    stringSlice(digits, 0, i) +
    NativeString(NativeNumber(digits[i]) + 1) +
    stringRepeat('0', digits.length - i - 1)
  );
}

/** `digits` (a positive integer, leading zeros allowed) minus 1. */
function decrement(digits: string): string {
  let i = digits.length - 1;
  while (i >= 0 && digits[i] === '0') i--;
  return (
    stringSlice(digits, 0, i) +
    NativeString(NativeNumber(digits[i]) - 1) +
    stringRepeat('9', digits.length - i - 1)
  );
}

/**
 * `digits` (a non-negative integer) plus `delta`, whose magnitude has fewer digits than it; the
 * result is never negative. Only the last digits are computed; a carry or a borrow runs once.
 */
function adjust(digits: string, delta: bigint): string {
  const width = bigIntToString(delta < 0n ? -delta : delta).length + 1;
  const low = stringSlice(digits, -width);
  let high = stringSlice(digits, 0, digits.length - low.length);
  const base = 10n ** NativeBigInt(low.length);
  let sum = NativeBigInt(low === '' ? '0' : low) + delta;
  if (high === '') return bigIntToString(sum);
  if (sum >= base) {
    sum -= base;
    high = increment(high);
  } else if (sum < 0n) {
    sum += base;
    high = decrement(high);
  }
  return high + stringPadStart(bigIntToString(sum), low.length, '0');
}

/** The canonical decimal of `digits` (a non-negative integer) divided by 10^places. */
function placed(negative: boolean, digits: string, places: number): string {
  const padded = stringPadStart(digits, places + 1, '0');
  const point = padded.length - places;
  const text =
    places === 0 ? padded : `${stringSlice(padded, 0, point)}.${stringSlice(padded, point)}`;
  return toCanonicalDecimal(negative ? `-${text}` : text);
}

/** -1, 0 or 1 as the fraction `0.<digits>` is below, at or above one half. */
function compareToHalf(digits: string): -1 | 0 | 1 {
  if (digits === '') return -1;
  if (digits[0] !== '5') return (digits[0] ?? '0') < '5' ? -1 : 1;
  return digits.length === 1 ? 0 : 1;
}

/**
 * The canonical decimal `value` rounded as `rounding` says, exactly: to `scale` places, or to a
 * multiple of `increment`, in `mode` (`halfUp` and `halfDown` break a tie away from and toward
 * zero, `halfEven` toward an even multiple; `up` and `down` round away from and toward zero,
 * `ceiling` and `floor` toward +∞ and −∞).
 */
export function roundExact(value: string, rounding: Rounding): string {
  const step = rounding.increment ?? '1';
  const places =
    rounding.increment === undefined ? (rounding.scale ?? 0) : partsOf(step).fraction.length;
  const unit = NativeBigInt(stringReplace(step, '.', ''));
  const { negative, integer, fraction } = partsOf(value);
  // The value in units of 10^-places, and what lies below one unit.
  const scaled = integer + stringPadEnd(stringSlice(fraction, 0, places), places, '0');
  const below = stringSlice(fraction, places);
  work.digits += value.length;
  const doubled = remainder(scaled, 2n * unit);
  const rest = doubled % unit;
  if (rest === 0n && below === '') return value;
  const odd = doubled >= unit;
  // Where the dropped part `rest + 0.below` lies against half a step.
  const twice = 2n * rest;
  const half: -1 | 0 | 1 =
    twice > unit
      ? 1
      : twice === unit
        ? below === ''
          ? 0
          : 1
        : twice === unit - 1n
          ? compareToHalf(below)
          : -1;
  const away = awayFromZero(rounding.mode, negative, half, odd);
  return placed(negative, adjust(scaled, away ? unit - rest : -rest), places);
}

function awayFromZero(
  mode: RoundingMode,
  negative: boolean,
  half: -1 | 0 | 1,
  odd: boolean,
): boolean {
  switch (mode) {
    case 'up':
      return true;
    case 'down':
      return false;
    case 'ceiling':
      return !negative;
    case 'floor':
      return negative;
    case 'halfUp':
      return half >= 0;
    case 'halfDown':
      return half > 0;
    case 'halfEven':
      return half > 0 || (half === 0 && odd);
  }
}

/** The number `value` rounded in decimal from its shortest writing, never `-0`. */
export function roundNumber(value: number, rounding: Rounding): number {
  return NativeNumber(roundExact(numberToDecimal(value), rounding));
}

/** Digits per limb of `sumDecimals`: a limb never exceeds 10^7 times the number of terms. */
const LIMB = 7;
const LIMB_BASE = 10 ** LIMB;

/**
 * The exact sum of canonical decimals, canonical. Each digit is added once into limbs aligned on
 * the point, then carries run once: linear in the digits of the terms.
 */
export function sumDecimals(values: readonly string[]): string {
  const terms = arrayMap(values, partsOf);
  let lowest = 0;
  let highest = 0;
  for (let idx130 = 0, list130 = terms; idx130 < list130.length; idx130++) {
    const { integer, fraction } = list130[idx130] as (typeof list130)[number];
    lowest = mathMin(lowest, mathFloor(-fraction.length / LIMB));
    highest = mathMax(highest, mathFloor((integer.length - 1) / LIMB));
  }
  // One limb more for the carry of the sum of many terms, and one for its own carry.
  const limbs = new NativeFloat64Array(highest - lowest + 3);
  for (let idx131 = 0, list131 = terms; idx131 < list131.length; idx131++) {
    const { negative, integer, fraction } = list131[idx131] as (typeof list131)[number];
    const sign = negative ? -1 : 1;
    work.digits += integer.length + fraction.length;
    const add = (digit: string | undefined, position: number): void => {
      const limb = mathFloor(position / LIMB);
      const index = limb - lowest;
      limbs[index] =
        (limbs[index] ?? 0) + sign * NativeNumber(digit) * 10 ** (position - limb * LIMB);
    };
    for (let i = 0; i < integer.length; i++) add(integer[i], integer.length - 1 - i);
    for (let i = 0; i < fraction.length; i++) add(fraction[i], -1 - i);
  }
  let negative = !normalize(limbs);
  if (negative) {
    for (let i = 0; i < float64ArrayLength(limbs); i++) limbs[i] = -(limbs[i] ?? 0);
    normalize(limbs);
  }
  let integer = '';
  let fraction = '';
  for (let i = float64ArrayLength(limbs) - 1; i >= 0; i--) {
    const digits = stringPadStart(NativeString(limbs[i] ?? 0), LIMB, '0');
    if (i + lowest >= 0) integer += digits;
    else fraction += digits;
  }
  const text = `${integer === '' ? '0' : integer}${fraction === '' ? '' : `.${fraction}`}`;
  const canonical = toCanonicalDecimal(text);
  negative = negative && canonical !== '0';
  return negative ? `-${canonical}` : canonical;
}

/**
 * Runs the carries of signed limbs, low to high, leaving each in [0, 10^7). Returns false when
 * a borrow remains past the highest limb: the sum is negative.
 */
function normalize(limbs: Float64Array): boolean {
  let carry = 0;
  for (let i = 0; i < float64ArrayLength(limbs); i++) {
    const total = (limbs[i] ?? 0) + carry;
    const digit = ((total % LIMB_BASE) + LIMB_BASE) % LIMB_BASE;
    limbs[i] = digit;
    carry = (total - digit) / LIMB_BASE;
  }
  return carry >= 0;
}

/**
 * The sum of numbers in order, exact: each number is read as the decimal of its shortest writing
 * (`numberToDecimal`), the decimals are added exactly (`sumDecimals`), the output's rounding, if
 * any, is applied once to that sum, and the result is the number nearest to it, never `-0`.
 * `0.1 + 0.2` is `0.3`, `1e20 + 0.1 - 1e20` is `0.1`. Throws `SpecError` (`INVALID_NUMBER`) for
 * a value that is not a finite number and for a sum that is not (it overflows).
 */
export function sumNumbers(values: readonly number[], rounding: Rounding | undefined): number {
  const texts: string[] = [];
  for (let i = 0; i < values.length; i++) {
    append(texts, decimalOfNumber(values[i], 'sumNumbers', i + 1));
  }
  const exact = sumDecimals(texts);
  const sum = NativeNumber(rounding === undefined ? exact : roundExact(exact, rounding));
  if (!numberIsFinite(sum)) {
    throw newSpecError('INVALID_NUMBER', 'the sum of the numbers is not a finite number');
  }
  return sum === 0 ? 0 : sum;
}

// The exact decimal functions of the public API. Every argument is checked first (a canonical
// decimal, a valid rounding), every operand and result is bounded by `MAX_DECIMAL_DIGITS`, and
// nothing is ever rounded but by the rounding the caller gives.

const MODES: readonly RoundingMode[] = [
  'halfUp',
  'halfDown',
  'halfEven',
  'up',
  'down',
  'ceiling',
  'floor',
];

/** `rounding` as the argument `position` of `fn`: a valid rounding, read once, or `INVALID_ROUNDING`. */
function requireRounding(rounding: unknown, fn: string, position: number): Rounding {
  const fail = (why: string): never => {
    throw newSpecError(
      'INVALID_ROUNDING',
      `argument ${position} of ${fn} is not a rounding: ${why}`,
    );
  };
  if (!isPlainObject(rounding)) {
    return fail('expected { scale, mode } or { increment, mode }');
  }
  const keys = objectKeys(rounding);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    if (key !== 'scale' && key !== 'increment' && key !== 'mode') {
      return fail(`unknown field ${quoteText(key)}`);
    }
  }
  const scale: unknown = own(rounding, 'scale');
  const increment: unknown = own(rounding, 'increment');
  const mode: unknown = own(rounding, 'mode');
  if (!arraySome(MODES, (known) => known === mode)) {
    return fail(`mode must be one of ${arrayJoin(MODES, ', ')}`);
  }
  if ((scale === undefined) === (increment === undefined)) {
    return fail('give exactly one of scale and increment');
  }
  if (scale !== undefined) {
    if (
      typeof scale !== 'number' ||
      !numberIsSafeInteger(scale) ||
      scale < 0 ||
      scale > MAX_ROUNDING_SCALE
    ) {
      return fail(`scale must be an integer from 0 to ${MAX_ROUNDING_SCALE}`);
    }
    return { scale, mode: mode as RoundingMode };
  }
  const problem = incrementProblem(increment);
  if (problem !== undefined) return fail(`increment ${problem}`);
  return { increment: increment as string, mode: mode as RoundingMode };
}

/** `value` negated, canonical (`"0"` stays `"0"`). */
function negated(value: string): string {
  if (value === '0') return value;
  return stringStartsWith(value, '-') ? stringSlice(value, 1) : `-${value}`;
}

/** The exact sum of two canonical decimals. */
export function addDecimals(a: string, b: string): string {
  requireDecimal(a, 'addDecimals', 1);
  requireDecimal(b, 'addDecimals', 2);
  return boundedResult(sumDecimals([a, b]), 'addDecimals');
}

/** The exact difference of two canonical decimals. */
export function subtractDecimals(a: string, b: string): string {
  requireDecimal(a, 'subtractDecimals', 1);
  requireDecimal(b, 'subtractDecimals', 2);
  return boundedResult(sumDecimals([a, negated(b)]), 'subtractDecimals');
}

/** The integer of the digits of a canonical decimal without its point, and its places. */
function integerOf(value: string): { negative: boolean; digits: bigint; places: number } {
  const { negative, integer, fraction } = partsOf(value);
  return { negative, digits: NativeBigInt(integer + fraction), places: fraction.length };
}

/** The exact product of two canonical decimals. */
export function multiplyDecimals(a: string, b: string): string {
  requireDecimal(a, 'multiplyDecimals', 1);
  requireDecimal(b, 'multiplyDecimals', 2);
  const left = integerOf(a);
  const right = integerOf(b);
  const digits = left.digits * right.digits;
  const text = placed(
    left.negative !== right.negative,
    bigIntToString(digits),
    left.places + right.places,
  );
  return boundedResult(text, 'multiplyDecimals');
}

/** `value` rounded as `rounding` says: exactly, to `scale` places or to a multiple of `increment`. */
export function roundDecimal(value: string, rounding: Rounding): string {
  requireDecimal(value, 'roundDecimal', 1);
  const valid = requireRounding(rounding, 'roundDecimal', 2);
  return boundedResult(roundExact(value, valid), 'roundDecimal');
}

/**
 * `a / b` rounded once by `rounding` (required: a division never picks a precision itself). The
 * exact quotient is one integer division of scaled operands, with its remainder: the rounding
 * decides from the remainder, so no digit beyond the step is computed and nothing is rounded
 * twice. Throws `DIVISION_BY_ZERO` for a `b` of `"0"`.
 */
export function divideDecimals(a: string, b: string, rounding: Rounding): string {
  requireDecimal(a, 'divideDecimals', 1);
  requireDecimal(b, 'divideDecimals', 2);
  const step = requireRounding(rounding, 'divideDecimals', 3);
  if (b === '0') throw newSpecError('DIVISION_BY_ZERO', 'argument 2 of divideDecimals is zero');
  const left = integerOf(a);
  const right = integerOf(b);
  // The step is unit / 10^k: a / b rounded to a multiple of it is (a / (b * step)) rounded.
  const unit =
    step.increment === undefined ? 1n : NativeBigInt(stringReplace(step.increment, '.', ''));
  const k =
    step.increment === undefined ? (step.scale ?? 0) : partsOf(step.increment).fraction.length;
  const numeratorDigits = bigIntToString(left.digits).length + right.places + k;
  const denominatorDigits = bigIntToString(right.digits * unit).length + left.places;
  // The quotient has about numeratorDigits - denominatorDigits digits: refuse before computing.
  if (numeratorDigits - denominatorDigits > MAX_DECIMAL_DIGITS + 1) {
    throw newSpecError(
      'LIMIT_EXCEEDED',
      `the result of divideDecimals has more than ${MAX_DECIMAL_DIGITS} digits (MAX_DECIMAL_DIGITS)`,
    );
  }
  const numerator = left.digits * 10n ** NativeBigInt(right.places + k);
  const denominator = right.digits * unit * 10n ** NativeBigInt(left.places);
  const quotient = numerator / denominator;
  const rest = numerator % denominator;
  // The integer quotient, before the rounding, is bounded too.
  if (bigIntToString(quotient).length > MAX_DECIMAL_DIGITS) {
    throw newSpecError(
      'LIMIT_EXCEEDED',
      `the quotient of divideDecimals has more than ${MAX_DECIMAL_DIGITS} digits (MAX_DECIMAL_DIGITS)`,
    );
  }
  const negative = left.negative !== right.negative;
  let count = quotient;
  if (rest !== 0n) {
    const twice = 2n * rest;
    const half: -1 | 0 | 1 = twice < denominator ? -1 : twice === denominator ? 0 : 1;
    if (awayFromZero(step.mode, negative, half, quotient % 2n === 1n)) count += 1n;
  }
  const text = placed(negative && count !== 0n, bigIntToString(count * unit), k);
  return boundedResult(text, 'divideDecimals');
}
