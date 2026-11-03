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
 *
 * A value is counted once: as its JSON text holds it (an object shared by two paths counts on
 * each), when it is read from the caller. A copy this package made (a proof's snapshot, a
 * normalized rule, an input's copy) is walked again without spending (`ownCopy`), so every
 * function reading the same value accepts and refuses at the same count.
 */
export const MAX_JSON_VALUES = 10_000_000;

/**
 * The most UTF-16 code units the leaf pointers of one decision input hold in all (D-15), 2^28.
 * Each leaf of the input tree hashes its full pointer twice (its salt and its content), so the
 * work of a digest follows the total length of the pointers, which can grow far faster than
 * the input: a long key above many values is repeated in each of their pointers, and a value
 * shared by many paths has leaves on each. Past it, `validateProofInput` reports the input
 * (`the leaf pointers of the input hold more than 268435456 code units`) and every digest of it
 * refuses it, before anything is hashed. The total is counted, never built. An input of
 * `MAX_JSON_VALUES` leaves fits when its pointers average 26 code units.
 */
export const MAX_INPUT_LEAF_TEXT = 2 ** 28;

/** The values the current call may still read; `undefined` outside `withValueBudget`. */
let budget: { remaining: number } | undefined;
/** How many `ownCopy` calls are running: while one is, nothing is spent. */
let ownCopies = 0;
/** The values the last outermost `withValueBudget` call spent (`lastValuesSpent`). */
let lastSpent = 0;

/**
 * Internal: runs `read` with one budget of `MAX_JSON_VALUES` values, shared by every walk it
 * makes (a nested call, as `verifyProof` normalizing a rule, shares the budget of the outer one).
 * Calls are synchronous, so the budget is the current call's alone.
 */
export function withValueBudget<T>(read: () => T): T {
  // Nested, it shares the budget; inside `ownCopy` nothing is spent, so no budget is needed.
  if (budget !== undefined || ownCopies > 0) return read();
  const current = { remaining: MAX_JSON_VALUES };
  budget = current;
  try {
    return read();
  } finally {
    budget = undefined;
    lastSpent = MAX_JSON_VALUES - current.remaining;
  }
}

/**
 * Internal: runs `read` over a copy this package made (a snapshot, a normalized rule): its
 * values were counted when they were read from the caller, so walking them again spends
 * nothing. `read` must never reach a caller's value.
 */
export function ownCopy<T>(read: () => T): T {
  ownCopies += 1;
  try {
    return read();
  } finally {
    ownCopies -= 1;
  }
}

/**
 * Internal, for tests: the values the last outermost `withValueBudget` call spent, so that a
 * test proves each value of the caller is counted exactly once.
 */
export function lastValuesSpent(): number {
  return lastSpent;
}

/**
 * Internal: spends `count` values of the current budget, before they are read; false (nothing
 * spent) when fewer remain, or when `count` is not a count. Outside `withValueBudget`, one read
 * of at most `MAX_JSON_VALUES` values is allowed. Inside `ownCopy`, nothing is spent.
 */
export function spendValues(count: number): boolean {
  if (!Number.isSafeInteger(count) || count < 0) return false;
  if (ownCopies > 0) return true;
  const left = budget === undefined ? MAX_JSON_VALUES : budget.remaining;
  if (count > left) return false;
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
 * Internal: the problem of an `undefined` where JSON needs a value: an array item, or a member
 * of a free-form value (a member of an object the format defines is absent instead).
 */
export function undefinedMessage(path: string): string {
  return `${citeName(path)} is not JSON: undefined`;
}

/** Internal: why `readList` stopped, and the path to report it at. */
export interface ListProblem {
  readonly path: string;
  readonly message: string;
}

/**
 * Internal: the elements of the caller's array `list`, read once each, or the problem that
 * stops the read: a `length` that is not a count (only a Proxy claims one), a list too large for
 * the budget (checked before any element is read) or a hole, reported at `path`; an `undefined`
 * element, reported at its own path (`<path>[i] is not JSON: undefined`). A getter or a Proxy
 * trap that throws is passed on: each caller reads under its own guard.
 */
export function readList(list: readonly unknown[], path: string): unknown[] | ListProblem {
  const length: unknown = list.length;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    return { path, message: `${citeName(path)} has an invalid length` };
  }
  if (!spendValues(length)) return { path, message: tooLargeMessage(path) };
  const items: unknown[] = [];
  for (let i = 0; i < length; i++) {
    if (!(i in list)) return { path, message: holeMessage(path, i) };
    const item: unknown = list[i];
    if (item === undefined) {
      return { path: `${path}[${i}]`, message: undefinedMessage(`${path}[${i}]`) };
    }
    items.push(item);
  }
  return items;
}

/**
 * Value classification shared by `canonicalize` and the rule normalizer. Both checks work
 * across realms (vm contexts, iframes, worker globals), where `instanceof` fails.
 */

/**
 * The time value of a `Date` (`NaN` for an invalid Date), or `undefined` when `value` is not
 * one. A value is a `Date` only if both hold: it has the internal date slot
 * (`Date.prototype.getTime` reads it and nothing else, so a fake with `Symbol.toStringTag =
 * 'Date'` has none), and its prototype IS the `Date.prototype` of this realm, compared in one
 * step with no walk up the chain (a hostile chain costs one read). Anything else that carries
 * the slot (a subclass, a Date of another realm, a Date under `Object.prototype`) is not a
 * `Date` here and is refused with its pointer (`notADateMessage`): the caller converts it to a
 * string first. A class named `Date` has no slot, so it is no Date at all.
 */
export function dateTimeOf(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  // Throws for a revoked Proxy, which `readReferenceDate` reports as unreadable.
  const real = Object.getPrototypeOf(value) === Date.prototype;
  const time = dateSlotOf(value);
  // The slot under another prototype is not a Date here: see `hasDateSlot`.
  return real ? time : undefined;
}

/** The time value held by the internal date slot of `value`, or `undefined` when it has none. */
function dateSlotOf(value: unknown): number | undefined {
  // No `Object.prototype.toString` here: it reads `Symbol.toStringTag`, which a Proxy or an
  // accessor would see. `getTime` reads the internal slot and nothing else, and throws without it.
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return Date.prototype.getTime.call(value);
  } catch {
    return undefined;
  }
}

