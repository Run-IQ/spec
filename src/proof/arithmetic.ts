import { numberToDecimal, toCanonicalDecimal } from '../decision/decimal.js';
import type { RoundingMode } from '../decision/rounding.js';

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
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const point = unsigned.indexOf('.');
  return point < 0
    ? { negative, integer: unsigned, fraction: '' }
    : { negative, integer: unsigned.slice(0, point), fraction: unsigned.slice(point + 1) };
}

/** The remainder of the digits `digits` by `divisor`, 15 digits at a time. */
function remainder(digits: string, divisor: bigint): bigint {
  work.digits += digits.length;
  let rest = 0n;
  for (let i = 0; i < digits.length; i += 15) {
    const chunk = digits.slice(i, i + 15);
    rest = (rest * 10n ** BigInt(chunk.length) + BigInt(chunk)) % divisor;
  }
  return rest;
}

/** `digits` (a non-negative integer, leading zeros allowed) plus 1. */
function increment(digits: string): string {
  let i = digits.length - 1;
  while (i >= 0 && digits[i] === '9') i--;
  if (i < 0) return `1${'0'.repeat(digits.length)}`;
  return digits.slice(0, i) + String(Number(digits[i]) + 1) + '0'.repeat(digits.length - i - 1);
}

/** `digits` (a positive integer, leading zeros allowed) minus 1. */
function decrement(digits: string): string {
  let i = digits.length - 1;
  while (i >= 0 && digits[i] === '0') i--;
  return digits.slice(0, i) + String(Number(digits[i]) - 1) + '9'.repeat(digits.length - i - 1);
}

/**
 * `digits` (a non-negative integer) plus `delta`, whose magnitude has fewer digits than it; the
 * result is never negative. Only the last digits are computed; a carry or a borrow runs once.
 */
function adjust(digits: string, delta: bigint): string {
  const width = (delta < 0n ? -delta : delta).toString().length + 1;
  const low = digits.slice(-width);
  let high = digits.slice(0, digits.length - low.length);
  const base = 10n ** BigInt(low.length);
  let sum = BigInt(low === '' ? '0' : low) + delta;
  if (high === '') return sum.toString();
  if (sum >= base) {
    sum -= base;
    high = increment(high);
  } else if (sum < 0n) {
    sum += base;
    high = decrement(high);
  }
  return high + sum.toString().padStart(low.length, '0');
}

