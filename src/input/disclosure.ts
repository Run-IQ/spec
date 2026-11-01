import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { JsonValue } from '../canonical.js';
import { citeName, isOwnError, newSpecError, reasonOf, unreadableMessage } from '../errors.js';
import { boundMessages, IssueList } from '../issues.js';
import { auditPathLength, PackedHashes } from '../merkle.js';
import { compareSegments, parsePointer } from '../path/pointer.js';
import type { JsonPointer } from '../path/pointer.js';
import { MAX_JSON_VALUES, ownCopy, readList, typeName, withValueBudget } from '../values.js';
import { forEachLeaf } from './leaves.js';
import type { LeafContent } from './leaves.js';
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
import { inputSalter, readSeed } from './seed.js';
import { createLeafHasher, inputDigestOf, inputLeafHash, verifyInputInclusion } from './tree.js';
import type { InputLeaf } from './tree.js';
import type { ProofInput } from './types.js';
import { readValidInput } from './validate.js';

/**
 * Selective disclosure of the facts of a decision input, and proofs of absence (D-14, D-15):
 * the format `run-iq.disclosure/1`, frozen with `run-iq.proof/1`.
 *
 * A disclosure shows some leaves of the salted input tree, each with its index and its audit
 * path, and is checked against the input digest alone (`computeInputDigest`), which commits to
 * the leaf count: a leaf is in the tree, at its place, in a tree of that size
 * (`verifyInputInclusion`). The leaves are sorted by `comparePointers`, the descendants of a
 * pointer right after it, so a pointer is absent when two adjacent leaves frame it and the
 * second is not inside it; before the first leaf, the first leaf alone proves it, after the last
 * leaf the last one alone (its index is the size less one, and the size is committed); and a
 * scalar leaf above the pointer proves it alone (a scalar has nothing below it).
 *
 * An absence holds only if the signer sorted the tree honestly: a tree is not checked to be
 * sorted by its digest, and only a replay with the input checks it (D-15). What the disclosed
 * leaves themselves contradict (leaves out of order, a leaf below a scalar or an empty object,
 * an element outside its list, an absence one of them shows present) is refused.
 */

/** The format of a fact disclosure (D-6). */
export const DISCLOSURE_FORMAT = 'run-iq.disclosure/1';

/**
 * A disclosed leaf of the input tree: the leaf (`InputLeaf`: pointer, kind, value or length,
 * salt), its `index` among the leaves sorted by `comparePointers`, and its RFC 6962 audit path
 * (`path`, lowercase hex, from the bottom of the tree up).
 */
export interface DisclosedLeaf extends InputLeaf {
  index: number;
  path: string[];
}

/**
 * The proof that `pointer` is absent from the input: the leaf just before it (`before`), the leaf
 * just after it (`after`, not inside it), or one of them alone (before the first leaf: `after`
 * at index 0; after the last leaf: `before` at index `size - 1`; below a scalar: `before`, that
 * scalar); neither only in the empty tree.
 */
export interface AbsenceProof {
  pointer: JsonPointer;
  before?: DisclosedLeaf;
  after?: DisclosedLeaf;
}

/**
 * A fact disclosure (`run-iq.disclosure/1`): the input digest it is checked against, the leaf
 * count that digest commits to (`size`), the disclosed facts (`facts`, by increasing index)
 * and the proven absences (`absent`, by increasing pointer). Proving an absence discloses its
 * neighbour leaves in full (pointer, value, salt). The seed, and the salt of a leaf it does not
 * show, are never in it.
 */
export interface FactDisclosure {
  format: typeof DISCLOSURE_FORMAT;
  inputDigest: string;
  size: number;
  facts: DisclosedLeaf[];
  absent: AbsenceProof[];
}

/**
 * What `verifyFactDisclosure` concludes. When `valid`, `facts` holds the value of each
 * disclosed scalar leaf and `{}` for each disclosed empty object, `lists` the length of each
 * disclosed list, and `absent` each pointer proven absent; otherwise all three are empty and
 * `issues` says why (at most 100 problems, then `further problems not listed (limit 100)`).
 */
