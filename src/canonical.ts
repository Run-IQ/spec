import { bytesToHex } from '@noble/hashes/utils.js';
import { citeName, isOwnError, newSpecError, quoteText, reasonOf } from './errors.js';
import { withSha256, writeJsonString } from './stream.js';
import type { TextOut } from './stream.js';
import {
  dateTimeOf,
  notADateMessage,
  hasLoneSurrogate,
  holeMessage,
  isPlainObject,
  MAX_JSON_DEPTH,
  ownCopy,
  spendValues,
  tooLargeMessage,
  undefinedMessage,
  withValueBudget,
} from './values.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/**
 * Canonical JSON, as the JSON Canonicalization Scheme (JCS, RFC 8785) defines it: object keys
 * sorted by UTF-16 code unit at every depth, no whitespace, numbers written as ECMAScript writes
 * them (`1e+30`, `0.002`, `333333333.3333333`), strings escaped as `JSON.stringify` escapes them.
 * - a `Date` (from any realm) becomes its ISO string;
 * - an `undefined` property is omitted; an `undefined` array item is refused (`<path> is not
 *   JSON: undefined`): JSON has no `undefined`, and writing it `null` would change the value;
 * - `-0` is written `0`.
 *
 * Throws `SpecError` (`NON_SERIALIZABLE`) for `NaN`, `±Infinity`, bigints, functions, symbols,
 * an invalid `Date`, a circular reference, `undefined` at the top level, a string or a key that
 * holds a lone UTF-16 surrogate (I-JSON, RFC 7493: such a text has no UTF-8 form), and any
 * object that is not a plain object, an array or a `Date` (Map, Set, class instances...).
 * A canonical text longer than a JavaScript string can be (2^29 - 24 code units in V8) is
 * refused by name (`… cannot be serialized to canonical JSON: too long to write as one
 * string`); its digest can still be computed (every digest of this package hashes the text as
 * it is written, never the string).
 * `toJSON` is ignored. A key with a lone surrogate is reported at the path of its object. A
 * value that cannot be read (a getter or a Proxy trap that throws, a caller's `SpecError`
 * included) is reported at its own path: `a value that could not be read: <reason>`, the reason
 * cited (escaped, cut at 256 characters).
 *
 * The walk keeps its own stack, not the JavaScript call stack: any depth is accepted. An array
 * with a hole is refused (`<path> has a hole at index <i>: arrays must be dense`): a hole is not
 * JSON. At most `MAX_JSON_VALUES` (10 000 000) values are read, each list's claimed length
 * counted before any element is read: past it, `<path> is too large: more than 10000000
 * values`.
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
  const out = new StringOut(root);
  withValueBudget(() => write(value, root, CANONICAL, new StreamSink(out)));
  return out.value;
}

/** How `canonicalize` reads a value. */
const CANONICAL = { guarded: true, maxDepth: Infinity, freeForm: false };

/**
 * Internal: the lowercase hex sha256 of the UTF-8 bytes of `canonicalize(value)`, with its
 * checks and errors, written into the hash as it is produced: the text is never built, so a
 * value whose canonical text is longer than a string can be (values shared by many paths, a
 * text of 2^29 code units) has a digest all the same.
 */
export function canonicalSha256Hex(value: unknown): string {
  return bytesToHex(
    withSha256((stream) => {
      withValueBudget(() => write(value, '', CANONICAL, new StreamSink(stream)));
    }),
  );
}

/**
 * Internal: writes the canonical text of `value` into `out`, piece by piece (it is never built
 * whole). `value` is a plain-JSON copy this package made (a snapshot), whose values were counted
 * when they were read: walking it spends nothing.
 */
export function writeCanonical(out: TextOut, value: unknown): void {
  ownCopy(() => write(value, '', CANONICAL, new StreamSink(out)));
}

/**
 * Internal: true when `canonicalize(value)` is exactly `text`, compared as it is produced (with
 * the checks and errors of `canonicalize`); the canonical text is never built.
 */
export function isCanonicalText(value: unknown, text: string): boolean {
  const out = new CompareOut(text);
  withValueBudget(() => write(value, '', CANONICAL, new StreamSink(out)));
  return out.matches();
}

