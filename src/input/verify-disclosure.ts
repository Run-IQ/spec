import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { JsonValue } from '../canonical.js';
import { citeName, reasonOf, unreadableMessage } from '../errors.js';
import { boundMessages, IssueList } from '../issues.js';
import { auditPathLength } from '../merkle.js';
import { compareSegments, parsePointer } from '../path/pointer.js';
import type { JsonPointer } from '../path/pointer.js';
import { MAX_JSON_VALUES, ownCopy, withValueBudget } from '../values.js';
import { DISCLOSURE_FORMAT, isAncestor, isWithin, mayGrow } from './disclosure.js';
import type { FactDisclosureVerification } from './disclosure.js';
import {
  announce,
  expectPlainObject,
  readElement,
  readFields,
  readMember,
  requireFields,
  runCheck,
} from './read.js';
import type { Reader } from './read.js';
import { committedLeafHash, inputDigestOf, inputLeafHash, verifyInputInclusion } from './tree.js';
import type { InputLeaf } from './tree.js';

/** A digest as `computeInputDigest` writes it, a salt, a commitment, a hash of an audit path. */
const HEX_HASH = /^[0-9a-f]{64}$/;
/** The longest audit path of a tree an input can have: `MAX_JSON_VALUES` leaves. */
const MAX_AUDIT_PATH = auditPathLength(0, MAX_JSON_VALUES);
/** A list index as an input holds one (`01` names no element). */
const INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * Verifies a fact disclosure (`discloseFacts`) against the input digest `inputDigest`
 * (`computeInputDigest`), and never throws: anything malformed gives `valid: false`. The format
 * and its rules: src/input/disclosure.ts.
 *
 * 1. The shape. `d` is read once (each property read and counted once, as `MAX_JSON_VALUES`
 *    counts them) into a plain copy, and every later check runs on that copy: a closed object
 *    `{ format, inputDigest, size, facts, absent }`; `format` `run-iq.disclosure/1` (another one
 *    gives the single issue `unknown format: <format>`); `inputDigest` 64 lowercase hex
 *    characters; `size` an integer from 0 to 10 000 000; not more facts, nor more leaves in a
 *    fact, than leaves in the tree (checked before any is read); each fact `{ pointer, leaves,
 *    before?, after? }` with at least one leaf; each leaf a closed object whose `index` is below
 *    `size` and whose `path` holds exactly the hashes of the audit path of (`index`, `size`)
 *    (its length checked before any element is read); each neighbour `{ pointer, salt,
 *    commitment, index, path }`; each absence `{ pointer, before?, after? }`.
 * 2. `input digest mismatch` unless `d.inputDigest` is `inputDigest`; `nothing disclosed` for a
 *    disclosure without fact or absence.
 * 3. Each leaf, hashed as `inputLeafHash` hashes it (a neighbour from its pointer, salt and
 *    commitment; a leaf no valid input has is refused: `<path>: invalid input leaf: <why>`),
 *    must be in the tree at its index: `leaf not in tree: <pointer>` otherwise.
 * 4. Facts by increasing pointer, none inside the one before, and absences by increasing
 *    pointer, each once.
 * 5. Each fact must be shown whole (`fact not shown whole: <pointer> (<why>)`): its leaves at
 *    consecutive indices, each at or below its pointer, framed by exactly the neighbours the
 *    format requires. Each absence: `absence not proven: <pointer> (<why>)` unless its
 *    neighbours frame it as the format says; with no neighbour, only the empty tree proves it.
 * 6. What the leaves contradict: `leaves out of order: …`, `leaf inside a scalar: …`, `leaf
 *    inside an empty object: …`, `leaf outside its list: …`, `absent pointer is present: …`,
 *    and a list of a fact missing an element (`fact not shown whole: <pointer> (<list> lacks
 *    element <k>)`). Every conclusion still assumes a tree sorted honestly by its signer
 *    (D-15).
 *
 * The verdict is about the data read during the call: act on the copy it describes (take a JSON
 * copy first, verify it and use it).
 */
export function verifyFactDisclosure(d: unknown, inputDigest: string): FactDisclosureVerification {
  try {
    return withValueBudget(() => verify(d, inputDigest));
  } catch (error) {
    // Never reached by a value read under guard; a last net, still never a throw.
    return refusedWith([unreadableMessage('disclosure', error)]);
  }
}

/** A disclosure refused for `issues`. */
function refusedWith(issues: string[]): FactDisclosureVerification {
  return { valid: false, issues: boundMessages(issues), facts: {}, lists: {}, absent: [] };
}

/** A shown leaf as read: its leaf (plain primitives only), index, path, and where it is. */
interface LeafCopy {
  readonly at: string;
  readonly leaf: InputLeaf;
  readonly index: number;
  readonly path: string[];
}

