import type { JsonValue } from '../canonical.js';
import { citeName, quoteText, unreadableMessage } from '../errors.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { IssueList } from '../issues.js';
import type { RuleValidationIssue } from '../issues.js';
import { withSha256, writeJsonString } from '../stream.js';
import type { HashStream } from '../stream.js';
import {
  dateTimeOf,
  hasDateSlot,
  hasLoneSurrogate,
  isPlainObject,
  holeMessage,
  loneSurrogateMessage,
  MAX_INPUT_LEAF_TEXT,
  MAX_JSON_DEPTH,
  spendValues,
  tooLargeMessage,
  undefinedMessage,
  withValueBudget,
} from '../values.js';

/**
 * Internal to `@run-iq/spec`: reading a proof input once, without recursion and without ever
 * throwing a raw error, shared by `validateProofInput`, `validateTemporalFact` and the
 * assertion functions.
 */

export type Add = (path: string, message: string) => void;

/** Stops a check once its `IssueList` is full (`MAX_ISSUES`, `src/issues.ts`). */
class IssueLimitReached {}

/** Stops a check as soon as the budget of `MAX_JSON_VALUES` values is spent. */
class InputTooLarge {
  readonly message: string;
  constructor(readonly path: string) {
    this.message = tooLargeMessage(path);
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
  /** The property values read so far: each is read once, even under a shared object. */
  reads: number;
  readonly maxDepth: number;
  /**
   * Each object walked: `open` while its members are read, then its height and the values
   * below it (`walkJson`), counted on every path that leads to it, as in its JSON text: an
   * object met again is not read again, but its values are counted again. An object with a
   * part left unread (cut too deep) is not kept: a shorter path walks it again.
   */
  readonly walked: Map<object, Walked | 'open'>;
  /**
   * When set, `walkJson` also copies each value, kept here per object: a value shared by many
   * paths is copied once. A copy is complete only when no problem was found under it.
   */
  readonly copies?: Map<object, JsonValue>;
  /**
   * When set, `walkJson` also encodes each value (`containerEncoding`), kept here per object so
   * that a value shared by many paths is encoded once: `undefined` when the value has a problem
   * of its own (a problem of depth depends on the path, so it does not count here).
   */
  readonly encodings?: Map<object, string | undefined>;
  /**
   * The UTF-16 code units of the pointers of the leaves read so far (D-15): each scalar, each
   * list and each empty object, on each path, added up as they are met, never built; it stops
   * growing past `LEAF_TEXT_CAP`.
   */
  leafText: number;
}

/** Where `Reader.leafText` and the counts below stop growing: one past `MAX_INPUT_LEAF_TEXT`. */
export const LEAF_TEXT_CAP = MAX_INPUT_LEAF_TEXT + 1;

/** `a + b`, stopped at `LEAF_TEXT_CAP` (every count it adds is at least 0). */
export function addText(a: number, b: number): number {
  return Math.min(a + b, LEAF_TEXT_CAP);
}

/**
 * Internal: the values this package copied out of callers' inputs since it was loaded (each
 * scalar and each container of a copy `walkJson` or the meta readers made), so that tests can
 * prove a check that keeps no copy makes none.
 */
export const copyWork = { values: 0 };

/** The leaves below a value and the code units their pointers add below it (D-15). */
export interface LeafCount {
  /** The leaves of the value: itself when it is a scalar, a list or an empty object. */
  readonly leaves: number;
  /** The code units of their pointers after the value's own pointer, all added up. */
  readonly units: number;
}

/** An object walked: its height, the values below it, and its leaves. */
export interface Walked extends LeafCount {
  readonly height: number;
  readonly size: number;
}

/** What `walkJson` keeps besides checking: encodings (`encode`), copies (`copy`). */
export interface ReaderOptions {
  readonly encode?: boolean;
  readonly copy?: boolean;
}

function createReader(options: ReaderOptions): Reader {
  const issues = new IssueList();
  const reader: Reader = {
    add: (path, message) => {
      if (!issues.add(path, message)) throw new IssueLimitReached();
    },
    issues,
    depthIssues: 0,
    reads: 0,
    maxDepth: MAX_JSON_DEPTH,
    walked: new Map(),
    leafText: 0,
  };
  return {
    ...reader,
    ...(options.encode === true ? { encodings: new Map() } : {}),
    ...(options.copy === true ? { copies: new Map() } : {}),
  };
}

/**
 * Internal: runs one check with a fresh reader and returns the problems it listed, in the order
 * found, bounded by `IssueList` (at most 100, then one saying that further problems were not
 * listed), and the reads it made. Never throws: past the budget of `MAX_JSON_VALUES` values
 * (`withValueBudget`) the check stops with `<path> is too large`; any other error (a Proxy trap
 * outside a guarded read) is reported by `unreadable` (its path and message). With
 * `options.encode`, `walkJson` encodes values; with `options.copy`, it copies them.
 */
export function runCheck(
  check: (reader: Reader) => void,
  unreadable: (error: unknown) => RuleValidationIssue,
  options: ReaderOptions = {},
): { issues: RuleValidationIssue[]; reads: number } {
  const reader = createReader(options);
  return withValueBudget(() => {
    runChecked(check, reader, unreadable);
    return { issues: reader.issues.toArray(), reads: reader.reads };
  });
}

function runChecked(
  check: (reader: Reader) => void,
  reader: Reader,
  unreadable: (error: unknown) => RuleValidationIssue,
): void {
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
}

/** Counts `n` reads about to happen at `path`; throws `InputTooLarge` past the budget. */
export function announce(reader: Reader, n: number, path: string): void {
  if (!spendValues(n)) throw new InputTooLarge(path);
  reader.reads += n;
}

/** The length of `key` as a JSON pointer segment writes it (`~` as `~0`, `/` as `~1`). */
export function escapedLength(key: string): number {
  let length = key.length;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code === 0x7e || code === 0x2f) length += 1;
  }
  return length;
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

