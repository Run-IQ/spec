import { citeName, isOwnError, newSpecError, quoteText, reasonOf } from './errors.js';
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
 * `toJSON` is ignored. A key with a lone surrogate is reported at the path of its object. A
 * value that cannot be read (a getter or a Proxy trap that throws, a caller's `SpecError`
 * included) is reported at its own path: `a value that could not be read: <reason>`, the reason
 * cited (escaped, cut at 256 characters).
 *
 * The walk keeps its own stack, not the JavaScript call stack: any depth is accepted.
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
  const root: unknown = path;
  if (typeof root !== 'string') {
    throw newSpecError('INVALID_PATH', `path must be a string, got a value of type ${typeof root}`);
  }
  return write(value, root, true);
}

/**
 * Internal: copies a value into plain JSON data, with the same rules as `canonicalize`. What a
 * getter or a Proxy trap throws is passed on as it is: every caller reads under its own guard,
 * which names the field that could not be read.
 */
export function toJsonValue(value: unknown, path: string): JsonValue {
  return JSON.parse(write(value, path, false)) as JsonValue;
}

/** An array or an object being written: its members are read one by one. */
interface Frame {
  readonly node: object;
  readonly path: string;
  /** The sorted keys of an object; `undefined` for an array. */
  readonly keys: readonly string[] | undefined;
  readonly length: number;
  index: number;
  /** The members written so far, joined by commas. */
  out: string;
  /** The key of the member being written (objects only). */
  pending: string;
}

/**
 * The canonical text of `root`, by a depth-first walk over an explicit stack: members in index
 * or sorted-key order, as a recursive walk would visit them, at any depth. With `guarded`, what
 * a read throws (other than this package's own errors) is reported at the path read.
 */
function write(root: unknown, rootPath: string, guarded: boolean): string {
  const read = <T>(path: string, fn: () => T): T => {
    if (!guarded) return fn();
    try {
      return fn();
    } catch (error) {
      if (isOwnError(error)) throw error;
      return fail(path, `a value that could not be read: ${reasonOf(error)}`);
    }
  };
  const ancestors = new Set<object>();
  const stack: Frame[] = [];
  let result: string | undefined;
  const emit = (text: string): void => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      result = text;
      return;
    }
    const member = parent.keys === undefined ? text : `${JSON.stringify(parent.pending)}:${text}`;
    parent.out += parent.out === '' ? member : `,${member}`;
  };
  /** Writes a scalar or a `Date` at once (`emit`), or opens a frame for a container. */
  const open = (value: unknown, path: string): void => {
    const text = scalar(value, path, read);
    if (text !== undefined) {
      emit(text);
      return;
    }
    // `scalar` returned no text: `value` is an array or an object.
    const node = value as object;
    if (ancestors.has(node)) fail(path, 'a circular reference');
    let keys: string[] | undefined;
    let length: number;
    if (read(path, () => Array.isArray(node))) {
      length = read(path, () => (node as unknown[]).length);
    } else {
      if (!read(path, () => isPlainObject(node))) {
        const name = read(path, () => constructorName(node));
        fail(path, `an instance of ${citeName(name)}`);
      }
      keys = read(path, () => Object.keys(node).sort());
      length = keys.length;
    }
    ancestors.add(node);
    stack.push({ node, path, keys, length, index: 0, out: '', pending: '' });
  };

  open(root, rootPath);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    if (frame.index >= frame.length) {
      stack.pop();
      ancestors.delete(frame.node);
      emit(frame.keys === undefined ? `[${frame.out}]` : `{${frame.out}}`);
      continue;
    }
    const i = frame.index;
    frame.index += 1;
    const { node, keys } = frame;
    if (keys === undefined) {
      const path = `${frame.path}[${i}]`;
      const item = read(path, () => (node as unknown[])[i]);
      if (item === undefined) emit('null');
      else open(item, path);
      continue;
    }
    const key = keys[i] ?? '';
    const path = frame.path ? `${frame.path}.${key}` : key;
    const member = read(path, () => (node as Record<string, unknown>)[key]);
    if (member === undefined) continue;
    if (hasLoneSurrogate(key)) fail(frame.path, 'a key with a lone UTF-16 surrogate');
    frame.pending = key;
    open(member, path);
  }
  if (result === undefined) return fail(rootPath, 'a value of type undefined');
  return result;
}

/**
 * The canonical text of a scalar or a `Date`; `undefined` for an array or an object (a
 * container the walk opens). Throws `NON_SERIALIZABLE` for anything JSON cannot hold.
 */
function scalar(
  value: unknown,
  path: string,
  read: <T>(path: string, fn: () => T) => T,
): string | undefined {
  switch (typeof value) {
    case 'string':
      if (hasLoneSurrogate(value)) fail(path, 'a string with a lone UTF-16 surrogate');
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) fail(path, String(value));
      return JSON.stringify(value);
    case 'object': {
      if (value === null) return 'null';
      const time = read(path, () => dateTimeOf(value));
      if (time === undefined) return undefined;
      if (Number.isNaN(time)) fail(path, 'an invalid Date');
      return JSON.stringify(new Date(time).toISOString());
    }
    default:
      // undefined, bigint, function, symbol
      return fail(path, `a value of type ${typeof value}`);
  }
}

function constructorName(value: object): string {
  const ctor: unknown = (value as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' && ctor.name ? ctor.name : 'an unknown class';
}

function fail(path: string, what: string): never {
  throw newSpecError(
    'NON_SERIALIZABLE',
    `Value at ${quoteText(path || '(root)')} cannot be serialized to canonical JSON: ${what}`,
    path,
  );
}