/** A neighbour as read: a leaf without its content. */
interface NeighbourCopy {
  readonly at: string;
  readonly pointer: string;
  readonly salt: string;
  readonly commitment: string;
  readonly index: number;
  readonly path: string[];
}

/** A fact as read. */
interface FactCopy {
  readonly at: string;
  readonly pointer: string;
  readonly segments: string[];
  readonly leaves: LeafCopy[];
  readonly before?: NeighbourCopy;
  readonly after?: NeighbourCopy;
}

/** An absence as read. */
interface AbsenceCopy {
  readonly at: string;
  readonly pointer: string;
  readonly segments: string[];
  readonly before?: NeighbourCopy;
  readonly after?: NeighbourCopy;
}

/** A disclosure as read: every field checked for its shape. */
interface DisclosureCopy {
  readonly inputDigest: string;
  readonly size: number;
  readonly facts: FactCopy[];
  readonly absent: AbsenceCopy[];
}

const DISCLOSURE_KEYS: readonly string[] = ['format', 'inputDigest', 'size', 'facts', 'absent'];
const FACT_KEYS: readonly string[] = ['pointer', 'leaves', 'before', 'after'];
const LEAF_KEYS: readonly string[] = [
  'pointer',
  'kind',
  'value',
  'length',
  'salt',
  'valueSalt',
  'index',
  'path',
];
const NEIGHBOUR_KEYS: readonly string[] = ['pointer', 'salt', 'commitment', 'index', 'path'];
const ABSENCE_KEYS: readonly string[] = ['pointer', 'before', 'after'];

function verify(d: unknown, inputDigest: unknown): FactDisclosureVerification {
  if (typeof inputDigest !== 'string' || !HEX_HASH.test(inputDigest)) {
    return refusedWith(['the expected input digest must be 64 lowercase hex characters']);
  }
  let copy: DisclosureCopy | undefined;
  let unknownFormat: string | undefined;
  const { issues } = runCheck(
    (reader) => {
      const read = readDisclosure(d, reader);
      if (typeof read === 'string') unknownFormat = read;
      else copy = read;
    },
    (error) => ({ path: '', message: unreadableMessage('disclosure', error) }),
  );
  if (unknownFormat !== undefined) return refusedWith([`unknown format: ${unknownFormat}`]);
  if (issues.length > 0 || copy === undefined) {
    return refusedWith(issues.map((issue) => issue.message));
  }
  const read: DisclosureCopy = copy;
  if (read.inputDigest !== inputDigest) return refusedWith(['input digest mismatch']);
  if (read.facts.length === 0 && read.absent.length === 0) {
    return refusedWith(['nothing disclosed']);
  }
  const problems = new IssueList();
  const verified = checkLeaves(read, inputDigest, problems);
  checkOrder(read, problems);
  checkFacts(read, verified, problems);
  checkAbsences(read, inputDigest, verified, problems);
  checkContradictions([...verified.values()], read.absent, problems);
  const facts: Record<JsonPointer, JsonValue> = {};
  const lists: Record<JsonPointer, number> = {};
  for (const fact of read.facts) {
    if (problems.length > 0) break;
    const value = rebuild(fact, lists);
    // Pointers start with `/` (or are ``): no key of the prototype can be one.
    if (typeof value === 'string') problems.add('', value);
    else facts[fact.pointer] = value.value;
  }
  if (problems.length > 0) return refusedWith(problems.messages());
  return { valid: true, issues: [], facts, lists, absent: read.absent.map((a) => a.pointer) };
}

/**
 * Reads the caller's disclosure once into a copy, listing every problem of shape; the format
 * cited when it is a text other than `run-iq.disclosure/1`.
 */
function readDisclosure(value: unknown, reader: Reader): DisclosureCopy | string | undefined {
  const { add } = reader;
  const shape = 'an object { format, inputDigest, size, facts, absent }';
  if (!expectPlainObject(value, '', shape, add, 'disclosure')) return undefined;
  const fields = readFields(value, '', 'disclosure', DISCLOSURE_KEYS, reader);
  if (fields === undefined) return undefined;
  requireFields(fields, '', DISCLOSURE_KEYS, add);
  const field = (key: string): unknown => fields.values.get(key);
  const format = field('format');
  if (typeof format === 'string' && format !== DISCLOSURE_FORMAT) return citeName(format);
  if (fields.values.has('format') && format !== DISCLOSURE_FORMAT) {
    add('/format', '/format must be a string');
  }
  const inputDigest = field('inputDigest');
  if (fields.values.has('inputDigest') && !isHexHash(inputDigest)) {
    add('/inputDigest', '/inputDigest must be 64 lowercase hex characters');
  }
  const rawSize = field('size');
  const size = isCount(rawSize, MAX_JSON_VALUES) ? rawSize : undefined;
  if (fields.values.has('size') && size === undefined) {
    add('/size', `/size must be an integer from 0 to ${MAX_JSON_VALUES}`);
  }
  const facts = fields.values.has('facts')
    ? readCopies('/facts', field('facts'), reader, size, 'facts', (item, at) =>
        readFactCopy(item, at, size, reader),
      )
    : undefined;
  const absent = fields.values.has('absent')
    ? readCopies('/absent', field('absent'), reader, undefined, 'absences', (item, at) =>
        readAbsenceCopy(item, at, size, reader),
      )
    : undefined;
  if (reader.issues.length > 0 || facts === undefined || absent === undefined) return undefined;
  if (!isHexHash(inputDigest) || size === undefined) return undefined;
  return { inputDigest, size, facts, absent };
}