/**
 * Internal: copies a free-form value the format carries (rule `params`, a proof output value...)
 * into plain JSON data, with the same rules as `canonicalize`, except that an `undefined` member
 * is refused as an `undefined` array item is (`<path> is not JSON: undefined`): inside a
 * free-form value it is not JSON. At most `MAX_JSON_DEPTH` levels deep: a deeper value throws
 * `SpecError` (`NON_SERIALIZABLE`, `<path> is nested deeper than 1000 levels`, at the path of its
 * first container past the limit). What a getter or a Proxy trap throws is passed on as it is:
 * every caller reads under its own guard, which names the field that could not be read.
 */
export function toJsonValue(value: unknown, path: string): JsonValue {
  const options = { guarded: false, maxDepth: MAX_JSON_DEPTH, freeForm: true };
  return write(value, path, options, new ValueSink());
}

/**
 * Internal: `toJsonValue` for a part of the format read as JSON (a rule's `exceptions` or
 * `forEach`): an `undefined` member of one of its objects is absent and left out of the copy,
 * except under a member `freeFormAt` names (`freeFormAt(depth, key)`, `depth` 0 for the members
 * of the root), which holds a free-form value, copied as `toJsonValue` copies one.
 */
export function toJsonDocument(
  value: unknown,
  path: string,
  freeFormAt: (depth: number, key: string) => boolean,
): JsonValue {
  const options = { guarded: false, maxDepth: MAX_JSON_DEPTH, freeForm: false, freeFormAt };
  return write(value, path, options, new ValueSink());
}

type Leaf = null | boolean | number | string;

/**
 * How `write` assembles its output, one event at a time in document order: the canonical text
 * (`StreamSink`), or a plain JSON copy (`ValueSink`).
 */
interface Sink<T> {
  leaf(value: Leaf): void;
  /** Starts an array or an object, ended by `close`. */
  open(array: boolean): void;
  /** The key of the next member of the open object. */
  key(name: string): void;
  close(): void;
  result(): T;
}

/**
 * The canonical text, written in document order into a `TextOut` as the walk goes: the text of
 * a container is never held apart from its members', and a long string is escaped slice by
 * slice (`writeJsonString`). What the text goes to decides what it costs: a string
 * (`canonicalize`), a hash (`canonicalSha256Hex`), a comparison (`isCanonicalText`).
 */
class StreamSink implements Sink<void> {
  /** For each open container: whether it is a list, and whether a member was written. */
  private readonly containers: { array: boolean; written: boolean }[] = [];

  constructor(private readonly out: TextOut) {}

  leaf(value: Leaf): void {
    this.before();
    if (typeof value === 'number') this.out.text(String(value));
    else if (typeof value === 'string') writeJsonString(this.out, value);
    else this.out.text(value === null ? 'null' : String(value));
  }

  open(array: boolean): void {
    this.before();
    this.out.text(array ? '[' : '{');
    this.containers.push({ array, written: false });
  }

  key(name: string): void {
    const top = this.containers[this.containers.length - 1];
    if (top === undefined) return;
    if (top.written) this.out.text(',');
    top.written = true;
    writeJsonString(this.out, name);
    this.out.text(':');
  }

  close(): void {
    const top = this.containers.pop();
    if (top !== undefined) this.out.text(top.array ? ']' : '}');
  }

  result(): void {
    return undefined;
  }

  /** The comma before a list's member (an object's is written with its key). */
  private before(): void {
    const top = this.containers[this.containers.length - 1];
    if (top === undefined || !top.array) return;
    if (top.written) this.out.text(',');
    top.written = true;
  }
}

/**
 * The text gathered into one string. A text longer than a string can be (V8 holds at most
 * 2^29 - 24 code units) is refused by name: `SpecError` (`NON_SERIALIZABLE`, `… too long to
 * write as one string`) rather than the engine's `RangeError`.
 */
class StringOut implements TextOut {
  value = '';

  constructor(private readonly path: string) {}