/**
 * Reads the element `index` of the list at `listPath` once, as `readMember` does; a hole (no
 * element at `index`: a hole is not JSON) is reported at `listPath` instead
 * (`<path> has a hole at index <i>: arrays must be dense`), and an `undefined` element at its
 * own path (`<path>/<i> is not JSON: undefined`); both give `failed`.
 */
export function readElement(
  list: object,
  index: number,
  listPath: string,
  add: Add,
): { value: unknown } | 'failed' {
  const path = `${listPath}/${index}`;
  try {
    if (!Reflect.has(list, index)) {
      add(listPath, holeMessage(listPath, index));
      return 'failed';
    }
  } catch (error) {
    add(path, unreadableMessage(path, error));
    return 'failed';
  }
  const read = readMember(list, index, path, add);
  if (read !== 'failed' && read.value === undefined) {
    add(path, undefinedMessage(path));
    return 'failed';
  }
  return read;
}

/**
 * The fields of a closed object, each read once (`readFields`). A known field whose value is
 * `undefined` is absent: it is in neither `values` nor `failed`.
 */
export interface Fields {
  readonly values: ReadonlyMap<string, unknown>;
  /** The known fields whose read threw: already reported. */
  readonly failed: ReadonlySet<string>;
}

/**
 * Reads the fields of the closed object `value` at `path`, each once after all are counted; a
 * field whose value is `undefined` is absent, known or not; reports each other unknown key
 * (`<path> has an unknown key "k"`, at the path of that key, or at `path` when the key holds a
 * lone surrogate). Problems go to `options.add` (`reader.add` by default);
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
  announce(reader, keys.length, path);
  const values = new Map<string, unknown>();
  const failed = new Set<string>();
  for (const key of keys) {
    const at = hasLoneSurrogate(key) ? path : join(path, key);
    const read = readMember(value, key, at, add);
    if (read !== 'failed' && read.value === undefined) continue;
    if (!known.includes(key)) {
      if (read !== 'failed') add(at, `${citeName(label)} has an unknown key ${quoteText(key)}`);
    } else if (read === 'failed') failed.add(key);
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

/**
 * Internal: records that `node`, an object already read member by member by the caller (not by
 * `walkJson`), holds the single scalar member `key`, so that a later `walkJson` reaching it by
 * another path counts its value again but does not read it again. With `copy`, that later walk
 * also gives this copy, so every path holds the value read once; without, the object has no
 * copy (the caller reported a problem about it).
 */
