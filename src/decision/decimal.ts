import { newSpecError, quoteText } from '../errors.js';
import {
  NativeBigInt,
  NativeNumber,
  NativeString,
  arrayIsArray,
  bigIntToString,
  regExpExec,
  regExpTest,
  stringCharCodeAt,
  stringIndexOf,
  stringRepeat,
  stringReplace,
  stringSlice,
  stringSplit,
  stringStartsWith,
} from '../intrinsics.js';

/** A canonical decimal: no leading zero, no trailing fractional zero, no exponent. */
const CANONICAL = /^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;
/** Any decimal `toCanonicalDecimal` accepts: an optional `-`, digits, an optional fraction. */
const DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;
const ZERO = 0x30;

/**
 * True when `text` is a decimal in canonical form, the form a `decimal` output holds: an
 * optional `-`, an integer part without leading zero, and a fractional part without trailing
 * zero, if any (`"12.5"`, `"0"`, `"-3"`). `"-0"`, `"12.50"`, `"012"`, `"1e3"`, `".5"`, `"+1"`
 * and any value that is not a string are not. Any number of digits is allowed.
 */
export function isCanonicalDecimal(text: string): boolean {
  return typeof text === 'string' && text !== '-0' && regExpTest(CANONICAL, text);
}

/**
 * The canonical form of a decimal written in text: leading zeros of the integer part and
 * trailing zeros of the fractional part are removed, and a zero loses its sign
 * (`"0012.50"` gives `"12.5"`, `"-0.0"` gives `"0"`). The conversion is textual and exact, for
 * any number of digits; it is idempotent.
 *
 * Throws `SpecError` (`INVALID_DECIMAL`) when `text` is not a string made of an optional `-`,
 * ASCII digits, and an optional `.` followed by digits: an exponent, a `+`, spaces, a
 * separator, `".5"` or `"5."` are refused rather than guessed.
 */
export function toCanonicalDecimal(text: string): string {
  if (typeof text !== 'string') {
    throw newSpecError('INVALID_DECIMAL', `Not a decimal: ${describe(text)} (expected a string)`);
  }
  const parts = regExpExec(DECIMAL, text);
  if (!parts) {
    throw newSpecError(
      'INVALID_DECIMAL',
      `Not a decimal: ${quoteText(text)} (expected an optional "-", digits, and an ` +
        'optional "." followed by digits; no exponent, no spaces)',
    );
  }
  const [, sign = '', digits = '', fraction = ''] = parts;
  const integer = stringReplace(digits, /^0+(?=[0-9])/, '');
  let end = fraction.length;
  while (end > 0 && stringCharCodeAt(fraction, end - 1) === ZERO) end--;
  const decimals = stringSlice(fraction, 0, end);
  const magnitude = decimals === '' ? integer : `${integer}.${decimals}`;
  return magnitude === '0' ? '0' : `${sign}${magnitude}`;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (isArray(value)) return 'an array';
  const type = typeof value;
  return type === 'undefined'
    ? 'undefined'
    : `${regExpTest(/^[aeiou]/, type) ? 'an' : 'a'} ${type}`;
}

/** `Array.isArray`, false when it throws (a revoked Proxy). */
function isArray(value: unknown): boolean {
  try {
    return arrayIsArray(value);
  } catch {
    return false;
  }
}

/** Internal: the largest rounding scale, and the finest increment's number of decimal places. */
export const MAX_ROUNDING_SCALE = 20;

/**
 * Internal: what is wrong with `value` as a rounding increment, the text that follows its name
 * in a message, or `undefined` for a valid one. An increment is a decimal string greater than 0,
 * in canonical form (`isCanonicalDecimal`), with at most `MAX_ROUNDING_SCALE` decimal places:
 * `"0.05"`, `"10"`. Checked in this order: a decimal string at all, greater than 0, canonical,
 * not finer than 10^-20.
 */
/**
 * Internal: the most digits an increment has before its point, as after it
 * (`MAX_ROUNDING_SCALE`): an increment lies from 10^-20 to below 10^20, so checking a value
 * against it works on numbers of at most 40 digits.
 */
export const MAX_INCREMENT_DIGITS = 20;

export function incrementProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || !regExpTest(DECIMAL, value)) {
    return 'must be a decimal string ("0.05", "10")';
  }
  const canonical = toCanonicalDecimal(value);
  if (canonical === '0' || stringStartsWith(canonical, '-')) return 'must be greater than 0';
  if (canonical !== value) return `must be written ${quoteText(canonical)}`;
  if (decimalPlaces(canonical) > MAX_ROUNDING_SCALE) {
    return `must have at most ${MAX_ROUNDING_SCALE} decimal places`;
  }
  const [integer = ''] = stringSplit(canonical, '.');
  if (integer.length > MAX_INCREMENT_DIGITS) {
    return `must have at most ${MAX_INCREMENT_DIGITS} digits before the point`;
  }
  return undefined;
}

