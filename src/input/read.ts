import { escapeText, quoteText, unreadableMessage } from '../errors.js';
import { dateTimeOf, hasLoneSurrogate, isPlainObject, loneSurrogateMessage } from '../values.js';

/**
 * Internal to `@run-iq/spec`: reading a proof input once, without recursion and without ever
 * throwing a raw error, shared by `validateProofInput`, `validateTemporalFact` and the
 * assertion functions.
 */

/**
 * The deepest a value of the input may sit below `data` (or `meta.context`, or the value of a
 * temporal period): `data.a` is 1 level deep. Deeper values are refused: `canonicalize` and every
 * reader of the input recurse, so a fixed ceiling keeps every valid input readable on any stack.
 * `core`'s `maxInputDepth` stays at or below it.
 */
export const MAX_INPUT_DEPTH = 1000;

/**
 * The most property values one check reads (each key of an object, each element of a list,
 * counted before any is read): past it the input is refused as too large, so that the work is
 * bounded by a count, never by a clock, even for a Proxy announcing 10^12 elements.
 */
export const MAX_INPUT_VALUES = 10_000_000;

export type Add = (path: string, message: string) => void;

/** Stops a check as soon as the budget of `MAX_INPUT_VALUES` reads is spent. */
export class InputTooLarge {
  readonly message: string;
  constructor(
    readonly path: string,
    max: number,
  ) {
    this.message = `input too large: more than ${max} values`;
  }
}

/** Internal: the state of one check: where issues go, and the reads counted so far. */
export interface Reader {
  readonly add: Add;
  reads: number;
  readonly maxValues: number;
  readonly maxDepth: number;
  /** Each object walked: `open` while its members are read, then its height (`walkJson`). */
  readonly heights: Map<object, number | 'open'>;
}

export function createReader(add: Add): Reader {
  return {
    add,
    reads: 0,
    maxValues: MAX_INPUT_VALUES,
    maxDepth: MAX_INPUT_DEPTH,
    heights: new Map(),
  };
}

/** Counts `n` reads about to happen at `path`; throws `InputTooLarge` past the budget. */
export function announce(reader: Reader, n: number, path: string): void {
  reader.reads += n;
  if (reader.reads > reader.maxValues) throw new InputTooLarge(path, reader.maxValues);
}