/**
 * The refusal of a value that holds the internal slot of a Date without being a `Date`:
 * `a Date with a plain prototype` (`Object.prototype`, `null`) or `a Date with a foreign
 * prototype` (any other that is not `Date.prototype`: a subclass, a Date of another realm).
 * `undefined` for a real Date and for a value with
 * no slot. One text everywhere a value is read: canonical form, rules, inputs, windows.
 */
export function notADateMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !hasDateSlot(value)) return undefined;
  if (Object.getPrototypeOf(value) === Date.prototype) return undefined;
  return hasPlainPrototype(value)
    ? 'a Date with a plain prototype'
    : 'a Date with a foreign prototype';
}

/**
 * Whether `value` holds the internal slot of a Date, whatever its prototype. An object is a
 * `Date` only if it has that slot AND `Date.prototype` of this realm as its prototype (a
 * subclass or a Date of another realm is not one); one with the slot under any other prototype
 * (`Object.setPrototypeOf(new Date(0), Object.prototype)`, `Map.prototype`, ...) is neither a
 * `Date` nor a plain object: it is refused, with its pointer, wherever a value is read
 * (`notADateMessage`). One with no slot is plain, whatever its `Symbol.toStringTag` says.
 */
export function hasDateSlot(value: unknown): boolean {
  return dateSlotOf(value) !== undefined;
}

/**
 * A plain object: its prototype is `null` or some realm's `Object.prototype`. An object that
 * inherits from anything else, a null-prototype object included, is refused, because its
 * inherited properties would be invisible to the canonical form.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return hasPlainPrototype(value) && !hasDateSlot(value);
}

/** True when the prototype of `value` is `null` or some realm's `Object.prototype`. */
function hasPlainPrototype(value: object): boolean {
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

/** `%TypedArray%.prototype`: its getters read a typed array's internal slots, never caller code. */
const TYPED_ARRAY_PROTOTYPE: object = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)?.get;
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'length')?.get;

/**
 * Internal: copies the bytes of `value` into `target` and returns true when `value` is a real
 * `Uint8Array` of any realm (a Node `Buffer` included) of exactly `target.length` bytes; else
 * leaves `target` as it is and returns false. Runs no caller code, as `bytesOf`.
 */
export function copyBytesInto(value: unknown, target: Uint8Array): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (TYPED_ARRAY_TAG === undefined || TYPED_ARRAY_LENGTH === undefined) return false;
  try {
    if (TYPED_ARRAY_TAG.call(value) !== 'Uint8Array') return false;
    if (TYPED_ARRAY_LENGTH.call(value) !== target.length) return false;
    // The tag above proves `value` holds the internal slots of a Uint8Array.
    target.set(value as Uint8Array);
    return true;
  } catch {
    return false;
  }
}

/**
 * Internal: a copy of the bytes of `value` when it is a real `Uint8Array` of any realm (a Node
 * `Buffer` included), else `undefined`. Runs no caller code: the type and the length come from
 * the internal slots (a Proxy, which has none, is refused), and the bytes are copied by
 * `Uint8Array.prototype.set` from those slots. The copy is the caller's bytes at that moment:
 * later changes to `value` do not reach it.
 */
export function bytesOf(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (TYPED_ARRAY_TAG === undefined || TYPED_ARRAY_LENGTH === undefined) return undefined;
  try {
    const tag: unknown = TYPED_ARRAY_TAG.call(value);
    if (tag !== 'Uint8Array') return undefined;
    const length: unknown = TYPED_ARRAY_LENGTH.call(value);
    if (typeof length !== 'number') return undefined;
    const copy = new Uint8Array(length);
    // The tag above proves `value` holds the internal slots of a Uint8Array.
    copy.set(value as Uint8Array);
    return copy;
  } catch {
    return undefined;
  }
}
