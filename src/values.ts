import { citeName } from './errors.js';

/**
 * The deepest a free-form JSON value carried by the format may nest: rule `params`,
 * `condition.value` and extension values, proof output values, contributions and unrounded
 * values, and the values of a decision input (below `data`, `meta.context`, or the value of a
 * temporal period: `data.a` is 1 level deep). A value holds at most this many nested levels of
 * non-empty arrays or objects (`{ "a": 1 }` is 1 level). A deeper value is refused, so every
 * consumer of the format (another runtime, a plain `JSON.parse`, a recursive reader) can read
 * any valid document on an ordinary stack. JSON Schema cannot express it: the validators check
 * it. `core`'s `maxInputDepth` stays at or below it.
 */
export const MAX_JSON_DEPTH = 1000;

/**
 * The most values one call of this package reads from its caller: each element of a list, each
 * member of an object, counted BEFORE any is read (a list's claimed `length` first). Past it the
 * value is refused (`<path> is too large: more than 10000000 values`), so the work is bounded by
 * a count, never by a clock, even for a sparse array of length 2^32 - 1 or a Proxy that claims
 * 10^12 elements. Every walk of a caller value shares it: the copy of a free-form value, the
 * canonical form, the readers of rules, proofs, referentials, pointers and inputs.
 */
export const MAX_JSON_VALUES = 10_000_000;

/** The values the current call may still read; `undefined` outside `withValueBudget`. */
let budget: { remaining: number } | undefined;

/**
 * Internal: runs `read` with one budget of `MAX_JSON_VALUES` values, shared by every walk it
 * makes (a nested call, as `verifyProof` normalizing a rule, shares the budget of the outer one).
 * Calls are synchronous, so the budget is the current call's alone.
 */
export function withValueBudget<T>(read: () => T): T {
  if (budget !== undefined) return read();
  budget = { remaining: MAX_JSON_VALUES };
  try {
    return read();
  } finally {
    budget = undefined;
  }
}

/**
 * Internal: spends `count` values of the current budget, before they are read; false (nothing
 * spent) when fewer remain, or when `count` is not a count. Outside `withValueBudget`, one read
 * of at most `MAX_JSON_VALUES` values is allowed.
 */
export function spendValues(count: number): boolean {
  const left = budget === undefined ? MAX_JSON_VALUES : budget.remaining;
  if (!Number.isSafeInteger(count) || count < 0 || count > left) return false;
  if (budget !== undefined) budget.remaining = left - count;
  return true;
}

/** Internal: the problem of a value whose reading would pass `MAX_JSON_VALUES`. */
export function tooLargeMessage(path: string): string {
  return `${citeName(path)} is too large: more than ${MAX_JSON_VALUES} values`;
}

/** Internal: the problem of an array with no element at `index` (a hole is not JSON). */
export function holeMessage(path: string, index: number): string {
  return `${citeName(path)} has a hole at index ${index}: arrays must be dense`;
}

/**
 * Internal: the elements of the caller's array `list`, read once each, or the problem that
 * stops the read: a `length` that is not a count (only a Proxy claims one), a list too large for
 * the budget (checked before any element is read), or a hole. A getter or a Proxy trap that
 * throws is passed on: each caller reads under its own guard.
 */
export function readList(list: readonly unknown[], path: string): unknown[] | string {
  const length: unknown = list.length;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    return `${citeName(path)} has an invalid length`;
  }
  if (!spendValues(length)) return tooLargeMessage(path);
  const items: unknown[] = [];
  for (let i = 0; i < length; i++) {
    if (!(i in list)) return holeMessage(path, i);
    items.push(list[i]);
  }
  return items;
}
/**
 * Value classification shared by `canonicalize` and the rule normalizer. Both checks work
 * across realms (vm contexts, iframes, worker globals), where `instanceof` fails.
 */

/**
 * The time value of a real `Date` from any realm (`NaN` for an invalid Date), or `undefined`
 * when `value` is not a Date. `Object.prototype.toString` pre-filters; `Date.prototype.getTime`
 * then checks the internal date slot, so a fake with `Symbol.toStringTag = 'Date'` is refused.
 */
export function dateTimeOf(value: unknown): number | undefined {
  if (Object.prototype.toString.call(value) !== '[object Date]') return undefined;
  try {
    return Date.prototype.getTime.call(value);
  } catch {
    return undefined;
  }
}

/**
 * A plain object: its prototype is `null` or some realm's `Object.prototype`. An object that
 * inherits from anything else, a null-prototype object included, is refused, because its
 * inherited properties would be invisible to the canonical form.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype || isForeignObjectPrototype(proto);
}

/** True for `Object.prototype` of another realm. */
function isForeignObjectPrototype(proto: unknown): boolean {
  if (proto === null || typeof proto !== 'object') return false;
  if (Object.getPrototypeOf(proto) !== null || Object.keys(proto).length > 0) return false;
  const ctor: unknown = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
  return (
    typeof ctor === 'function' &&
    ctor.name === 'Object' &&
    (ctor as { prototype?: unknown }).prototype === proto
  );
}

/**
 * A lone UTF-16 surrogate: a high one not followed by a low one, or a low one not preceded by a
 * high one.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * True when `text` holds a lone UTF-16 surrogate, which no UTF-8 text can carry: I-JSON
 * (RFC 7493) and JCS (RFC 8785) refuse it.
 */
export function hasLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE.test(text);
}

/**
 * Internal: the message refusing `subject` (a raw field path, or a description; cited by
 * `citeName`) for a lone surrogate.
 */
export function loneSurrogateMessage(subject: string): string {
  return `${citeName(subject)} contains a lone UTF-16 surrogate`;
}

/**
 * The type of `value` as a message writes it: `null`, `array`, or its `typeof`. Never throws: a
 * value that cannot be inspected (a revoked Proxy, on which `Array.isArray` throws) gives
 * `unreadable value`.
 */
export function typeName(value: unknown): string {
  if (value === null) return 'null';
  try {
    if (Array.isArray(value)) return 'array';
  } catch {
    return 'unreadable value';
  }
  return typeof value;
}