export function markRead(
  reader: Reader,
  node: object,
  key: string,
  copy: { [key: string]: JsonValue } | undefined,
): void {
  reader.walked.set(node, { height: 1, size: 1, leaves: 1, units: 1 + escapedLength(key) });
  if (copy !== undefined) reader.copies?.set(node, copy);
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
  /** True when a part was left unread (cut too deep). */
  cut: boolean;
  /** False for a root with reserved keys: another path reads those keys, so it is not kept. */
  readonly kept: boolean;
  /** The problems of the value itself listed before it was opened (`contentIssues`). */
  readonly contentBefore: number;
  /** The values below it so far: its members, and the values below each (`Reader.walked`). */
  size: number;
  /** Its leaves so far and the code units their pointers add below it (`LeafCount`). */
  leaves: number;
  units: number;
  /**
   * The key being read, and for each member read its key, its encoding (with
   * `reader.encodings`) and its copy (with `reader.copies`).
   */
  pending: string | number;
  readonly parts: [string | number, string | undefined, JsonValue | undefined][];
}

/** The problems listed so far that do not depend on the path (all but those of depth). */
function contentIssues(reader: Reader): number {
  return reader.issues.length - reader.depthIssues;
}

/** What `openValue` found: an object already walked (its values counted again), or one cut. */
interface Closed extends LeafCount {
  readonly height: number;
  readonly cut: boolean;
  /** The values below it. */
  readonly size: number;
}

/**
 * Checks that `root`, at `path` and `depth` 0, is plain JSON as an input holds it: strings
 * without lone surrogate, finite numbers of absolute value below 2^53 (D-5), booleans, `null`,
 * plain objects (keys without lone surrogate) and lists, at most `MAX_JSON_DEPTH` levels
 * deep, without cycle. With `reservedRoot`, a key of the root starting with `$` is refused
 * (`reserved key <pointer>`, D-3) and not read.
 *
 * Iterative (an explicit stack), so no nesting overflows the call stack. Each object is read
 * once, even when several paths lead to it: its height is kept, and a later path only checks
 * that the height still fits under `MAX_JSON_DEPTH` there (when it does not, it is walked again
 * from there). A value too deep is reported once, at its first container past the limit
 * (`<path> is nested deeper than 1000 levels`), and that container's members are not read; an
 * object holding it is not kept, so a shorter path reads it again and every problem is found
 * whatever the order of keys. Every member read is counted (`announce`) before it happens, and
 * an object met again is counted again (its values, `Reader.walked`), as its JSON text holds it.
 *
 * With `reader.encodings`, returns the encoding of `root` (`containerEncoding`), and with
 * `reader.copies` its plain copy, when no problem was found under it; else `undefined`. Always
 * returns the leaves of `root` and the code units their pointers add below `path` (`LeafCount`,
 * D-15), counted on every path as the walk goes (an object met again gives its count again),
 * meaningful when no problem was found.
 */