/** The pointer of the member `key` of the value at `pointer` (RFC 6901 escapes). */
export function childPointer(pointer: string, key: string): string {
  return `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

/** `path` as a message cites it: escaped, at most 100 UTF-16 code units (`escapeText`). */
export function cite(path: string): string {
  return escapeText(path);
}

/** The message refusing a key of the object at `path` that holds a lone UTF-16 surrogate. */
export function surrogateKeyMessage(path: string, key: string): string {
  return `${cite(path)} has a key with a lone UTF-16 surrogate: ${quoteText(key)}`;
}

/**
 * True when `value` is a plain object; otherwise reports `<path> must be <shape>`, or why it
 * could not be inspected (a revoked Proxy, a trap that throws), and returns false.
 */
export function expectPlainObject(
  value: unknown,
  path: string,
  shape: string,
  add: Add,
): value is Record<string, unknown> {
  try {
    if (isPlainObject(value)) return true;
  } catch (error) {
    add(path, unreadableMessage(cite(path), error));
    return false;
  }
  add(path, `${cite(path)} must be ${shape}`);
  return false;
}

/**
 * The own keys of `value` (a plain object), or `undefined` after reporting that they could not
 * be listed.
 */
export function ownKeys(value: object, path: string, add: Add): string[] | undefined {
  try {
    return Object.keys(value);
  } catch (error) {
    add(path, unreadableMessage(cite(path), error));
    return undefined;
  }
}

/**
 * Reads `value[key]` once; reports the error of a getter or a Proxy trap that throws at
 * `path`, and then returns `failed`.
 */
export function readMember(
  value: object,
  key: string | number,
  path: string,
  add: Add,
): { value: unknown } | 'failed' {
  try {
    const member: unknown = Reflect.get(value, key);
    return { value: member };
  } catch (error) {
    add(path, unreadableMessage(cite(path), error));
    return 'failed';
  }
}

/** The fields of a closed object, each read once (`readFields`). */
export interface Fields {
  readonly values: ReadonlyMap<string, unknown>;
  /** The known fields whose read threw: already reported. */
  readonly failed: ReadonlySet<string>;
}

/**
 * Reads the known fields of the closed object `value` at `path`, each once; reports each
 * unknown key (`<path> has an unknown key "k"`, at the path of that key, or at `path` when the
 * key holds a lone surrogate). Problems go to `options.add` (`reader.add` by default);
 * `options.join` writes the path of a field (`childPointer` by default). Returns `undefined`
 * after reporting that the keys could not be listed.
 */
export function readFields(
  value: object,
  path: string,
  label: string,
  known: readonly string[],
  reader: Reader,
  options: { add?: Add; join?: (path: string, key: string) => string } = {},
): Fields | undefined {
  const add = options.add ?? reader.add;
  const join = options.join ?? childPointer;
  const keys = ownKeys(value, path, add);
  if (keys === undefined) return undefined;
  const present = keys.filter((key) => known.includes(key));
  announce(reader, present.length, path);
  const values = new Map<string, unknown>();
  const failed = new Set<string>();
  for (const key of keys) {
    if (!known.includes(key)) {
      const at = hasLoneSurrogate(key) ? path : join(path, key);
      add(at, `${cite(label)} has an unknown key ${quoteText(key)}`);
      continue;
    }
    const read = readMember(value, key, join(path, key), add);
    if (read === 'failed') failed.add(key);
    else values.set(key, read.value);
  }
  return { values, failed };
}

/** Reports each field of `required` that `fields` neither holds nor failed to read. */
export function requireFields(
  fields: Fields,
  path: string,
  required: readonly string[],
  add: Add,
  join: (path: string, key: string) => string = childPointer,
): void {
  for (const key of required) {
    if (!fields.values.has(key) && !fields.failed.has(key)) {
      add(join(path, key), `${cite(join(path, key))} is required`);
    }
  }
}

/** True for a non-empty string without lone surrogate; reports any other value at `path`. */
export function checkText(value: unknown, path: string, add: Add): value is string {
  if (typeof value !== 'string' || value === '') {
    add(path, `${cite(path)} must be a non-empty string`);
    return false;
  }
  if (hasLoneSurrogate(value)) {
    add(path, loneSurrogateMessage(cite(path)));
    return false;
  }
  return true;
}

/** One object or list being walked by `walkJson`. */
interface Frame {
  readonly node: object;
  readonly path: string;
  readonly depth: number;
  /** The keys to read, or `undefined` for a list (read by index up to `length`). */
  readonly keys: readonly string[] | undefined;
  readonly length: number;
  index: number;
  height: number;
}

/**
 * Checks that `root`, at `path` and `depth` 0, is plain JSON as an input holds it: strings
 * without lone surrogate, finite numbers of absolute value below 2^53 (D-5), booleans, `null`,
 * plain objects (keys without lone surrogate) and lists, at most `MAX_INPUT_DEPTH` levels
 * deep, without cycle. With `reservedRoot`, a key of the root starting with `$` is refused
 * (`reserved key <pointer>`, D-3) and not read.
 *
 * Iterative (an explicit stack), so no nesting overflows the call stack. Each object is read
 * once, even when several paths lead to it: its height is kept, and a later path only checks
 * that the height still fits under `MAX_INPUT_DEPTH` there. Every member read is counted
 * (`announce`) before it happens.
 */
export function walkJson(root: unknown, path: string, reader: Reader, reservedRoot = false): void {
  const stack: Frame[] = [];
  const settle = (height: number): void => {
    const parent = stack[stack.length - 1];
    if (parent !== undefined) parent.height = Math.max(parent.height, height + 1);
  };
  const visit = (value: unknown, at: string, depth: number, isRoot: boolean): void => {
    const frame = openValue(value, at, depth, reader, isRoot && reservedRoot);
    if (frame === undefined) settle(0);
    else if (typeof frame === 'number') settle(frame);
    else stack.push(frame);
  };
  visit(root, path, 0, true);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    if (frame.index >= frame.length) {
      stack.pop();
      reader.heights.set(frame.node, frame.height);
      settle(frame.height);
      continue;
    }
    const i = frame.index;
    frame.index += 1;
    const key = frame.keys === undefined ? i : frame.keys[i];
    if (key === undefined) continue;
    const at = typeof key === 'number' ? `${frame.path}/${key}` : childPointer(frame.path, key);
    const read = readMember(frame.node, key, at, reader.add);
    if (read !== 'failed') visit(read.value, at, frame.depth + 1, false);
  }
}

/**
 * Checks one value: a scalar is checked at once (`undefined` returned); an object already walked
 * gives its height; any other object or list gives the frame that reads its members.
 */
function openValue(
  value: unknown,
  path: string,
  depth: number,
  reader: Reader,
  reservedRoot: boolean,
): Frame | number | undefined {
  const { add } = reader;
  const notJson = (what: string): undefined => {
    add(path, `${cite(path)} is not JSON: ${what}`);
    return undefined;
  };
  switch (typeof value) {
    case 'string':
      if (hasLoneSurrogate(value)) add(path, loneSurrogateMessage(cite(path)));
      return undefined;
    case 'number':
      if (!Number.isFinite(value)) return notJson(String(value));
      if (Math.abs(value) >= 2 ** 53) add(path, `number beyond 2^53 at ${cite(path)}`);
      return undefined;
    case 'boolean':
      return undefined;
    case 'undefined':
      return notJson('undefined');
    case 'bigint':
      return notJson('a bigint');
    case 'function':
      return notJson('a function');
    case 'symbol':
      return notJson('a symbol');
    default:
      break;
  }
  // Only objects remain: `null` is JSON, anything else is read member by member.
  if (typeof value !== 'object' || value === null) return undefined;
  const node = value;
  try {
    if (!Array.isArray(node) && !isPlainObject(node)) {
      return notJson(
        dateTimeOf(node) === undefined
          ? 'an object that is neither plain nor an array'
          : 'a Date: write it as a string',
      );
    }
  } catch (error) {
    add(path, unreadableMessage(cite(path), error));
    return undefined;
  }
  const seen = reader.heights.get(node);
  if (seen === 'open') return notJson('a circular reference');
  if (seen !== undefined) {
    if (depth + seen > reader.maxDepth) add(path, tooDeepMessage(path, reader.maxDepth));
    return seen;
  }
  let keys: string[] | undefined;
  let length: number;
  try {
    if (Array.isArray(node)) {
      const announced: unknown = node.length;
      length = typeof announced === 'number' ? announced : NaN;
    } else {
      keys = Object.keys(node);
      length = keys.length;
    }
  } catch (error) {
    add(path, unreadableMessage(cite(path), error));
    return undefined;
  }
  // Only a Proxy can announce such a length.
  if (!Number.isSafeInteger(length) || length < 0) return notJson('a list with an invalid length');
  if (keys !== undefined) keys = checkKeys(keys, path, add, reservedRoot);
  const count = keys === undefined ? length : keys.length;
  announce(reader, count, path);
  if (count > 0 && depth >= reader.maxDepth) {
    add(path, tooDeepMessage(path, reader.maxDepth));
    reader.heights.set(node, 1);
    return 1;
  }
  reader.heights.set(node, 'open');
  return { node, path, depth, keys, length: count, index: 0, height: 0 };
}

/** The keys to read: a key with a lone surrogate, or a reserved root key, is reported instead. */
function checkKeys(
  keys: readonly string[],
  path: string,
  add: Add,
  reservedRoot: boolean,
): string[] {
  const kept: string[] = [];
  for (const key of keys) {
    if (hasLoneSurrogate(key)) add(path, surrogateKeyMessage(path, key));
    else if (reservedRoot && key.startsWith('$')) {
      const at = childPointer(path, key);
      add(at, `reserved key ${cite(at)}`);
    } else kept.push(key);
  }
  return kept;
}

function tooDeepMessage(path: string, maxDepth: number): string {
  return `${cite(path)} nests values more than ${maxDepth} levels deep`;
}
