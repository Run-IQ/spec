import { SpecError } from './errors.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit at every depth, no whitespace.
 * - `Date` becomes its ISO string;
 * - an `undefined` property is omitted, an `undefined` (or hole) in an array becomes `null`;
 * - `-0` is written `0`.
 *
 * Throws `SpecError` (`NON_SERIALIZABLE`) for `NaN`, `±Infinity`, bigints, functions, symbols,
 * an invalid `Date`, a circular reference, `undefined` at the top level, and any object that
 * is not a plain object, an array or a `Date` (Map, Set, class instances...). `toJSON` is ignored.
 */
export function canonicalize(value: unknown): string {
  return canonicalizeAt(value, '');
}

/** `canonicalize`, with `path` used as the root name in error messages. */
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
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail(path, 'an invalid Date');
    return JSON.stringify(value.toISOString());
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
      members.push(
        `${JSON.stringify(key)}:${write(member, path ? `${path}.${key}` : key, ancestors)}`,
      );
    }
    out = `{${members.join(',')}}`;
  }
  ancestors.delete(value);
  return out;
}

/** A plain object: `{}` literal, `Object.create(null)`, or one from another realm. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function constructorName(value: object): string {
  const ctor: unknown = (value as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' && ctor.name ? ctor.name : 'an unknown class';
}

function fail(path: string, what: string): never {
  throw new SpecError(
    'NON_SERIALIZABLE',
    `Value at "${path || '(root)'}" cannot be serialized to canonical JSON: ${what}`,
  );
}