/** The canonical decimal of `digits` (a non-negative integer) divided by 10^places. */
function placed(negative: boolean, digits: string, places: number): string {
  const padded = digits.padStart(places + 1, '0');
  const point = padded.length - places;
  const text = places === 0 ? padded : `${padded.slice(0, point)}.${padded.slice(point)}`;
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
export function roundDecimal(value: string, rounding: Rounding): string {
  const step = rounding.increment ?? '1';
  const places =
    rounding.increment === undefined ? (rounding.scale ?? 0) : partsOf(step).fraction.length;
  const unit = BigInt(step.replace('.', ''));
  const { negative, integer, fraction } = partsOf(value);
  // The value in units of 10^-places, and what lies below one unit.
  const scaled = integer + fraction.slice(0, places).padEnd(places, '0');
  const below = fraction.slice(places);
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
  return Number(roundDecimal(numberToDecimal(value), rounding));
}

/** Digits per limb of `sumDecimals`: a limb never exceeds 10^7 times the number of terms. */
const LIMB = 7;
const LIMB_BASE = 10 ** LIMB;

/**
 * The exact sum of canonical decimals, canonical. Each digit is added once into limbs aligned on
 * the point, then carries run once: linear in the digits of the terms.
 */
export function sumDecimals(values: readonly string[]): string {
  const terms = values.map(partsOf);
  let lowest = 0;
  let highest = 0;
  for (const { integer, fraction } of terms) {
    lowest = Math.min(lowest, Math.floor(-fraction.length / LIMB));
    highest = Math.max(highest, Math.floor((integer.length - 1) / LIMB));
  }
  // One limb more for the carry of the sum of many terms, and one for its own carry.
  const limbs = new Float64Array(highest - lowest + 3);
  for (const { negative, integer, fraction } of terms) {
    const sign = negative ? -1 : 1;
    work.digits += integer.length + fraction.length;
    const add = (digit: string | undefined, position: number): void => {
      const limb = Math.floor(position / LIMB);
      const index = limb - lowest;
      limbs[index] = (limbs[index] ?? 0) + sign * Number(digit) * 10 ** (position - limb * LIMB);
    };
    for (let i = 0; i < integer.length; i++) add(integer[i], integer.length - 1 - i);
    for (let i = 0; i < fraction.length; i++) add(fraction[i], -1 - i);
  }
  let negative = !normalize(limbs);
  if (negative) {
    for (let i = 0; i < limbs.length; i++) limbs[i] = -(limbs[i] ?? 0);
    normalize(limbs);
  }
  let integer = '';
  let fraction = '';
  for (let i = limbs.length - 1; i >= 0; i--) {
    const digits = String(limbs[i] ?? 0).padStart(LIMB, '0');
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
  for (let i = 0; i < limbs.length; i++) {
    const total = (limbs[i] ?? 0) + carry;
    const digit = ((total % LIMB_BASE) + LIMB_BASE) % LIMB_BASE;
    limbs[i] = digit;
    carry = (total - digit) / LIMB_BASE;
  }
  return carry >= 0;
}

/** A decimal as `coefficient × 10^exponent`. */
interface Scaled {
  coefficient: bigint;
  exponent: number;
}

/** Significant digits of a `number` sum (`@run-iq/core`'s `floatSum`). */
const SUM_DIGITS = 20;

function scaledOf(value: number): Scaled {
  const { negative, integer, fraction } = partsOf(numberToDecimal(value));
  const digits = BigInt(integer + fraction);
  return { coefficient: negative ? -digits : digits, exponent: -fraction.length };
}

/**
 * `a + b`, rounded to 20 significant digits, a tie away from zero: one step of core's
 * `floatSum` (`core/src/engine/decimalArithmetic.ts`: `Float`, decimal.js `precision: 20` and
 * `ROUND_HALF_UP`, which rounds a tie away from zero). `1e20 + 5` is `100000000000000000010`.
 */
function addRounded(a: Scaled, b: Scaled): Scaled {
  const exponent = Math.min(a.exponent, b.exponent);
  const sum =
    a.coefficient * 10n ** BigInt(a.exponent - exponent) +
    b.coefficient * 10n ** BigInt(b.exponent - exponent);
  const magnitude = sum < 0n ? -sum : sum;
  const drop = magnitude.toString().length - SUM_DIGITS;
  if (drop <= 0) return { coefficient: sum, exponent };
  const divisor = 10n ** BigInt(drop);
  let kept = magnitude / divisor;
  if (2n * (magnitude % divisor) >= divisor) kept += 1n;
  return { coefficient: sum < 0n ? -kept : kept, exponent: exponent + drop };
}

/** The canonical decimal of a scaled value. */
function textOf({ coefficient, exponent }: Scaled): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString();
  if (exponent >= 0)
    return toCanonicalDecimal(`${negative ? '-' : ''}${digits}${'0'.repeat(exponent)}`);
  return placed(negative, digits, -exponent);
}

/**
 * The sum of numbers in order, in decimal to 20 significant digits (`0.1 + 0.2` is `0.3`),
 * rounded by `rounding` if any, then the number closest to it (never `-0`).
 */
export function sumNumbers(values: readonly number[], rounding: Rounding | undefined): number {
  let total: Scaled = { coefficient: 0n, exponent: 0 };
  for (const value of values) total = addRounded(total, scaledOf(value));
  const text = textOf(total);
  const sum = Number(rounding === undefined ? text : roundDecimal(text, rounding));
  return sum === 0 ? 0 : sum;
}
