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