export function walkJson(
  root: unknown,
  path: string,
  reader: Reader,
  reservedRoot = false,
): { encoding: string | undefined; copy: JsonValue | undefined } & LeafCount {
  const stack: Frame[] = [];
  const issuesBefore = reader.issues.length;
  let rootEncoding: string | undefined;
  let rootCopy: JsonValue | undefined;
  let rootCount: LeafCount = { leaves: 0, units: 0 };
  const keepParts = reader.encodings !== undefined || reader.copies !== undefined;
  const settle = (
    value: { height: number; size: number; cut: boolean } & LeafCount,
    encoding: string | undefined,
    copy: JsonValue | undefined,
  ): void => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      rootEncoding = encoding;
      rootCopy = copy;
      rootCount = { leaves: value.leaves, units: value.units };
      return;
    }
    parent.height = Math.max(parent.height, value.height + 1);
    parent.size += value.size;
    if (value.cut) parent.cut = true;
    // Each leaf below the member adds the member's segment (`/` and its escaped key).
    const segment = 1 + escapedLength(String(parent.pending));
    parent.leaves += value.leaves;
    parent.units = addText(parent.units, addText(value.units, value.leaves * segment));
    if (keepParts) parent.parts.push([parent.pending, encoding, copy]);
  };
  const visit = (value: unknown, at: string, depth: number, isRoot: boolean): void => {
    const contentBefore = contentIssues(reader);
    const opened = openValue(value, at, depth, reader, isRoot && reservedRoot);
    if (opened === undefined) {
      const clean = contentIssues(reader) === contentBefore;
      const leaf = { height: 0, size: 0, cut: false, leaves: 1, units: 0 };
      const copy = clean && reader.copies !== undefined ? scalarCopy(value) : undefined;
      if (copy !== undefined) copyWork.values += 1;
      settle(leaf, clean ? scalarEncoding(value) : undefined, copy);
    } else if (!('node' in opened)) {
      const shared = opened.cut || typeof value !== 'object' || value === null ? undefined : value;
      const encoding = shared === undefined ? undefined : reader.encodings?.get(shared);
      settle(opened, encoding, shared === undefined ? undefined : reader.copies?.get(shared));
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
      const copy = reader.copies !== undefined && clean ? containerCopy(frame) : undefined;
      if (copy !== undefined) copyWork.values += 1;
      // An empty object or list is a leaf, and so is any list (its elements have their own).
      if (frame.length === 0 || frame.keys === undefined) frame.leaves += 1;
      if (frame.cut || !frame.kept) reader.walked.delete(frame.node);
      else {
        reader.walked.set(frame.node, {
          height: frame.height,
          size: frame.size,
          leaves: frame.leaves,
          units: frame.units,
        });
        reader.encodings?.set(frame.node, encoding);
        if (copy !== undefined) reader.copies?.set(frame.node, copy);
      }
      settle(frame, encoding, copy);
      continue;
    }
    const i = frame.index;
    frame.index += 1;
    const key = frame.keys === undefined ? i : frame.keys[i];
    if (key === undefined) continue;
    frame.pending = key;
    const at = typeof key === 'number' ? `${frame.path}/${key}` : childPointer(frame.path, key);
    const read =
      typeof key === 'number'
        ? readElement(frame.node, key, frame.path, reader.add)
        : readMember(frame.node, key, at, reader.add);
    if (read === 'failed') {
      settle({ height: 0, size: 0, cut: false, leaves: 0, units: 0 }, undefined, undefined);
    } else visit(read.value, at, frame.depth + 1, false);
  }
  if (reader.issues.length !== issuesBefore) {
    return { encoding: undefined, copy: undefined, ...rootCount };
  }
  return { encoding: rootEncoding, copy: rootCopy, ...rootCount };
}

/**
 * The encoding of a JSON scalar: its JSON text (`-0` written `0`, as `canonicalize` writes it),
 * or for a string longer than `SHORT_TEXT` code units, `~` and the sha256 of its JSON text
 * (hashed as it is escaped, never built: `~` never starts a JSON text); `undefined` for a value
 * that is not one. With `containerEncoding`, two values have the same encoding exactly when
 * they have the same canonical form (up to sha256 collisions), at a cost linear in the number
 * of distinct objects, never in the number of paths, and no encoding is longer than a few
 * hundred code units.
 */
