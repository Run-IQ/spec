import { citeName, quoteText } from '../errors.js';
import { isPlainObject, spendValues, tooLargeMessage } from '../values.js';
import { incrementProblem, MAX_ROUNDING_SCALE, scaleOfIncrement } from './decimal.js';

/**
 * How a value is rounded to `scale` decimal places, or to a multiple of `increment`:
 * - `halfUp`, `halfDown`, `halfEven`: to the nearest, a tie going away from zero, toward zero,
 *   or to the even neighbour (the neighbour that is an even multiple of the increment);
 * - `up`, `down`: away from zero, toward zero;
 * - `ceiling`, `floor`: toward positive infinity, toward negative infinity.
 */
export type RoundingMode = 'halfUp' | 'halfDown' | 'halfEven' | 'up' | 'down' | 'ceiling' | 'floor';

/**
 * The rounding an output declares, in `mode`, with exactly one of:
 * - `scale`: to that many decimal places, an integer from 0 to 20;
 * - `increment`: to a multiple of that step, a canonical decimal string greater than 0 with at
 *   most 20 decimal places (`"0.05"` for cash rounding, `"10"`, `"1000"`). A power of ten from
 *   `"1"` to 10^-20 means a scale: its normal form is that `scale` (`"0.01"` is `scale: 2`).
 *
 * `at` says what is rounded: the combined value (`output`, the default, absent in the normal
 * form, R37) or each contribution before they combine (`contribution`, as some schedules round
 * line by line). The rounding itself is computed by `@run-iq/core`.
 */
export interface OutputRounding {
  scale?: number;
  increment?: string;
  mode: RoundingMode;
  at?: 'output' | 'contribution';
}

/** Every rounding mode, in documentation order. */
const ROUNDING_MODES: readonly RoundingMode[] = [
  'halfUp',
  'halfDown',
  'halfEven',
  'up',
  'down',
  'ceiling',
  'floor',
];
const ROUNDING_TARGETS: readonly NonNullable<OutputRounding['at']>[] = ['output', 'contribution'];
const ROUNDING_KEYS = new Set(['scale', 'increment', 'mode', 'at']);
/** The output types a rounding applies to. */
const ROUNDABLE: readonly string[] = ['number', 'decimal'];

type Add = (path: string, message: string) => void;

/** What `checkRounding` read: the members as written, and the normal form when valid. */
export interface RoundingRead {
  /** The known members read, as written: what a proof keeps. */
  copy: Record<string, unknown>;
  /**
   * The normal form, when no problem was found: an increment that is a power of ten from 1 to
   * 10^-20 becomes its `scale`, and `at: 'output'` (the default) is dropped (R37). One meaning,
   * one written form, one checksum.
   */
  normal?: OutputRounding;
}

/**
 * Internal: checks a rounding `{ scale or increment, mode, at? }` at `path`, for an output
 * declaration and for the outputs of a proof alike. A key whose value is `undefined` is absent,
 * known or not; any other unknown key is refused. Each member is read once, after being counted
 * (`spendValues`). Returns what was read (`RoundingRead`), or `undefined` when `rounding` is not
 * an object, or has too many members to read.
 */
export function checkRounding(rounding: unknown, path: string, add: Add): RoundingRead | undefined {
  if (!isPlainObject(rounding)) {
    add(path, `${citeName(path)} must be an object { scale or increment, mode, at? }`);
    return undefined;
  }
  const keys = Object.keys(rounding);
  if (!spendValues(keys.length)) {
    add(path, tooLargeMessage(path));
    return undefined;
  }
  let failed = false;
  const fail: Add = (where, message) => {
    failed = true;
    add(where, message);
  };
  const members = new Map<string, unknown>(keys.map((key) => [key, rounding[key]]));
  const copy: Record<string, unknown> = {};
  for (const [key, member] of members) {
    if (member === undefined) continue;
    if (ROUNDING_KEYS.has(key)) copy[key] = member;
    else fail(`${path}.${key}`, `${citeName(path)} has an unknown key ${quoteText(key)}`);
  }
  const { scale, increment, mode, at } = copy;
  checkStep(scale, increment, path, fail);
  if (mode === undefined) fail(`${path}.mode`, `${citeName(path)}.mode is required`);
  else if (!isOneOf(mode, ROUNDING_MODES)) {
    fail(`${path}.mode`, `${citeName(path)}.mode must be one of ${ROUNDING_MODES.join(', ')}`);
  }
  if (at !== undefined && !isOneOf(at, ROUNDING_TARGETS)) {
    fail(`${path}.at`, `${citeName(path)}.at must be one of ${ROUNDING_TARGETS.join(', ')}`);
  }
  if (failed || !isOneOf(mode, ROUNDING_MODES)) return { copy };
  const normal: OutputRounding = { mode };
  const asScale = typeof increment === 'string' ? scaleOfIncrement(increment) : scale;
  if (typeof asScale === 'number') normal.scale = asScale;
  else if (typeof increment === 'string') normal.increment = increment;
  if (at === 'contribution') normal.at = at;
  return { copy, normal };
}

/** Checks that exactly one of `scale` and `increment` is given, and that it is valid. */
function checkStep(scale: unknown, increment: unknown, path: string, fail: Add): void {
  if (scale !== undefined && increment !== undefined) {
    fail(path, `${citeName(path)} must have scale or increment, not both`);
  } else if (scale === undefined && increment === undefined) {
    fail(path, `${citeName(path)} needs scale or increment`);
  } else if (scale !== undefined) {
    const at = `${path}.scale`;
    if (!isScale(scale)) {
      fail(at, `${citeName(at)} must be an integer from 0 to ${MAX_ROUNDING_SCALE}`);
    }
  } else {
    const at = `${path}.increment`;
    const problem = incrementProblem(increment);
    if (problem !== undefined) fail(at, `${citeName(at)} ${problem}`);
  }
}

/**
 * Internal: reports each way a valid rounding, as written, is not its normal form (a proof
 * writes the normal form, one meaning one text): `at: 'output'` (the default) written out, and
 * an increment that is a power of ten from 1 to 10^-20 instead of its `scale`.
 */
export function checkNormalRounding(read: RoundingRead, path: string, add: Add): void {
  const { copy, normal } = read;
  if (normal === undefined) return;
  if (copy.at === 'output') {
    add(`${path}.at`, `${citeName(path)}.at must be absent: output is the default`);
  }
  const { increment } = copy;
  if (typeof increment === 'string' && normal.scale !== undefined) {
    add(
      `${path}.increment`,
      `${citeName(path)}.increment ${quoteText(increment)} must be written as scale ${normal.scale}`,
    );
  }
}

/** Internal: reports a rounding on an output whose type cannot be rounded. */
export function roundingNotApplicable(path: string, add: Add): void {
  add(path, `${citeName(path)} applies only to a number or decimal output`);
}

/** Internal: true for an output type a rounding (or a unit) applies to. */
export function isRoundable(type: unknown): boolean {
  return ROUNDABLE.some((item) => item === type);
}

function isScale(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_ROUNDING_SCALE
  );
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return allowed.some((item) => item === value);
}