  text(piece: string): void {
    try {
      this.value += piece;
    } catch (error) {
      if (error instanceof RangeError) fail(this.path, 'too long to write as one string');
      throw error;
    }
  }
}

/** Compares the text written with `expected`, piece by piece, building nothing. */
class CompareOut implements TextOut {
  private at = 0;
  private same = true;

  constructor(private readonly expected: string) {}

  text(piece: string): void {
    if (!this.same) return;
    if (this.expected.startsWith(piece, this.at)) this.at += piece.length;
    else this.same = false;
  }

  matches(): boolean {
    return this.same && this.at === this.expected.length;
  }
}

/** A plain JSON copy, built in document order. */
class ValueSink implements Sink<JsonValue> {
  private root: JsonValue = null;
  private readonly containers: (JsonValue[] | { [k: string]: JsonValue })[] = [];
  private pending = '';

  leaf(value: Leaf): void {
    this.add(Object.is(value, -0) ? 0 : value);
  }

  open(array: boolean): void {
    const container: JsonValue[] | { [k: string]: JsonValue } = array ? [] : {};
    this.add(container);
    this.containers.push(container);
  }

  key(name: string): void {
    this.pending = name;
  }

  close(): void {
    this.containers.pop();
  }

  result(): JsonValue {
    return this.root;
  }