/**
 * Internal: the scale an increment means when it is a power of ten from `1` (scale 0) to
 * `0.00000000000000000001` (scale 20): rounding to 10^-n is rounding to n places. `undefined`
 * for any other increment (`"0.05"`, `"10"`). `increment` is a valid increment.
 */
export function scaleOfIncrement(increment: string): number | undefined {
  if (increment === '1') return 0;
  return regExpTest(/^0\.0*1$/, increment) ? decimalPlaces(increment) : undefined;
}

/**
 * Internal: -1, 0 or 1 as the canonical decimal `a` is less than, equal to or greater than the
 * canonical decimal `b`, exactly, for any number of digits (`"9"` before `"10"`).
 */
export function compareCanonicalDecimals(a: string, b: string): -1 | 0 | 1 {
  const negative = stringStartsWith(a, '-');
  if (negative !== stringStartsWith(b, '-')) return negative ? -1 : 1;
  const order = compareMagnitudes(
    negative ? stringSlice(a, 1) : a,
    negative ? stringSlice(b, 1) : b,
  );
  if (!negative || order === 0) return order;
  return order < 0 ? 1 : -1;
}

/** -1, 0 or 1 comparing two canonical decimals without sign. */
function compareMagnitudes(a: string, b: string): -1 | 0 | 1 {
  const [aInteger = '', aFraction = ''] = stringSplit(a, '.');
  const [bInteger = '', bFraction = ''] = stringSplit(b, '.');
  // Without leading zeros, the longer integer part is the greater.
  if (aInteger.length !== bInteger.length) return aInteger.length < bInteger.length ? -1 : 1;
  if (aInteger !== bInteger) return aInteger < bInteger ? -1 : 1;
  // Fractions compare digit by digit; a missing digit is a zero, and no fraction ends in one.
  if (aFraction === bFraction) return 0;
  return aFraction < bFraction ? -1 : 1;
}

/** The number of digits after the point of a decimal written in text. */
function decimalPlaces(text: string): number {
  const point = stringIndexOf(text, '.');
  return point < 0 ? 0 : text.length - point - 1;
}

/**
 * Internal: the shortest decimal text that reads back as the finite number `n`, without
 * exponent, canonical (`1e-7` gives `"0.0000001"`, `1e21` gives `"1000000000000000000000"`,
 * `-0` gives `"0"`): the decimal a binary number stands for when it is rounded to a step.
 */
export function numberToDecimal(n: number): string {
  const text = NativeString(n);
  const match = regExpExec(/^(-?)([0-9]+)(?:\.([0-9]+))?e([+-][0-9]+)$/, text);
  if (match === null) return toCanonicalDecimal(text);
  const [, sign = '', integer = '', fraction = '', exponent = '0'] = match;
  const digits = integer + fraction;
  const point = integer.length + NativeNumber(exponent);
  const plain =
    point <= 0
      ? `0.${stringRepeat('0', -point)}${digits}`
      : point >= digits.length
        ? digits + stringRepeat('0', point - digits.length)
        : `${stringSlice(digits, 0, point)}.${stringSlice(digits, point)}`;
  return toCanonicalDecimal(sign + plain);
}

/**
 * Internal, for tests: the work of `isOnStep` since the start: its steps (one per 15 digits of
 * the value) and the digits of the numbers each step divides, summed.
 */
const stepWork = { steps: 0, digits: 0 };

/** Internal, for tests: a copy of the work of `isOnStep` as it stands. */
export function stepWorkDone(): { steps: number; digits: number } {
  return { ...stepWork };
}

/**
 * Internal: true when the canonical decimal `value` is a multiple of the step of a valid
 * rounding: at most `scale` decimal places, or a whole multiple of `increment`. Exact, for any
 * number of digits. The work is linear in the digits of `value`: a valid increment has at most
 * 40 digits (`MAX_INCREMENT_DIGITS` before its point, `MAX_ROUNDING_SCALE` after), so each step
 * divides a number of at most 55 digits (the remainder, below the increment, and 15 new digits).
 */
export function isOnStep(value: string, step: { scale?: number; increment?: string }): boolean {
  const places = decimalPlaces(value);
  if (step.increment === undefined) return places <= (step.scale ?? 0);
  const k = decimalPlaces(step.increment);
  // A multiple of the increment has at most its decimal places (`value` ends in no zero).
  if (places > k) return false;
  const digits =
    stringReplace(stringReplace(value, '-', ''), '.', '') + stringRepeat('0', k - places);
  const divisor = NativeBigInt(stringReplace(step.increment, '.', ''));
  // The remainder, 15 digits at a time: never a number as long as `value`.
  let remainder = 0n;
  for (let i = 0; i < digits.length; i += 15) {
    const chunk = stringSlice(digits, i, i + 15);
    const dividend = remainder * 10n ** NativeBigInt(chunk.length) + NativeBigInt(chunk);
    stepWork.steps += 1;
    stepWork.digits += bigIntToString(dividend).length;
    remainder = dividend % divisor;
  }
  return remainder === 0n;
}