export interface FactDisclosureVerification {
  valid: boolean;
  issues: string[];
  facts: Record<JsonPointer, JsonValue>;
  lists: Record<JsonPointer, number>;
  absent: JsonPointer[];
}

/** A digest as `computeInputDigest` writes it, and a hash of an audit path. */
const HEX_HASH = /^[0-9a-f]{64}$/;
/** The longest audit path of a tree an input can have: `MAX_JSON_VALUES` leaves. */
const MAX_AUDIT_PATH = auditPathLength(0, MAX_JSON_VALUES);
/** A list index as an input holds one (`01` names no element). */
const INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * The disclosure of the leaves of `input` at the pointers `present`, and the proofs that the
 * pointers `absent` are absent from it, under `seed` (D-14, D-15).
 *
 * `seed` is checked first (`INVALID_KEY` unless a `Uint8Array` of 32 bytes); a seed of 32 zero
 * bytes (`UNSALTED_SEED`, compared by its bytes) is refused (`INVALID_DISCLOSURE`, `unsalted
 * input cannot be disclosed`): its salts are public, so a hidden neighbour would be found by
 * guessing. Then the requests are read once (`INVALID_DISCLOSURE`: `present must be an array of
 * JSON pointers`, `<list> could not be read: <reason>`, `<list> is too large: …`; `INVALID_PATH`
 * for an invalid pointer; `pointer requested twice: <p>` for a pointer listed twice, in either
 * list; `nothing to disclose`), then `input`, read once and checked as `validateProofInput`
 * checks it (`INVALID_INPUT`). A present pointer must name a leaf: a scalar, a list (its length
 * is disclosed, not its elements) or an empty object (`pointer is absent: <p>`; `pointer names
 * no leaf: <p> (a non-empty object: disclose its members)`); an absent one must be absent
 * (`pointer is present: <p>`).
 *
 * The tree is hashed once, as `computeInputDigest` hashes it, and every audit path comes out of
 * the same pass: the work is that of the digest. Facts come by increasing index, absences by
 * increasing pointer, whatever the order of the requests.
 */
export function discloseFacts(
  input: ProofInput,
  seed: Uint8Array,
  present: readonly JsonPointer[],
  absent: readonly JsonPointer[],
): FactDisclosure {
  return withValueBudget(() => {
    const seedBytes = readSeed(seed);
    if (seedBytes.every((byte) => byte === 0)) {
      throw newSpecError('INVALID_DISCLOSURE', 'unsalted input cannot be disclosed');
    }
    const requests = readRequests(present, absent);
    const snapshot = readValidInput(input);
    const walked = ownCopy(() => walkLeaves(snapshot, seedBytes, requests));
    return buildDisclosure(requests, walked);
  });
}

/** One request: a pointer, its decoded segments, and whether it is to be shown or disproven. */
interface Request {
  readonly pointer: string;
  readonly segments: string[];
  readonly present: boolean;
}

/** A leaf met during the walk, with its index, its segments and its salt in hex. */
interface Seen {
  readonly content: LeafContent;
  readonly segments: string[];
  readonly index: number;
  readonly salt: string;
}

/** Where a request falls among the leaves: the leaf at it, or those around it. */
interface Place {
  at?: Seen;
  before?: Seen;
  after?: Seen;
}

/** The requests of both lists, sorted by `comparePointers`, each pointer once. */
function readRequests(present: readonly string[], absent: readonly string[]): Request[] {
  const requests = [
    ...readPointers(present, 'present').map((p) => ({ ...p, present: true })),
    ...readPointers(absent, 'absent').map((p) => ({ ...p, present: false })),
  ];
  if (requests.length === 0) throw newSpecError('INVALID_DISCLOSURE', 'nothing to disclose');
  requests.sort((a, b) => compareSegments(a.segments, b.segments));
  requests.forEach((request, i) => {
    const previous = requests[i - 1];
    if (previous !== undefined && compareSegments(previous.segments, request.segments) === 0) {
      throw newSpecError(
        'INVALID_DISCLOSURE',
        `pointer requested twice: ${citeName(request.pointer)}`,
      );
    }
  });
  return requests;
}

