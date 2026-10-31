import { citeName, quoteText, unreadableMessage } from '../errors.js';
import { sha256Hex } from '../hash.js';
import { IssueList } from '../issues.js';
import type { RuleValidationIssue } from '../issues.js';
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

/** Stops a check once its `IssueList` is full (`MAX_ISSUES`, `src/issues.ts`). */
class IssueLimitReached {}

/** Stops a check as soon as the budget of `MAX_INPUT_VALUES` reads is spent. */
class InputTooLarge {
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
  /** Lists a problem; once the list is full, stops the check (`runCheck`). */
  readonly add: Add;
  /** The problems listed so far: a value without new problem under it has an encoding. */
  readonly issues: IssueList;
  /** The problems of depth listed so far: they depend on the path, not on the value. */
  depthIssues: number;
  reads: number;
  readonly maxValues: number;
  readonly maxDepth: number;
  /**
   * Each object walked: `open` while its members are read, then its height (`walkJson`). An
   * object with a part left unread (cut too deep) is not kept: a shorter path walks it again.
   */
  readonly heights: Map<object, number | 'open'>;
  /**
   * When set, `walkJson` also encodes each value (`containerEncoding`), kept here per object so
   * that a value shared by many paths is encoded once: `undefined` when the value has a problem
   * of its own (a problem of depth depends on the path, so it does not count here).
   */
  readonly encodings?: Map<object, string | undefined>;
}

function createReader(encode: boolean): Reader {
  const issues = new IssueList();
  const reader: Reader = {
    add: (path, message) => {
      if (!issues.add(path, message)) throw new IssueLimitReached();
    },
    issues,
    depthIssues: 0,
    reads: 0,
    maxValues: MAX_INPUT_VALUES,
    maxDepth: MAX_INPUT_DEPTH,
    heights: new Map(),
  };
  return encode ? { ...reader, encodings: new Map() } : reader;
}

/**
 * Internal: runs one check with a fresh reader and returns the problems it listed, in the order
 * found, bounded by `IssueList` (at most 100, then one saying that further problems were not
 * listed), and the reads it made. Never throws: past the read budget the check stops with
 * `input too large`; any other error (a Proxy trap outside a guarded read) is reported by
 * `unreadable` (its path and message). With `encode`, `walkJson` encodes values.
 */
export function runCheck(
  check: (reader: Reader) => void,
  unreadable: (error: unknown) => RuleValidationIssue,
  encode = false,
): { issues: RuleValidationIssue[]; reads: number } {
  const reader = createReader(encode);
  try {
    check(reader);
  } catch (error) {
    if (!(error instanceof IssueLimitReached)) {
      const issue =
        error instanceof InputTooLarge
          ? { path: error.path, message: error.message }
          : unreadable(error);
      reader.issues.add(issue.path, issue.message);
    }
  }
  return { issues: reader.issues.toArray(), reads: reader.reads };
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

/** The message refusing a key of the object at `path` that holds a lone UTF-16 surrogate. */
export function surrogateKeyMessage(path: string, key: string): string {
  return `${citeName(path)} has a key with a lone UTF-16 surrogate: ${quoteText(key)}`;
}

/**
 * True when `value` is a plain object; otherwise reports at `path` `<label> must be <shape>`, or
 * why it could not be inspected (a revoked Proxy, a trap that throws), and returns false. The
 * message names `label`, `path` by default.
 */
export function expectPlainObject(
  value: unknown,
  path: string,
  shape: string,
  add: Add,
  label = path,
): value is Record<string, unknown> {
  try {
    if (isPlainObject(value)) return true;
  } catch (error) {
    add(path, unreadableMessage(label, error));
    return false;
  }
  add(path, `${citeName(label)} must be ${shape}`);
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
    add(path, unreadableMessage(path, error));
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
    add(path, unreadableMessage(path, error));
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
      add(at, `${citeName(label)} has an unknown key ${quoteText(key)}`);
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
      add(join(path, key), `${citeName(join(path, key))} is required`);
    }
  }
}