/** True for 64 lowercase hex characters. */
function isHexHash(value: unknown): value is string {
  return typeof value === 'string' && HEX_HASH.test(value);
}

/** True for an integer from 0 to `max`. */
function isCount(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

/**
 * The copies of the elements of the caller's list at `path`, each read once by `readItem`; its
 * `length` read once and, with `max` (the size of the tree), compared to it before any element
 * is read and counted (`noun` names what it holds); `undefined` after reporting a problem with
 * the list itself.
 */
function readCopies<T>(
  path: string,
  value: unknown,
  reader: Reader,
  max: number | undefined,
  noun: string,
  readItem: (item: unknown, at: string) => T | undefined,
): T[] | undefined {
  const read = readLength(value, path, reader);
  if (read === undefined) return undefined;
  const { list, length } = read;
  if (max !== undefined && length > max) {
    reader.add(path, `${path} holds ${length} ${noun}, more than the size of the tree (${max})`);
    return undefined;
  }
  announce(reader, length, path);
  const copies: T[] = [];
  for (let i = 0; i < length; i++) {
    const element = readElement(list, i, path, reader.add);
    if (element === 'failed') continue;
    const item = readItem(element.value, `${path}/${i}`);
    if (item !== undefined) copies.push(item);
  }
  return copies;
}

/** The `length` of the caller's array at `path`, read once; reports anything else. */
function readLength(
  value: unknown,
  path: string,
  reader: Reader,
): { list: readonly unknown[]; length: number } | undefined {
  let list: readonly unknown[] | undefined;
  try {
    if (Array.isArray(value)) list = value;
  } catch (error) {
    reader.add(path, unreadableMessage(path, error));
    return undefined;
  }
  if (list === undefined) {
    reader.add(path, `${path} must be an array`);
    return undefined;
  }
  const read = readMember(list, 'length', path, reader.add);
  if (read === 'failed') return undefined;
  if (!isCount(read.value, Number.MAX_SAFE_INTEGER)) {
    reader.add(path, `${path} has an invalid length`);
    return undefined;
  }
  return { list, length: read.value };
}

/** The pointer at `at` and its segments when it is a JSON pointer; reports it otherwise. */
function readPointer(
  value: unknown,
  at: string,
  add: (path: string, message: string) => void,
): { pointer: string; segments: string[] } | undefined {
  if (typeof value !== 'string') {
    add(at, `${at} must be a string`);
    return undefined;
  }
  try {
    return { pointer: value, segments: parsePointer(value) };
  } catch (error) {
    add(at, `${at}: ${reasonOf(error)}`);
    return undefined;
  }
}

/** Copies a fact at `at`, read once. */
function readFactCopy(
  value: unknown,
  at: string,
  size: number | undefined,
  reader: Reader,
): FactCopy | undefined {
  const { add } = reader;
  const shape = 'an object { pointer, leaves, before?, after? }';
  if (!expectPlainObject(value, at, shape, add)) return undefined;
  const fields = readFields(value, at, at, FACT_KEYS, reader);
  if (fields === undefined) return undefined;
  requireFields(fields, at, ['pointer', 'leaves'], add);
  const pointer = fields.values.has('pointer')
    ? readPointer(fields.values.get('pointer'), `${at}/pointer`, add)
    : undefined;
  let leaves: LeafCopy[] | undefined;
  if (fields.values.has('leaves')) {
    const path = `${at}/leaves`;
    const read = readCopies(path, fields.values.get('leaves'), reader, size, 'leaves', (item, i) =>
      readLeafCopy(item, i, size, reader),
    );
    if (read !== undefined && read.length === 0 && reader.issues.length === 0) {
      add(path, `${path} must hold at least one leaf`);
    }
    leaves = read;
  }
  const neighbours = readNeighbours(fields.values, at, size, reader);
  if (pointer === undefined || leaves === undefined || neighbours === undefined) {
    return undefined;
  }
  return { at, ...pointer, leaves, ...neighbours };
}

/** The neighbours `before` and `after` among `values`, each read once; `undefined` if refused. */
function readNeighbours(
  values: ReadonlyMap<string, unknown>,
  at: string,
  size: number | undefined,
  reader: Reader,
): { before?: NeighbourCopy; after?: NeighbourCopy } | undefined {
  const neighbour = (key: string): NeighbourCopy | undefined | 'failed' => {
    if (!values.has(key)) return undefined;
    return readNeighbourCopy(values.get(key), `${at}/${key}`, size, reader) ?? 'failed';
  };
  const before = neighbour('before');
  const after = neighbour('after');
  if (before === 'failed' || after === 'failed') return undefined;
  return { ...(before && { before }), ...(after && { after }) };
}

/**
 * The index and the audit path of a leaf at `at` among its read `values`: the index below
 * `size`, the path of exactly the length of its audit path.
 */
function readPlace(
  values: ReadonlyMap<string, unknown>,
  at: string,
  size: number | undefined,
  reader: Reader,
): { index: number; path: string[] } | undefined {
  const rawIndex = values.get('index');
  const index = isCount(rawIndex, size === undefined ? MAX_JSON_VALUES : size - 1)
    ? rawIndex
    : undefined;
  if (values.has('index') && index === undefined) {
    reader.add(
      `${at}/index`,
      size === undefined
        ? `${at}/index must be an integer from 0`
        : `${at}/index must be an integer below the size of the tree (${size})`,
    );
  }
  const path = values.has('path')
    ? readAuditPath(values.get('path'), `${at}/path`, reader, index, size)
    : undefined;
  return path === undefined || index === undefined ? undefined : { index, path };
}

/** Copies a shown leaf at `at`, read once; its values primitives only, never a caller's. */
function readLeafCopy(
  value: unknown,
  at: string,
  size: number | undefined,
  reader: Reader,
): LeafCopy | undefined {
  const { add } = reader;
  const shape = 'an object { pointer, kind, value or length, salt, valueSalt, index, path }';
  if (!expectPlainObject(value, at, shape, add)) return undefined;
  const fields = readFields(value, at, at, LEAF_KEYS, reader);
  if (fields === undefined) return undefined;
  requireFields(fields, at, ['pointer', 'kind', 'salt', 'valueSalt', 'index', 'path'], add);
  const has = (key: string): boolean => fields.values.has(key);
  const text = (key: string): string | undefined => {
    const member = fields.values.get(key);
    if (typeof member === 'string') return member;
    if (has(key)) add(`${at}/${key}`, `${at}/${key} must be a string`);
    return undefined;
  };
  const pointer = text('pointer');
  const kind = text('kind');
  const salt = text('salt');
  const valueSalt = text('valueSalt');
  if (kind !== undefined && !isLeafKind(kind)) {
    add(`${at}/kind`, `${at}/kind must be one of value, array, object`);
  }
  const scalar = fields.values.get('value');
  if (has('value') && !isScalar(scalar)) add(`${at}/value`, `${at}/value must be a JSON scalar`);
  const length = fields.values.get('length');
  if (has('length') && typeof length !== 'number') {
    add(`${at}/length`, `${at}/length must be a number`);
  }
  const place = readPlace(fields.values, at, size, reader);
  if (reader.issues.length > 0 || place === undefined) return undefined;
  if (pointer === undefined || salt === undefined || valueSalt === undefined) return undefined;
  if (kind === undefined || !isLeafKind(kind)) return undefined;
  const leaf: InputLeaf = {
    pointer,
    kind,
    // -0 has no JSON form: a leaf holds 0 (`inputLeafHash` reads it so).
    ...(isScalar(scalar) && { value: Object.is(scalar, -0) ? 0 : scalar }),
    ...(typeof length === 'number' && { length }),
    salt,
    valueSalt,
  };
  return { at, leaf, ...place };
}

/** Copies a neighbour at `at`, read once. */
function readNeighbourCopy(
  value: unknown,
  at: string,
  size: number | undefined,
  reader: Reader,
): NeighbourCopy | undefined {
  const { add } = reader;
  const shape = 'an object { pointer, salt, commitment, index, path }';
  if (!expectPlainObject(value, at, shape, add)) return undefined;
  const fields = readFields(value, at, at, NEIGHBOUR_KEYS, reader);
  if (fields === undefined) return undefined;
  requireFields(fields, at, NEIGHBOUR_KEYS, add);
  const pointer = fields.values.get('pointer');
  if (fields.values.has('pointer') && typeof pointer !== 'string') {
    add(`${at}/pointer`, `${at}/pointer must be a string`);
  }
  const [salt, commitment] = ['salt', 'commitment'].map((key) => {
    const hex = fields.values.get(key);
    if (isHexHash(hex)) return hex;
    if (fields.values.has(key))
      add(`${at}/${key}`, `${at}/${key} must be 64 lowercase hex characters`);
    return undefined;
  });
  const place = readPlace(fields.values, at, size, reader);
  if (reader.issues.length > 0 || place === undefined || typeof pointer !== 'string') {
    return undefined;
  }
  if (salt === undefined || commitment === undefined) return undefined;
  return { at, pointer, salt, commitment, ...place };
}

/** True for a kind of leaf (D-15). */
function isLeafKind(kind: string): kind is InputLeaf['kind'] {
  return kind === 'value' || kind === 'array' || kind === 'object';
}

/** True for a JSON scalar: what a leaf of kind `value` holds (checked further by its hash). */
function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * The hashes of an audit path at `at`: exactly `auditPathLength(index, size)` of them (at most
 * `MAX_AUDIT_PATH` when the place is unknown), the length compared before any is read.
 */
function readAuditPath(
  value: unknown,
  at: string,
  reader: Reader,
  index: number | undefined,
  size: number | undefined,
): string[] | undefined {
  const read = readLength(value, at, reader);
  if (read === undefined) return undefined;
  const { list, length } = read;
  if (index !== undefined && size !== undefined) {
    const expected = auditPathLength(index, size);
    if (length !== expected) {
      const hashes = expected === 1 ? 'hash' : 'hashes';
      reader.add(
        at,
        `${at} must hold ${expected} ${hashes} (the audit path of leaf ${index} of ${size})`,
      );
      return undefined;
    }
  } else if (length > MAX_AUDIT_PATH) {
    reader.add(at, `${at} must hold at most ${MAX_AUDIT_PATH} hashes`);
    return undefined;
  }
  announce(reader, length, at);
  const hashes: string[] = [];
  for (let i = 0; i < length; i++) {
    const element = readElement(list, i, at, reader.add);
    if (element === 'failed') continue;
    if (isHexHash(element.value)) hashes.push(element.value);
    else reader.add(`${at}/${i}`, `${at}/${i} must be 64 lowercase hex characters`);
  }
  return hashes;
}

/** Copies an absence at `at`, read once. */
function readAbsenceCopy(
  value: unknown,
  at: string,
  size: number | undefined,
  reader: Reader,
): AbsenceCopy | undefined {
  const { add } = reader;
  if (!expectPlainObject(value, at, 'an object { pointer, before?, after? }', add)) {
    return undefined;
  }
  const fields = readFields(value, at, at, ABSENCE_KEYS, reader);
  if (fields === undefined) return undefined;
  requireFields(fields, at, ['pointer'], add);
  const pointer = fields.values.has('pointer')
    ? readPointer(fields.values.get('pointer'), `${at}/pointer`, add)
    : undefined;
  const neighbours = readNeighbours(fields.values, at, size, reader);
  if (pointer === undefined || neighbours === undefined) return undefined;
  return { at, ...pointer, ...neighbours };
}

/** A leaf in the tree: its index, pointer and segments, and its kind when it is shown. */
interface Verified {
  readonly index: number;
  readonly pointer: string;
  readonly segments: string[];
  readonly kind?: InputLeaf['kind'];
  readonly length?: number;
}

/**
 * Lists the problems of the leaves (one a valid input cannot have, one not in the tree), and
 * returns the leaves in the tree by index, each index once (two leaves in the tree at one index
 * have one hash: they are the same leaf; a shown one tells its kind). Every check below stops
 * once `problems` is full.
 */
function checkLeaves(
  copy: DisclosureCopy,
  inputDigest: string,
  problems: IssueList,
): Map<number, Verified> {
  const byIndex = new Map<number, Verified>();
  const keep = (leaf: Verified): void => {
    if (byIndex.get(leaf.index)?.kind === undefined) byIndex.set(leaf.index, leaf);
  };
  for (const fact of copy.facts) {
    for (const leaf of fact.leaves) {
      if (problems.full) break;
      const problem = leafProblem(leaf, copy.size, inputDigest);
      if (problem !== undefined) problems.add('', problem);
      else {
        const { pointer, kind, length } = leaf.leaf;
        const segments = parsePointer(pointer);
        keep({
          index: leaf.index,
          pointer,
          segments,
          kind,
          ...(length !== undefined && { length }),
        });
      }
    }
  }
  const neighbours = [...copy.facts, ...copy.absent].flatMap((entry) => [
    entry.before,
    entry.after,
  ]);
  for (const neighbour of neighbours) {
    if (problems.full) break;
    if (neighbour === undefined) continue;
    const problem = neighbourProblem(neighbour, copy.size, inputDigest);
    if (problem !== undefined) problems.add('', problem);
    else {
      const { index, pointer } = neighbour;
      keep({ index, pointer, segments: parsePointer(pointer) });
    }
  }
  return new Map([...byIndex].sort(([a], [b]) => a - b));
}

/** Why the shown `leaf` is not the leaf at its index of the tree of `inputDigest`. */
function leafProblem(leaf: LeafCopy, size: number, inputDigest: string): string | undefined {
  let hash: Uint8Array;
  try {
    // The copy holds primitives only: hashing it reads no value of the caller.
    hash = ownCopy(() => inputLeafHash(leaf.leaf));
  } catch (error) {
    return `${leaf.at}: ${reasonOf(error)}`;
  }
  return inclusionProblem(leaf.leaf.pointer, hash, leaf, size, inputDigest);
}

/** Why `neighbour` is not the leaf at its index of the tree of `inputDigest`. */
function neighbourProblem(
  neighbour: NeighbourCopy,
  size: number,
  inputDigest: string,
): string | undefined {
  let hash: Uint8Array;
  try {
    const { pointer, salt, commitment } = neighbour;
    hash = committedLeafHash(pointer, hexToBytes(salt), hexToBytes(commitment));
  } catch (error) {
    return `${neighbour.at}: ${reasonOf(error)}`;
  }
  return inclusionProblem(neighbour.pointer, hash, neighbour, size, inputDigest);
}

function inclusionProblem(
  pointer: string,
  hash: Uint8Array,
  place: { index: number; path: readonly string[] },
  size: number,
  inputDigest: string,
): string | undefined {
  const path = place.path.map((hex) => hexToBytes(hex));
  return verifyInputInclusion(inputDigest, size, place.index, hash, path)
    ? undefined
    : `leaf not in tree: ${citeName(pointer)}`;
}

/** Facts and absences by strictly increasing pointer, no fact inside the one before. */
function checkOrder(copy: DisclosureCopy, problems: IssueList): void {
  const ordered = (
    list: readonly { at: string; segments: string[] }[],
    what: string,
    nested: boolean,
  ): void => {
    list.forEach((entry, i) => {
      const previous = list[i - 1];
      if (problems.full || previous === undefined) return;
      if (compareSegments(previous.segments, entry.segments) >= 0) {
        problems.add('', `${entry.at} does not follow ${previous.at}: ${what}`);
      } else if (nested && isAncestor(previous.segments, entry.segments)) {
        problems.add('', `${entry.at} is inside ${previous.at}: a fact is shown whole once`);
      }
    });
  };
  ordered(copy.facts, 'facts are listed by increasing pointer', true);
  ordered(copy.absent, 'absences are listed by increasing pointer', false);
}

/**
 * Lists why each fact whose leaves are all in the tree is not shown whole: its leaves at
 * consecutive indices, at or below its pointer, framed by the neighbours the format requires.
 */
function checkFacts(
  copy: DisclosureCopy,
  verified: ReadonlyMap<number, Verified>,
  problems: IssueList,
): void {
  for (const fact of copy.facts) {
    if (problems.full) return;
    const shown = [...fact.leaves, fact.before, fact.after].every(
      (leaf) => leaf === undefined || verified.has(leaf.index),
    );
    if (!shown) continue;
    const cited = citeName(fact.pointer);
    for (const reason of factReasons(fact, copy.size, verified)) {
      problems.add('', `fact not shown whole: ${cited} (${reason})`);
    }
  }
}

/** Why `fact`, its leaves in the tree, is not shown whole. */
function factReasons(
  fact: FactCopy,
  size: number,
  verified: ReadonlyMap<number, Verified>,
): string[] {
  const reasons: string[] = [];
  const [first] = fact.leaves;
  const last = fact.leaves[fact.leaves.length - 1];
  if (first === undefined || last === undefined) return reasons;
  if (fact.leaves.some((leaf, k) => leaf.index !== first.index + k)) {
    reasons.push('its leaves are not at consecutive indices');
  }
  for (const leaf of fact.leaves) {
    const segments = verified.get(leaf.index)?.segments ?? [];
    if (!isWithin(fact.segments, segments)) {
      reasons.push(`the leaf ${citeName(leaf.leaf.pointer)} is not at or below it`);
    }
  }
  const segmentsOf = (leaf: NeighbourCopy): string[] => verified.get(leaf.index)?.segments ?? [];
  const firstSegments = verified.get(first.index)?.segments ?? [];
  const atPointer = compareSegments(firstSegments, fact.segments) === 0;
  const { before, after } = fact;
  if (atPointer && before !== undefined) reasons.push('the before leaf is not needed');
  else if (!atPointer && before === undefined && first.index > 0) {
    reasons.push('no leaf before it, and its first leaf is not the first of the tree');
  } else if (before !== undefined) {
    if (before.index !== first.index - 1) {
      reasons.push('the before leaf is not just before its first leaf');
    }
    if (compareSegments(segmentsOf(before), fact.segments) >= 0) {
      reasons.push('the before leaf does not come before it');
    }
  }
  const grows = mayGrow(atPointer, first.leaf.kind, first.leaf.length);
  if (!grows && after !== undefined) reasons.push('the after leaf is not needed');
  else if (grows && after === undefined && last.index < size - 1) {
    reasons.push('no leaf after it, and its last leaf is not the last of the tree');
  } else if (after !== undefined) {
    if (after.index !== last.index + 1)
      reasons.push('the after leaf is not just after its last leaf');
    reasons.push(...afterReasons(segmentsOf(after), fact.segments));
  }
  return reasons;
}

/** Why a leaf of these segments does not come after `segments` without being inside them. */
function afterReasons(after: readonly string[], segments: readonly string[]): string[] {
  if (compareSegments(after, segments) <= 0) return ['the after leaf does not come after it'];
  return isAncestor(segments, after) ? ['the after leaf is inside it'] : [];
}

/**
 * Lists why each absence whose neighbours are in the tree does not prove its pointer absent
 * (D-15); an absence with a neighbour not in the tree is already refused for it.
 */
function checkAbsences(
  copy: DisclosureCopy,
  inputDigest: string,
  verified: ReadonlyMap<number, Verified>,
  problems: IssueList,
): void {
  for (const entry of copy.absent) {
    if (problems.full) return;
    const { before, after } = entry;
    const beforeSegments = before && verified.get(before.index)?.segments;
    const afterSegments = after && verified.get(after.index)?.segments;
    if ((before && !beforeSegments) || (after && !afterSegments)) continue;
    const reasons: string[] = [];
    if (beforeSegments && compareSegments(beforeSegments, entry.segments) >= 0) {
      reasons.push('the before leaf does not come before it');
    }
    if (afterSegments) reasons.push(...afterReasons(afterSegments, entry.segments));
    if (before && after) {
      if (after.index !== before.index + 1) {
        reasons.push('the before and after leaves are not adjacent');
      }
    } else if (before) {
      if (before.index !== copy.size - 1) reasons.push('the before leaf is not the last leaf');
    } else if (after) {
      if (after.index !== 0) reasons.push('the after leaf is not the first leaf');
    } else if (copy.size !== 0 || inputDigest !== emptyTreeDigest()) {
      reasons.push('no neighbour leaf, and the tree is not empty');
    }
    const cited = citeName(entry.pointer);
    for (const reason of reasons) problems.add('', `absence not proven: ${cited} (${reason})`);
  }
}

/** The digest of the empty tree: `computeInputDigest` of no leaf (D-15). */
function emptyTreeDigest(): string {
  return bytesToHex(inputDigestOf(0, sha256(new Uint8Array(0))));
}

/** An item of the sweep of `checkContradictions`: an absence or a verified leaf. */
type Item = { absence: AbsenceCopy; leaf?: undefined } | { leaf: Verified; absence?: undefined };

/**
 * Lists what the verified leaves (sorted by index) and the absences contradict. The leaves
 * must come in the order of their indices. Then leaves and absences are swept in pointer order
 * (an absence before a leaf at the same pointer) with the stack of their ancestors: a leaf below
 * an absence, a shown scalar or a shown empty object, an element outside a shown list (its
 * index not below the length of the nearest list above it), or an absence naming an element of
 * a shown list, is refused. Each ancestor test stops at the first differing segment: the work
 * follows the segments swept.
 */
function checkContradictions(
  leaves: readonly Verified[],
  absent: readonly AbsenceCopy[],
  problems: IssueList,
): void {
  leaves.forEach((leaf, i) => {
    const previous = leaves[i - 1];
    if (problems.full || previous === undefined) return;
    if (compareSegments(previous.segments, leaf.segments) >= 0) {
      problems.add(
        '',
        `leaves out of order: ${citeName(previous.pointer)} (leaf ${previous.index}) ` +
          `does not come before ${citeName(leaf.pointer)} (leaf ${leaf.index})`,
      );
    }
  });
  const items: Item[] = [
    ...absent.map((absence) => ({ absence })),
    ...leaves.map((leaf) => ({ leaf })),
  ];
  const segmentsOf = (item: Item): string[] => (item.leaf ?? item.absence).segments;
  // Stable: at the same pointer, an absence stays before a leaf.
  items.sort((a, b) => compareSegments(segmentsOf(a), segmentsOf(b)));
  const stack: Item[] = [];
  const holds = (top: Item, item: Item): boolean => {
    const a = segmentsOf(top);
    const b = segmentsOf(item);
    // An absence holds what is at it too; a leaf only what is strictly below it.
    return top.absence !== undefined ? isWithin(a, b) : isAncestor(a, b);
  };
  for (const item of items) {
    if (problems.full) return;
    let top = stack[stack.length - 1];
    while (top !== undefined && !holds(top, item)) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    const problem = itemProblem(top, item);
    if (problem !== undefined) problems.add('', problem);
    stack.push(item);
  }
}

/** What `item` contradicts in `top`, the nearest item above it, or `undefined`. */
function itemProblem(top: Item | undefined, item: Item): string | undefined {
  if (top === undefined) return undefined;
  if (top.absence !== undefined) {
    return item.leaf === undefined
      ? undefined
      : `absent pointer is present: ${citeName(top.absence.pointer)} ` +
          `(leaf ${citeName(item.leaf.pointer)})`;
  }
  const above = top.leaf;
  if (above === undefined) return undefined;
  const cited = citeName(item.leaf ? item.leaf.pointer : (item.absence?.pointer ?? ''));
  const parent = citeName(above.pointer);
  if (item.leaf !== undefined) {
    if (above.kind === 'value') return `leaf inside a scalar: ${cited} (inside ${parent})`;
    if (above.kind === 'object') {
      return `leaf inside an empty object: ${cited} (inside ${parent})`;
    }
  }
  if (above.kind !== 'array') return undefined;
  const length = above.length ?? 0;
  const segments = item.leaf ? item.leaf.segments : (item.absence?.segments ?? []);
  const segment = segments[above.segments.length] ?? '';
  const element = INDEX.test(segment) && Number(segment) < length;
  if (item.leaf !== undefined && !element) {
    return `leaf outside its list: ${cited} (${parent} has length ${length})`;
  }
  if (item.absence !== undefined && element && segments.length === above.segments.length + 1) {
    return `absent pointer is present: ${cited} (${parent} has length ${length})`;
  }
  return undefined;
}

/** A value being rebuilt: a scalar, a list (its elements by index) or an object. */
type Node =
  | { readonly kind: 'value'; readonly value: JsonValue }
  | {
      readonly kind: 'array';
      readonly pointer: string;
      readonly length: number;
      readonly items: Map<number, Node>;
    }
  | { readonly kind: 'object'; readonly members: Map<string, Node> };

/**
 * The value of `fact` rebuilt from its leaves (sorted, consecutive, at or below its pointer,
 * free of contradictions: all checked before), the length of each of its lists added to
 * `lists`; or why it is not whole: a list lacking an element. Lists are built as maps of the
 * elements met, so a list's length allocates nothing.
 */
function rebuild(
  fact: FactCopy,
  lists: Record<JsonPointer, number>,
): { value: JsonValue } | string {
  const depth = fact.segments.length;
  const arrays: Extract<Node, { kind: 'array' }>[] = [];
  let root: Node | undefined;
  for (const { leaf } of fact.leaves) {
    const node = nodeOf(leaf);
    if (node.kind === 'array') arrays.push(node);
    const segments = parsePointer(leaf.pointer).slice(depth);
    root ??= segments.length === 0 ? node : { kind: 'object', members: new Map() };
    let parent = root;
    segments.forEach((segment, i) => {
      const child = i === segments.length - 1 ? node : undefined;
      parent = childOf(parent, segment, child);
    });
  }
  for (const list of arrays) {
    if (list.items.size === list.length) continue;
    let missing = 0;
    while (list.items.has(missing)) missing += 1;
    return (
      `fact not shown whole: ${citeName(fact.pointer)} ` +
      `(${citeName(list.pointer)} lacks element ${missing})`
    );
  }
  for (const list of arrays) lists[list.pointer] = list.length;
  return { value: root === undefined ? null : jsonOf(root) };
}

/** The node of a leaf: its scalar, its list (no element yet), or its empty object. */
function nodeOf(leaf: InputLeaf): Node {
  if (leaf.kind === 'array') {
    return { kind: 'array', pointer: leaf.pointer, length: leaf.length ?? 0, items: new Map() };
  }
  if (leaf.kind === 'object') return { kind: 'object', members: new Map() };
  return { kind: 'value', value: leaf.value ?? null };
}

/**
 * The child of `parent` at `segment`: `node` when given (the leaf there), else the one met
 * before or a new object (one implied by the leaves below it). A list's segment is an index
 * below its length, and nothing is below a scalar: the checks before refused the rest.
 */
function childOf(parent: Node, segment: string, node: Node | undefined): Node {
  if (parent.kind === 'value') return parent;
  const make = (): Node => node ?? { kind: 'object', members: new Map() };
  if (parent.kind === 'array') {
    const index = Number(segment);
    const child = parent.items.get(index) ?? make();
    parent.items.set(index, child);
    return child;
  }
  const child = parent.members.get(segment) ?? make();
  parent.members.set(segment, child);
  return child;
}

/** The JSON value of a whole `node`. */
function jsonOf(node: Node): JsonValue {
  if (node.kind === 'value') return node.value;
  if (node.kind === 'array') {
    return Array.from({ length: node.length }, (_, k) => {
      const item = node.items.get(k);
      return item === undefined ? null : jsonOf(item);
    });
  }
  const value: { [key: string]: JsonValue } = {};
  for (const [key, member] of node.members) {
    // Plain assignment would turn a `__proto__` key into a prototype change.
    Object.defineProperty(value, key, {
      value: jsonOf(member),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return value;
}