function scalarEncoding(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      if (value.length <= SHORT_TEXT) return JSON.stringify(value);
      return `~${hashOfText((stream) => writeJsonString(stream, value))}`;
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : undefined;
    default:
      return undefined;
  }
}

/** The strings whose encoding is their JSON text; a longer one is encoded by its sha256. */
const SHORT_TEXT = 64;

/** The lowercase hex sha256 of what `write` writes, hashed as it is written. */
function hashOfText(write: (stream: HashStream) => void): string {
  return bytesToHex(withSha256(write));
}

/** The copy of a JSON scalar: the value itself (`-0` written `0`, as `canonicalize` writes it). */
function scalarCopy(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  return undefined;
}

/**
 * The copy of a list or an object from the copies of its members, `undefined` when a member has
 * none (a problem was reported). A shared member is one copy, shared as in the caller's value.
 */
function containerCopy(frame: Frame): JsonValue | undefined {
  if (frame.parts.length !== frame.length) return undefined;
  const copies: JsonValue[] = [];
  for (const [, , copy] of frame.parts) {
    if (copy === undefined) return undefined;
    copies.push(copy);
  }
  if (frame.keys === undefined) return copies;
  const out: { [k: string]: JsonValue } = {};
  frame.parts.forEach(([key], i) => {
    // Plain assignment would turn a `__proto__` key into a prototype change.
    Object.defineProperty(out, String(key), {
      value: copies[i],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });
  return out;
}

/**
 * The encoding of a list or an object: `#` and the sha256 of its members' encodings, written
 * as a JSON list or object with sorted keys, hashed as it is written (`#…` never starts a
 * scalar's JSON text); `undefined` when a member has none (a problem was reported).
 */
function containerEncoding(frame: Frame): string | undefined {
  if (frame.parts.some(([, encoding]) => encoding === undefined)) return undefined;
  if (frame.parts.length !== frame.length) return undefined;
  const parts =
    frame.keys === undefined
      ? frame.parts
      : [...frame.parts].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1));
  const hash = hashOfText((stream) => {
    stream.text(frame.keys === undefined ? '[' : '{');
    parts.forEach(([key, encoding], i) => {
      if (i > 0) stream.text(',');
      if (frame.keys !== undefined) {
        writeJsonString(stream, String(key));
        stream.text(':');
      }
      stream.text(encoding ?? '');
    });
    stream.text(frame.keys === undefined ? ']' : '}');
  });
  return `#${hash}`;
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
        hasDateSlot(node)
          ? dateTimeOf(node) === undefined
            ? 'a Date with a plain prototype'
            : 'a Date: write it as a string'
          : 'an object that is neither plain nor an array',
      );
    }
  } catch (error) {
    add(path, unreadableMessage(path, error));
    return undefined;
  }
  const seen = reader.walked.get(node);
  if (seen === 'open') return notJson('a circular reference');
  // A walked object that still fits here is not read again, but its values are counted again:
  // the JSON text holds them once per path. One that does not fit is walked again from here,
  // so the problem is named at its first container past the limit.
  if (seen !== undefined && depth + seen.height <= reader.maxDepth) {
    if (!spendValues(seen.size)) throw new InputTooLarge(path);
    return { ...seen, cut: false };
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
    return { height: 1, cut: true, size: count, leaves: 0, units: 0 };
  }
  reader.walked.set(node, 'open');
  return {
    node,
    path,
    depth,
    keys,
    length: count,
    index: 0,
    height: 0,
    size: count,
    leaves: 0,
    units: 0,
    cut: false,
    kept: !reservedRoot,
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
  reader.add(path, `${citeName(path)} is nested deeper than ${reader.maxDepth} levels`);
}