/** The pointers of the caller's list `name`, read once, each parsed (`INVALID_PATH`). */
function readPointers(
  list: readonly string[],
  name: string,
): { pointer: string; segments: string[] }[] {
  let items: unknown[];
  try {
    if (!Array.isArray(list)) {
      throw newSpecError('INVALID_DISCLOSURE', `${name} must be an array of JSON pointers`);
    }
    const read = readList(list, name);
    if (!Array.isArray(read)) throw newSpecError('INVALID_DISCLOSURE', read.message);
    items = read;
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw newSpecError('INVALID_DISCLOSURE', unreadableMessage(name, error));
  }
  return items.map((pointer) => {
    if (typeof pointer !== 'string') {
      // As `parsePointer` refuses it; `typeName` runs no caller code.
      throw newSpecError(
        'INVALID_PATH',
        `a JSON pointer must be a string, got ${typeName(pointer)}`,
      );
    }
    return { pointer, segments: parsePointer(pointer) };
  });
}

/**
 * Walks the leaves of `snapshot` (a copy this package made) in their order, hashing each as
 * `computeInputDigest` does into one packed buffer, and finds the place of each request (sorted)
 * by merging: a request falls before the first leaf that does not come before it. Only the
 * leaves a request needs keep their salt (in hex): the salt of the previous leaf is kept in one
 * buffer until the next leaf is met.
 */
function walkLeaves(
  snapshot: ProofInput,
  seed: Uint8Array,
  requests: readonly Request[],
): { hashes: PackedHashes; places: Place[] } {
  const salter = inputSalter(seed);
  const hashLeaf = createLeafHasher();
  const hashes = new PackedHashes();
  const places: Place[] = [];
  let next = 0;
  let previous: { content: LeafContent; segments: string[]; index: number } | undefined;
  let previousSeen: Seen | undefined;
  const previousSalt = new Uint8Array(32);
  const seenBefore = (): Seen | undefined => {
    if (previous !== undefined && previousSeen === undefined) {
      previousSeen = { ...previous, salt: bytesToHex(previousSalt) };
    }
    return previousSeen;
  };
  forEachLeaf(snapshot, (leaf) => {
    const index = hashes.length;
    const salt = salter(leaf.pointer);
    hashLeaf(hashes.next(), leaf, salt);
    hashes.push();
    if (next >= requests.length) return;
    const segments = parsePointer(leaf.pointer);
    let here: Seen | undefined;
    for (let request = requests[next]; request !== undefined; request = requests[next]) {
      const order = compareSegments(request.segments, segments);
      if (order > 0) break;
      here ??= { content: leaf, segments, index, salt: bytesToHex(salt) };
      const before = seenBefore();
      places.push(order === 0 ? { at: here } : { ...(before && { before }), after: here });
      next += 1;
    }
    previous = { content: leaf, segments, index };
    previousSeen = here;
    previousSalt.set(salt);
  });
  // The requests after the last leaf: that leaf is before them.
  for (; next < requests.length; next++) {
    const before = seenBefore();
    places.push(before === undefined ? {} : { before });
  }
  return { hashes, places };
}

/** True when `a` is a strict ancestor of `b`: a proper prefix of its segments. */
function isAncestor(a: readonly string[], b: readonly string[]): boolean {
  return a.length < b.length && a.every((segment, i) => segment === b[i]);
}

/**
 * The disclosure of the requests at their `places`: a fact for each leaf shown, a proof for each
 * absence, every audit path computed in the same pass as the root.
 */