  private add(value: JsonValue): void {
    const parent = this.containers[this.containers.length - 1];
    if (parent === undefined) this.root = value;
    else if (Array.isArray(parent)) parent.push(value);
    else {
      // Plain assignment would turn a `__proto__` key into a prototype change.
      Object.defineProperty(parent, this.pending, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
}

interface WriteOptions {
  /** What a read throws (other than this package's own errors) is reported at the path read. */
  readonly guarded: boolean;
  /** A non-empty container more than this many levels deep is refused. */
  readonly maxDepth: number;
  /** An `undefined` member of the root and below is refused, rather than left out. */
  readonly freeForm: boolean;
  /** The members under which a value is free-form (`toJsonDocument`). */
  readonly freeFormAt?: (depth: number, key: string) => boolean;
}

/** An array or an object being written: its members are read one by one. */
interface Frame {
  readonly node: object;
  readonly path: string;
  /** The sorted keys of an object; `undefined` for an array. */
  readonly keys: readonly string[] | undefined;
  readonly length: number;
  /** An `undefined` member is refused (inside a free-form value), not left out. */
  readonly freeForm: boolean;
  index: number;
}

/**
 * The output of `root` (`sink`), by a depth-first walk over an explicit stack: members in index
 * or sorted-key order, as a recursive walk would visit them. With `guarded`, what a read throws
 * (other than this package's own errors) is reported at the path read. A non-empty array or
 * object more than `maxDepth` levels deep is refused at its path: the first container past the
 * limit (`rootPath` is level 1). An `undefined` array item is refused; an `undefined` member is
 * refused inside a free-form value, and left out elsewhere.
 */
function write<T>(root: unknown, rootPath: string, options: WriteOptions, sink: Sink<T>): T {
  const { guarded, maxDepth, freeFormAt } = options;
  /** `fn()`; with `guarded`, what it throws is reported at `path` (built only then). */
  const read = <R>(path: string | (() => string), fn: () => R): R => {
    if (!guarded) return fn();
    try {
      return fn();
    } catch (error) {
      if (isOwnError(error)) throw error;
      const at = typeof path === 'string' ? path : path();
      return fail(at, `a value that could not be read: ${reasonOf(error)}`);
    }
  };
  const ancestors = new Set<object>();
  const stack: Frame[] = [];
  /** The path of `member` of `parent` (the root without one), built only when needed. */
  const pathOf = (parent: Frame | undefined, member: string | number): string => {
    if (parent === undefined) return rootPath;
    if (typeof member === 'number') return `${parent.path}[${member}]`;
    return parent.path ? `${parent.path}.${member}` : member;
  };
  /** Writes a scalar or a `Date` at once, or opens a frame for a container. */
  const open = (
    value: unknown,
    parent: Frame | undefined,
    member: string | number,
    freeForm: boolean,
  ): void => {
    switch (typeof value) {
      case 'string':
        if (hasLoneSurrogate(value)) {
          fail(pathOf(parent, member), 'a string with a lone UTF-16 surrogate');
        }
        sink.leaf(value);
        return;
      case 'boolean':
        sink.leaf(value);
        return;
      case 'number':
        if (!Number.isFinite(value)) fail(pathOf(parent, member), String(value));
        sink.leaf(value);
        return;
      case 'object':
        if (value === null) {
          sink.leaf(null);
          return;
        }
        break;
      default:
        // undefined, bigint, function, symbol
        fail(pathOf(parent, member), `a value of type ${typeof value}`);
    }
    const node = value as object;
    const path = pathOf(parent, member);
    const time = read(path, () => dateTimeOf(node));
    if (time !== undefined) {
      if (Number.isNaN(time)) fail(path, 'an invalid Date');
      sink.leaf(new Date(time).toISOString());
      return;
    }
    const notDate = read(path, () => notADateMessage(node));
    if (notDate !== undefined) fail(path, notDate);
    if (ancestors.has(node)) fail(path, 'a circular reference');
    let keys: string[] | undefined;
    let length: number;
    if (read(path, () => Array.isArray(node))) {
      const claimed: unknown = read(path, () => (node as unknown[]).length);
      // Only a Proxy claims a length that is not a count.
      if (typeof claimed !== 'number' || !Number.isSafeInteger(claimed) || claimed < 0) {
        fail(path, 'an array with an invalid length');
      }
      length = claimed as number;
    } else {
      if (!read(path, () => isPlainObject(node))) {
        const name = read(path, () => constructorName(node));
        fail(path, `an instance of ${citeName(name)}`);
      }
      keys = read(path, () => Object.keys(node).sort());
      length = keys.length;
    }
    if (length > 0 && stack.length >= maxDepth) {
      throw newSpecError(
        'NON_SERIALIZABLE',
        `${citeName(path)} is nested deeper than ${maxDepth} levels`,
        path,
      );
    }
    // Counted before any member is read: a sparse array or a Proxy may claim 2^32 - 1.
    if (!spendValues(length)) {
      throw newSpecError('NON_SERIALIZABLE', tooLargeMessage(path || '(root)'), path);
    }
    ancestors.add(node);
    sink.open(keys === undefined);
    stack.push({ node, path, keys, length, freeForm, index: 0 });
  };
  /** Element `i` of the array of `frame`, read once; a hole or an `undefined` is refused. */
  const element = (frame: Frame, i: number): unknown => {
    const list = frame.node as unknown[];
    const at = (): string => pathOf(frame, i);
    const present = guarded ? read(at, () => i in list) : i in list;
    if (!present) {
      throw newSpecError('NON_SERIALIZABLE', holeMessage(frame.path || '(root)', i), frame.path);
    }
    const item = guarded ? read(at, () => list[i]) : list[i];
    if (item === undefined) throw newSpecError('NON_SERIALIZABLE', undefinedMessage(at()), at());
    return item;
  };

  open(root, undefined, '', options.freeForm);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    if (frame.index >= frame.length) {
      stack.pop();
      ancestors.delete(frame.node);
      sink.close();
      continue;
    }
    const i = frame.index;
    frame.index += 1;
    const { node, keys } = frame;
    if (keys === undefined) {
      open(element(frame, i), frame, i, frame.freeForm);
      continue;
    }
    const key = keys[i] ?? '';
    const freeForm = frame.freeForm || (freeFormAt?.(stack.length - 1, key) ?? false);
    const member = guarded
      ? read(
          () => pathOf(frame, key),
          () => (node as Record<string, unknown>)[key],
        )
      : (node as Record<string, unknown>)[key];
    if (member === undefined) {
      if (!freeForm) continue;
      const path = pathOf(frame, key);
      throw newSpecError('NON_SERIALIZABLE', undefinedMessage(path), path);
    }
    if (hasLoneSurrogate(key)) fail(frame.path, 'a key with a lone UTF-16 surrogate');
    sink.key(key);
    open(member, frame, key, freeForm);
  }
  // `open` wrote the root, or threw (`undefined` at the root included).
  return sink.result();
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
