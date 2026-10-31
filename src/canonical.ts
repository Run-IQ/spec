import { quoteText, SpecError } from './errors.js';
import { dateTimeOf, hasLoneSurrogate, isPlainObject } from './values.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/**
 * Canonical JSON, as the JSON Canonicalization Scheme (JCS, RFC 8785) defines it: object keys
 * sorted by UTF-16 code unit at every depth, no whitespace, numbers written as ECMAScript writes
 * them (`1e+30`, `0.002`, `333333333.3333333`), strings escaped as `JSON.stringify` escapes them.
 * - a `Date` (from any realm) becomes its ISO string;
 * - an `undefined` property is omitted, an `undefined` (or hole) in an array becomes `null`;
 * - `-0` is written `0`.
 *
 * Throws `SpecError` (`NON_SERIALIZABLE`) for `NaN`, `±Infinity`, bigints, functions, symbols,
 * an invalid `Date`, a circular reference, `undefined` at the top level, a string or a key that
 * holds a lone UTF-16 surrogate (I-JSON, RFC 7493: such a text has no UTF-8 form), and any
 * object that is not a plain object, an array or a `Date` (Map, Set, class instances...).
 * `toJSON` is ignored. A key with a lone surrogate is reported at the path of its object.
 *
 * Strings are data, as in JCS (RFC 8785): no Unicode normalization is applied, so `"é"`
 * written precomposed (U+00E9) and decomposed (U+0065 U+0301) give different output.
 *
 * Values such as `Decimal` (decimal.js) or Luxon `DateTime` are class instances and are
 * refused: the caller must convert them to JSON (a string or number) first.
 */
export function canonicalize(value: unknown): string {
  return canonicalizeAt(value, '');
}

/**
 * `canonicalize`, with `path` used as the root name in error messages and in
 * `SpecError.path`: `canonicalizeAt({ score: Infinity }, 'metadata')` reports
 * `metadata.score`.
 */
export function canonicalizeAt(value: unknown, path: string): string {
  return write(value, path, new Set());
}

/** Copies a value into plain JSON data, with the same rules as `canonicalize`. */
export function toJsonValue(value: unknown, path: string): JsonValue {
  return JSON.parse(canonicalizeAt(value, path)) as JsonValue;
}

function write(value: unknown, path: string, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'string':
      if (hasLoneSurrogate(value)) fail(path, 'a string with a lone UTF-16 surrogate');
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) fail(path, String(value));
      return JSON.stringify(value);
    case 'object':
      if (value === null) return 'null';
      return writeObject(value, path, ancestors);
    default:
      // undefined, bigint, function, symbol
      return fail(path, `a value of type ${typeof value}`);
  }
}

function writeObject(value: object, path: string, ancestors: Set<object>): string {
  const time = dateTimeOf(value);
  if (time !== undefined) {
    if (Number.isNaN(time)) fail(path, 'an invalid Date');
    return JSON.stringify(new Date(time).toISOString());
  }
  if (ancestors.has(value)) fail(path, 'a circular reference');

  ancestors.add(value);
  let out: string;
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      items.push(item === undefined ? 'null' : write(item, `${path}[${i}]`, ancestors));
    }
    out = `[${items.join(',')}]`;
  } else {
    if (!isPlainObject(value)) fail(path, `an instance of ${constructorName(value)}`);
    const record = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member === undefined) continue;
      if (hasLoneSurrogate(key)) fail(path, 'a key with a lone UTF-16 surrogate');
      members.push(
        `${JSON.stringify(key)}:${write(member, path ? `${path}.${key}` : key, ancestors)}`,
      );
    }
    out = `{${members.join(',')}}`;
  }
  ancestors.delete(value);
  return out;
}

function constructorName(value: object): string {
  const ctor: unknown = (value as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' && ctor.name ? ctor.name : 'an unknown class';
}

function fail(path: string, what: string): never {
  throw new SpecError(
    'NON_SERIALIZABLE',
    `Value at ${quoteText(path || '(root)')} cannot be serialized to canonical JSON: ${what}`,
    path,
  );
}