function buildDisclosure(
  requests: readonly Request[],
  walked: { hashes: PackedHashes; places: Place[] },
): FactDisclosure {
  const { hashes, places } = walked;
  const facts: Seen[] = [];
  const absences: { pointer: string; before?: Seen; after?: Seen }[] = [];
  requests.forEach((request, i) => {
    const { at, before, after } = places[i] ?? {};
    const cited = citeName(request.pointer);
    const inside = after !== undefined && isAncestor(request.segments, after.segments);
    if (request.present) {
      if (inside) {
        throw newSpecError(
          'INVALID_DISCLOSURE',
          `pointer names no leaf: ${cited} (a non-empty object: disclose its members)`,
        );
      }
      if (at === undefined) {
        throw newSpecError('INVALID_DISCLOSURE', `pointer is absent: ${cited}`);
      }
      facts.push(at);
      return;
    }
    if (at !== undefined || inside) {
      throw newSpecError('INVALID_DISCLOSURE', `pointer is present: ${cited}`);
    }
    const scalarAbove =
      before?.content.kind === 'value' && isAncestor(before.segments, request.segments);
    absences.push({
      pointer: request.pointer,
      ...(before && { before }),
      ...(after && !scalarAbove && { after }),
    });
  });
  const shown = [...facts, ...absences.flatMap((a) => [a.before, a.after])];
  const indices = [...new Set(shown.flatMap((seen) => (seen ? [seen.index] : [])))];
  const size = hashes.length;
  const { paths, root } = hashes.pathsAndRoot(indices);
  const pathOf = new Map(indices.map((index, k) => [index, (paths[k] ?? []).map(bytesToHex)]));
  const disclosed = (seen: Seen): DisclosedLeaf => ({
    ...seen.content,
    salt: seen.salt,
    index: seen.index,
    path: [...(pathOf.get(seen.index) ?? [])],
  });
  return {
    format: DISCLOSURE_FORMAT,
    inputDigest: bytesToHex(inputDigestOf(size, root)),
    size,
    facts: facts.sort((a, b) => a.index - b.index).map(disclosed),
    absent: absences.map(({ pointer, before, after }) => ({
      pointer,
      ...(before && { before: disclosed(before) }),
      ...(after && { after: disclosed(after) }),
    })),
  };
}

/**
 * Verifies a fact disclosure (`discloseFacts`) against the input digest `inputDigest`
 * (`computeInputDigest`), and never throws: anything malformed gives `valid: false`.
 *
 * 1. The shape. `d` is read once (each property read and counted once, as `MAX_JSON_VALUES`
 *    counts them) into a plain copy, and every later check runs on that copy: a closed object
 *    `{ format, inputDigest, size, facts, absent }`; `format` `run-iq.disclosure/1` (another one
 *    gives the single issue `unknown format: <format>`); `inputDigest` 64 lowercase hex
 *    characters; `size` an integer from 0 to 10 000 000; not more facts than leaves (checked
 *    before any is read); each disclosed leaf a closed object whose `index` is below `size` and
 *    whose `path` holds exactly the hashes of the audit path of (`index`, `size`) (its length
 *    checked before any element is read); each absence `{ pointer, before?, after? }`.
 * 2. `input digest mismatch` unless `d.inputDigest` is `inputDigest`; `nothing disclosed` for a
 *    disclosure without fact or absence.
 * 3. Each disclosed leaf, hashed as `inputLeafHash` hashes it (a leaf no valid input has is
 *    refused: `<path>: invalid input leaf: <why>`), must be in the tree at its index:
 *    `leaf not in tree: <pointer>` otherwise.
 * 4. Facts by increasing index and absences by increasing pointer (`comparePointers`), each
 *    once.
 * 5. Each absence: `absence not proven: <pointer> (<why>)` unless its neighbours frame it as
 *    the format says (`AbsenceProof`); with no neighbour, only the empty tree proves it.
 * 6. What the disclosed leaves contradict: `leaves out of order: …`, `leaf inside a scalar: …`,
 *    `leaf inside an empty object: …`, `leaf outside its list: …`, `absent pointer is present:
 *    …`. An absence still assumes a tree sorted honestly by its signer (D-15).
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

/** A disclosed leaf as read: its leaf (plain primitives only), index, path, and where it is. */
interface LeafCopy {
  readonly at: string;
  readonly leaf: InputLeaf;
  readonly index: number;
  readonly path: string[];
}

/** An absence as read. */
interface AbsenceCopy {
  readonly at: string;
  readonly pointer: string;
  readonly segments: string[];
  readonly before?: LeafCopy;
  readonly after?: LeafCopy;
}

/** A disclosure as read: every field checked for its shape. */
interface DisclosureCopy {
  readonly inputDigest: string;
  readonly size: number;
  readonly facts: LeafCopy[];
  readonly absent: AbsenceCopy[];
}