/** True for a non-empty string without lone surrogate; reports any other value at `path`. */
export function checkText(value: unknown, path: string, add: Add): value is string {
  if (typeof value !== 'string' || value === '') {
    add(path, `${citeName(path)} must be a non-empty string`);
    return false;
  }
  if (hasLoneSurrogate(value)) {
    add(path, loneSurrogateMessage(path));
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
  /** True when a part was left unread (cut too deep, or a reserved root key). */
  cut: boolean;
  /** The problems of the value itself listed before it was opened (`contentIssues`). */
  readonly contentBefore: number;
  /** The key being read, and the encodings of the members read (with `reader.encodings`). */
  pending: string | number;
  readonly parts: [string | number, string | undefined][];
}

/** The problems listed so far that do not depend on the path (all but those of depth). */
function contentIssues(reader: Reader): number {
  return reader.issues.length - reader.depthIssues;
}

/** What `openValue` found: an object already walked, or one cut too deep. */
interface Closed {
  readonly height: number;
  readonly cut: boolean;
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
 * that the height still fits under `MAX_INPUT_DEPTH` there. A value too deep is reported once
 * at its path and its members are not read; an object holding it is not kept, so a shorter
 * path reads it again and every problem is found whatever the order of keys. Every member read
 * is counted (`announce`) before it happens.
 *
 * With `reader.encodings`, returns the encoding of `root` (`containerEncoding`) when no problem
 * was found under it, else `undefined`.
 */
export function walkJson(
  root: unknown,
  path: string,
  reader: Reader,
  reservedRoot = false,
): string | undefined {
  const stack: Frame[] = [];
  const issuesBefore = reader.issues.length;
  let rootEncoding: string | undefined;
  const settle = (height: number, encoding: string | undefined, cut: boolean): void => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      rootEncoding = encoding;
      return;
    }
    parent.height = Math.max(parent.height, height + 1);
    if (cut) parent.cut = true;
    if (reader.encodings !== undefined) parent.parts.push([parent.pending, encoding]);
  };
  const visit = (value: unknown, at: string, depth: number, isRoot: boolean): void => {
    const contentBefore = contentIssues(reader);
    const opened = openValue(value, at, depth, reader, isRoot && reservedRoot);
    if (opened === undefined) {
      const clean = contentIssues(reader) === contentBefore;
      settle(0, clean ? scalarEncoding(value) : undefined, false);
    } else if (!('node' in opened)) {
      const cached =
        opened.cut || typeof value !== 'object' || value === null
          ? undefined
          : reader.encodings?.get(value);
      settle(opened.height, cached, opened.cut);
    } else stack.push(opened);
  };
  visit(root, path, 0, true);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    if (frame.index >= frame.length) {
      stack.pop();
      const clean = !frame.cut && contentIssues(reader) === frame.contentBefore;
      const encoding =
        reader.encodings !== undefined && clean ? containerEncoding(frame) : undefined;
      if (frame.cut) reader.heights.delete(frame.node);
      else {
        reader.heights.set(frame.node, frame.height);
        reader.encodings?.set(frame.node, encoding);
      }
      settle(frame.height, encoding, frame.cut);
      continue;
    }
    const i = frame.index;
    frame.index += 1;
    const key = frame.keys === undefined ? i : frame.keys[i];
    if (key === undefined) continue;
    frame.pending = key;
    const at = typeof key === 'number' ? `${frame.path}/${key}` : childPointer(frame.path, key);
    const read = readMember(frame.node, key, at, reader.add);
    if (read === 'failed') settle(0, undefined, false);
    else visit(read.value, at, frame.depth + 1, false);
  }
  if (reader.encodings === undefined || reader.issues.length !== issuesBefore) return undefined;
  return rootEncoding;
}

/**
 * The encoding of a JSON scalar: its JSON text (`-0` written `0`, as `canonicalize` writes
 * it); `undefined` for a value that is not one. With `containerEncoding`, two values have the
 * same encoding exactly when they have the same canonical form (up to sha256 collisions), at a
 * cost linear in the number of distinct objects, never in the number of paths.
 */
function scalarEncoding(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : undefined;
    default:
      return undefined;
  }
}

/**
 * The encoding of a list or an object: `#` and the sha256 of its members' encodings, written
 * as a JSON list or object with sorted keys (`#…` never starts a scalar's JSON text); `undefined`
 * when a member has none (a problem was reported).
 */
function containerEncoding(frame: Frame): string | undefined {
  if (frame.parts.some(([, encoding]) => encoding === undefined)) return undefined;
  if (frame.parts.length !== frame.length) return undefined;
  const text =
    frame.keys === undefined
      ? `[${frame.parts.map(([, encoding]) => encoding).join(',')}]`
      : `{${[...frame.parts]
          .sort(([a], [b]) => (String(a) < String(b) ? -1 : 1))
          .map(([key, encoding]) => `${JSON.stringify(key)}:${encoding}`)
          .join(',')}}`;
  return `#${sha256Hex(text)}`;
}

/**
 * Checks one value: a scalar is checked at once (`undefined` returned); an object already walked
 * gives its height, and one too deep is reported and cut (`Closed`); any other object or list
 * gives the frame that reads its members.
 */
function openValue(
  value: unknown,
  path: string,
  depth: number,
  reader: Reader,
  reservedRoot: boolean,
): Frame | Closed | undefined {
  const { add } = reader;
  const contentBefore = contentIssues(reader);
  const notJson = (what: string): undefined => {
    add(path, `${citeName(path)} is not JSON: ${what}`);
    return undefined;
  };
  switch (typeof value) {
    case 'string':
      if (hasLoneSurrogate(value)) add(path, loneSurrogateMessage(path));
      return undefined;
    case 'number':
      if (!Number.isFinite(value)) return notJson(String(value));
      if (Math.abs(value) >= 2 ** 53) add(path, `number beyond 2^53 at ${citeName(path)}`);
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
    add(path, unreadableMessage(path, error));
    return undefined;
  }
  const seen = reader.heights.get(node);
  if (seen === 'open') return notJson('a circular reference');
  if (seen !== undefined) {
    if (depth + seen > reader.maxDepth) reportTooDeep(path, reader);
    return { height: seen, cut: false };
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
    add(path, unreadableMessage(path, error));
    return undefined;
  }
  // Only a Proxy can announce such a length.
  if (!Number.isSafeInteger(length) || length < 0) return notJson('a list with an invalid length');
  if (keys !== undefined) keys = checkKeys(keys, path, add, reservedRoot);
  const count = keys === undefined ? length : keys.length;
  announce(reader, count, path);
  if (count > 0 && depth >= reader.maxDepth) {
    reportTooDeep(path, reader);
    return { height: 1, cut: true };
  }
  reader.heights.set(node, 'open');
  return {
    node,
    path,
    depth,
    keys,
    length: count,
    index: 0,
    height: 0,
    // A root with reserved keys is not kept: another path reads those keys.
    cut: reservedRoot,
    contentBefore,
    pending: 0,
    parts: [],
  };
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
      add(at, `reserved key ${citeName(at)}`);
    } else kept.push(key);
  }
  return kept;
}

/** Reports that the value at `path` sits too deep (a problem of the path, not of the value). */
function reportTooDeep(path: string, reader: Reader): void {
  reader.depthIssues += 1;
  reader.add(path, `${citeName(path)} nests values more than ${reader.maxDepth} levels deep`);
}