const DISCLOSURE_KEYS: readonly string[] = ['format', 'inputDigest', 'size', 'facts', 'absent'];
const LEAF_KEYS: readonly string[] = [
  'pointer',
  'kind',
  'value',
  'length',
  'salt',
  'index',
  'path',
];
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
  checkAbsences(read, inputDigest, verified, problems);
  checkContradictions(verified, read.absent, problems);
  if (problems.length > 0) return refusedWith(problems.messages());
  return {
    valid: true,
    issues: [],
    ...factsOf(read.facts),
    absent: read.absent.map((entry) => entry.pointer),
  };
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
    ? readCopies('/facts', field('facts'), reader, size, (item, at) =>
        readLeafCopy(item, at, size, reader),
      )
    : undefined;
  const absent = fields.values.has('absent')
    ? readCopies('/absent', field('absent'), reader, undefined, (item, at) =>
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
 * is read and counted; `undefined` after reporting a problem with the list itself.
 */
function readCopies<T>(
  path: string,
  value: unknown,
  reader: Reader,
  max: number | undefined,
  readItem: (item: unknown, at: string) => T | undefined,
): T[] | undefined {
  const read = readLength(value, path, reader);
  if (read === undefined) return undefined;
  const { list, length } = read;
  if (max !== undefined && length > max) {
    reader.add(path, `${path} holds ${length} leaves, more than the size of the tree (${max})`);
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

/** Copies a disclosed leaf at `at`, read once; its values primitives only, never a caller's. */
function readLeafCopy(
  value: unknown,
  at: string,
  size: number | undefined,
  reader: Reader,
): LeafCopy | undefined {
  const { add } = reader;
  const shape = 'an object { pointer, kind, value or length, salt, index, path }';
  if (!expectPlainObject(value, at, shape, add)) return undefined;
  const fields = readFields(value, at, at, LEAF_KEYS, reader);
  if (fields === undefined) return undefined;
  requireFields(fields, at, ['pointer', 'kind', 'salt', 'index', 'path'], add);
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
  if (kind !== undefined && !isLeafKind(kind)) {
    add(`${at}/kind`, `${at}/kind must be one of value, array, object`);
  }
  const scalar = fields.values.get('value');
  if (has('value') && !isScalar(scalar)) add(`${at}/value`, `${at}/value must be a JSON scalar`);
  const length = fields.values.get('length');
  if (has('length') && typeof length !== 'number') {
    add(`${at}/length`, `${at}/length must be a number`);
  }
  const rawIndex = fields.values.get('index');
  const index = isCount(rawIndex, size === undefined ? MAX_JSON_VALUES : size - 1)
    ? rawIndex
    : undefined;
  if (has('index') && index === undefined) {
    add(
      `${at}/index`,
      size === undefined
        ? `${at}/index must be an integer from 0`
        : `${at}/index must be an integer below the size of the tree (${size})`,
    );
  }
  const path = has('path')
    ? readAuditPath(fields.values.get('path'), `${at}/path`, reader, index, size)
    : undefined;
  if (reader.issues.length > 0 || path === undefined || index === undefined) return undefined;
  if (pointer === undefined || salt === undefined || kind === undefined || !isLeafKind(kind)) {
    return undefined;
  }
  const leaf: InputLeaf = {
    pointer,
    kind,
    // -0 has no JSON form: a leaf holds 0 (`inputLeafHash` reads it so).
    ...(isScalar(scalar) && { value: Object.is(scalar, -0) ? 0 : scalar }),
    ...(typeof length === 'number' && { length }),
    salt,
  };
  return { at, leaf, index, path };
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
  const pointer = fields.values.get('pointer');
  let segments: string[] | undefined;
  if (fields.values.has('pointer')) {
    if (typeof pointer !== 'string') add(`${at}/pointer`, `${at}/pointer must be a string`);
    else {
      try {
        segments = parsePointer(pointer);
      } catch (error) {
        add(`${at}/pointer`, `${at}/pointer: ${reasonOf(error)}`);
      }
    }
  }
  const neighbour = (key: string): LeafCopy | undefined | 'failed' => {
    if (!fields.values.has(key)) return undefined;
    return readLeafCopy(fields.values.get(key), `${at}/${key}`, size, reader) ?? 'failed';
  };
  const before = neighbour('before');
  const after = neighbour('after');
  if (typeof pointer !== 'string' || segments === undefined) return undefined;
  if (before === 'failed' || after === 'failed') return undefined;
  return { at, pointer, segments, ...(before && { before }), ...(after && { after }) };
}

/** Each disclosed leaf of `copy`, facts first, then the neighbours of each absence in order. */
function leavesOf(copy: DisclosureCopy): LeafCopy[] {
  return [...copy.facts, ...copy.absent.flatMap((entry) => [entry.before, entry.after])].flatMap(
    (leaf) => (leaf ? [leaf] : []),
  );
}

/**
 * Lists the problems of the disclosed leaves (one a valid input cannot have, one not in the
 * tree), and returns the leaves in the tree with their decoded segments, by increasing index,
 * each index once (two leaves in the tree at one index have one hash: they are the same leaf).
 * Every check below stops once `problems` is full.
 */
function checkLeaves(copy: DisclosureCopy, inputDigest: string, problems: IssueList): Verified[] {
  const byIndex = new Map<number, Verified>();
  for (const leaf of leavesOf(copy)) {
    if (problems.full) break;
    const problem = leafProblem(leaf, copy.size, inputDigest);
    if (problem !== undefined) problems.add('', problem);
    else if (!byIndex.has(leaf.index)) {
      byIndex.set(leaf.index, { ...leaf, segments: parsePointer(leaf.leaf.pointer) });
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/** Why `leaf` is not the leaf at its index of the tree of `inputDigest`, or `undefined`. */
function leafProblem(leaf: LeafCopy, size: number, inputDigest: string): string | undefined {
  let hash: Uint8Array;
  try {
    // The copy holds primitives only: hashing it reads no value of the caller.
    hash = ownCopy(() => inputLeafHash(leaf.leaf));
  } catch (error) {
    return `${leaf.at}: ${reasonOf(error)}`;
  }
  const path = leaf.path.map((hex) => hexToBytes(hex));
  return verifyInputInclusion(inputDigest, size, leaf.index, hash, path)
    ? undefined
    : `leaf not in tree: ${citeName(leaf.leaf.pointer)}`;
}

/** Facts by strictly increasing index, absences by strictly increasing pointer. */
function checkOrder(copy: DisclosureCopy, problems: IssueList): void {
  copy.facts.forEach((fact, i) => {
    const previous = copy.facts[i - 1];
    if (previous !== undefined && previous.index >= fact.index) {
      problems.add(
        '',
        `${fact.at} does not follow ${previous.at}: facts are listed by increasing index`,
      );
    }
  });
  copy.absent.forEach((entry, i) => {
    const previous = copy.absent[i - 1];
    if (problems.full || previous === undefined) return;
    if (compareSegments(previous.segments, entry.segments) >= 0) {
      problems.add(
        '',
        `${entry.at} does not follow ${previous.at}: absences are listed by increasing pointer`,
      );
    }
  });
}

/**
 * Lists why each absence whose neighbours are in the tree does not prove its pointer absent
 * (D-15); an absence with a neighbour not in the tree is already refused for it.
 */
function checkAbsences(
  copy: DisclosureCopy,
  inputDigest: string,
  verified: readonly Verified[],
  problems: IssueList,
): void {
  const segmentsAt = new Map(verified.map((leaf) => [leaf.index, leaf.segments]));
  for (const entry of copy.absent) {
    if (problems.full) return;
    const { before, after } = entry;
    const beforeSegments = before && segmentsAt.get(before.index);
    const afterSegments = after && segmentsAt.get(after.index);
    if ((before && !beforeSegments) || (after && !afterSegments)) continue;
    const reasons = absenceReasons(entry, copy.size, inputDigest, beforeSegments, afterSegments);
    const cited = citeName(entry.pointer);
    for (const reason of reasons) problems.add('', `absence not proven: ${cited} (${reason})`);
  }
}

/** Why `entry`, its neighbours of these segments, does not prove its pointer absent. */
function absenceReasons(
  entry: AbsenceCopy,
  size: number,
  inputDigest: string,
  beforeSegments: readonly string[] | undefined,
  afterSegments: readonly string[] | undefined,
): string[] {
  const { before, after, segments } = entry;
  const reasons: string[] = [];
  if (beforeSegments && compareSegments(beforeSegments, segments) >= 0) {
    reasons.push('the before leaf does not come before it');
  }
  if (afterSegments && compareSegments(afterSegments, segments) <= 0) {
    reasons.push('the after leaf does not come after it');
  } else if (afterSegments && isAncestor(segments, afterSegments)) {
    reasons.push('the after leaf is inside it');
  }
  if (before && after) {
    if (after.index !== before.index + 1) {
      reasons.push('the before and after leaves are not adjacent');
    }
  } else if (before && beforeSegments) {
    const scalarAbove = before.leaf.kind === 'value' && isAncestor(beforeSegments, segments);
    if (!scalarAbove && before.index !== size - 1) {
      reasons.push('the before leaf is not the last leaf');
    }
  } else if (after) {
    if (after.index !== 0) reasons.push('the after leaf is not the first leaf');
  } else if (size !== 0 || inputDigest !== emptyTreeDigest()) {
    reasons.push('no neighbour leaf, and the tree is not empty');
  }
  return reasons;
}

/** The digest of the empty tree: `computeInputDigest` of no leaf (D-15). */
function emptyTreeDigest(): string {
  return bytesToHex(inputDigestOf(0, sha256(new Uint8Array(0))));
}

/** A verified leaf with its decoded segments. */
type Verified = LeafCopy & { segments: string[] };

/** An item of the sweep of `checkContradictions`: an absence or a verified leaf. */
type Item = { absence: AbsenceCopy; leaf?: undefined } | { leaf: Verified; absence?: undefined };

/**
 * Lists what the verified leaves (sorted by index) and the absences contradict. The leaves
 * must come in the order of their indices. Then leaves and absences are swept in pointer order
 * (an absence before a leaf at the same pointer) with the stack of their ancestors: a leaf below
 * an absence, a scalar or an empty object, an element outside its list (its index not below the
 * length of the nearest list above it), or an absence naming an element of a disclosed list, is
 * refused. Each ancestor test stops at the first differing segment: the work follows the
 * segments swept.
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
        `leaves out of order: ${citeName(previous.leaf.pointer)} (leaf ${previous.index}) ` +
          `does not come before ${citeName(leaf.leaf.pointer)} (leaf ${leaf.index})`,
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
    return top.absence !== undefined
      ? a.length <= b.length && a.every((segment, i) => segment === b[i])
      : isAncestor(a, b);
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
          `(leaf ${citeName(item.leaf.leaf.pointer)})`;
  }
  const above = top.leaf;
  if (above === undefined) return undefined;
  const cited = citeName(item.leaf ? item.leaf.leaf.pointer : (item.absence?.pointer ?? ''));
  const parent = citeName(above.leaf.pointer);
  if (item.leaf !== undefined) {
    if (above.leaf.kind === 'value') return `leaf inside a scalar: ${cited} (inside ${parent})`;
    if (above.leaf.kind === 'object') {
      return `leaf inside an empty object: ${cited} (inside ${parent})`;
    }
  }
  if (above.leaf.kind !== 'array') return undefined;
  const length = above.leaf.length ?? 0;
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

/** The verified facts: the value of each scalar, `{}` for an empty object, each list's length. */
function factsOf(facts: readonly LeafCopy[]): Pick<FactDisclosureVerification, 'facts' | 'lists'> {
  const values: Record<JsonPointer, JsonValue> = {};
  const lists: Record<JsonPointer, number> = {};
  for (const { leaf } of facts) {
    // Pointers start with `/`: no key of the prototype can be one.
    if (leaf.kind === 'array') lists[leaf.pointer] = leaf.length ?? 0;
    else values[leaf.pointer] = leaf.kind === 'object' ? {} : (leaf.value ?? null);
  }
  return { facts: values, lists };
}
