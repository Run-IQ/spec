import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { JsonValue } from '../canonical.js';
import { citeName, newSpecError, unreadableMessage } from '../errors.js';
import { createHasherInto, PackedHashes, rootFromPath } from '../merkle.js';
import { parsePointer } from '../path/pointer.js';
import type { JsonPointer } from '../path/pointer.js';
import type { ProofInput } from './types.js';
import {
  hasLoneSurrogate,
  loneSurrogateMessage,
  MAX_JSON_VALUES,
  ownCopy,
  withValueBudget,
} from '../values.js';
import { withSha256, writeJsonString } from '../stream.js';
import type { TextOut } from '../stream.js';
import { forEachLeaf } from './leaves.js';
import type { JsonScalar, LeafContent } from './leaves.js';
import { expectPlainObject, readFields, requireFields, runCheck } from './read.js';
import type { Reader } from './read.js';
import { inputSalter, readSeed } from './seed.js';
import { leafPlace } from './place.js';
import type { LeafKind, LeafPlace } from './place.js';
import { readValidInput } from './validate.js';

/**
 * The domain tag of the input tree (D-15): every leaf hash starts with
 * `0x00 ‖ utf8('run-iq.input/1') ‖ 0x00`, and the digest with `0x02 ‖ utf8('run-iq.input/1') ‖
 * 0x00`, so neither can be taken for a node of the tree (`0x01 ‖ …`) nor for the leaf or the
 * digest of another tree.
 */
export const INPUT_TREE_TAG = 'run-iq.input/1';

/**
 * One leaf of the input tree (D-15): a scalar (`kind: 'value'`, with its `value`, `null`
 * included), a list (`kind: 'array'`, with its `length`; its elements have their own leaves) or
 * an empty object (`kind: 'object'`) of a `ProofInput`, at its `pointer` (`/data/…`,
 * `/meta/…`), with its `salt`: `HMAC-SHA256(seed, utf8('input:' + pointer))` in lowercase hex.
 * A non-empty object has no leaf: its descendants imply it.
 */
export interface InputLeaf {
  pointer: JsonPointer;
  kind: 'value' | 'array' | 'object';
  value?: JsonValue;
  length?: number;
  salt: string;
}

/** The start of the input digest: `0x02 ‖ utf8(INPUT_TREE_TAG) ‖ 0x00`. */
const DIGEST_PREFIX = Uint8Array.from([2, ...utf8ToBytes(INPUT_TREE_TAG), 0]);
/** A digest as `computeInputDigest` writes it. */
const DIGEST_HEX = /^[0-9a-f]{64}$/;

/** The fixed start of every leaf hash: `0x00 ‖ utf8(INPUT_TREE_TAG) ‖ 0x00`. */
const LEAF_PREFIX = Uint8Array.from([0, ...utf8ToBytes(INPUT_TREE_TAG), 0]);

/**
 * The leaves of `input` under `seed` (D-14, D-15), sorted by `comparePointers`: decoded
 * segments compared in UTF-16 code units, a pointer before its descendants, so list indices
 * compare as texts (`/data/l/10` before `/data/l/2`). A value shared by several paths has its
 * leaves on each. Every leaf has its own salt, under `UNSALTED_SEED` too (then public).
 *
 * `seed` is checked first, then `input`, read once and checked as `validateProofInput`
 * checks it. Throws `SpecError`: `INVALID_KEY` for a seed that is not a `Uint8Array` of
 * 32 bytes (`the input seed must be a Uint8Array of 32 bytes, got …`), then `INVALID_INPUT`
 * (`invalid input: <first problem>`, the problem's path as `path`) for an input it refuses.
 */
export function inputLeaves(input: ProofInput, seed: Uint8Array): InputLeaf[] {
  return withValueBudget(() => {
    const salt = inputSalter(readSeed(seed));
    const snapshot = readValidInput(input);
    const leaves: InputLeaf[] = [];
    ownCopy(() =>
      forEachLeaf(snapshot, (leaf) => {
        leaves.push({ ...leaf, salt: bytesToHex(salt(leaf.pointer)) });
      }),
    );
    return leaves;
  });
}

/**
 * The hash of one input leaf (D-15), 32 bytes: `sha256(0x00 ‖ utf8('run-iq.input/1') ‖ 0x00
 * ‖ salt (32 raw bytes) ‖ utf8(canonicalize(c)))`, where `c` is `[pointer, 'value', value]`,
 * `[pointer, 'array', length]` or `[pointer, 'object']`, hashed as it is written (a value of
 * any length).
 *
 * `leaf` is read once: a plain object with exactly the members of its kind, `salt` 64 lowercase
 * hex characters. It is refused unless a valid input can hold such a leaf, judged by the leaf
 * alone (its siblings, their order and their share of the budgets are not known here):
 * - `pointer` is a JSON pointer below `/data` or `/meta` naming a place that holds a leaf in
 *   some valid input (`/meta` itself, `/meta/foo`, `/data/$x`, an assertion, anything below a
 *   string of `meta`, anything more than `MAX_JSON_DEPTH` (1000) levels below `/data` or
 *   `/meta/context`: never; a list exactly 1000 levels below them holds nothing), at most
 *   `MAX_INPUT_LEAF_TEXT` less the shortest pointers of the other parts of an input (`/data`,
 *   `/meta/tenantId`, `/meta/dates`, `/meta/tags`, `/meta/dimensions`, `/meta/context`,
 *   `/meta/assertions`) code units;
 * - `kind` is one a leaf there has (`/data` and an empty part of `meta`: `object`; `/meta/tags`:
 *   `array`; `/meta/tenantId`, a date, a tag, an assertion field: `value`; a dimension: `value`
 *   or `array`; anything below `/data/<key>` or `/meta/context`: any);
 * - `value` is a JSON scalar as an input holds it (no lone surrogate, a finite number below 2^53
 *   in absolute value) and what that place holds (a non-empty string for `tenantId` and a tag,
 *   a date as `validateProofInput` accepts one, a dimension value, the value of that assertion
 *   field);
 * - `length` is an integer from 0 (2 for a list of dimension values) to `MAX_JSON_VALUES` less
 *   the values every input holds (`data`, `meta` and its six members) and those above the list.
 *
 * Throws `SpecError` (`INVALID_INPUT`, `invalid input leaf: <first problem>`, its path in the
 * leaf as `path`); a place no valid input has a leaf at is `/pointer names no leaf of a valid
 * input: <why>`. The rule is `leafPlace` (src/input/place.ts).
 */
export function inputLeafHash(leaf: InputLeaf): Uint8Array {
  return withValueBudget(() => {
    const { content, salt } = readLeaf(leaf);
    const out = new Uint8Array(32);
    createLeafHasher()(out, content, hexToBytes(salt));
    return out;
  });
}

/**
 * Internal: the input digest of `input` under `seed`, 32 bytes (D-15: the leaf count and the
 * RFC 6962 root, `inputDigestOf`), with the checks and errors of `inputLeaves`. Hashes as it
 * walks, into one packed buffer: no leaf object is kept.
 */
export function inputDigestBytes(input: ProofInput, seed: Uint8Array): Uint8Array {
  const salt = inputSalter(readSeed(seed));
  const snapshot = readValidInput(input);
  const hashLeaf = createLeafHasher();
  const hashes = new PackedHashes();
  ownCopy(() =>
    forEachLeaf(snapshot, (leaf) => {
      hashLeaf(hashes.next(), leaf, salt(leaf.pointer));
      hashes.push();
    }),
  );
  return inputDigestOf(hashes.length, hashes.root());
}

/**
 * Internal: the input digest of a tree of `size` leaves (a safe integer) whose RFC 6962 root is
 * `root` (D-15):
 * `sha256(0x02 ‖ utf8('run-iq.input/1') ‖ 0x00 ‖ uint64be(size) ‖ root)`. The prefix `0x02`
 * sets it apart from a leaf (`0x00`) and a node (`0x01`); the count makes the digest commit to
 * the size of the tree, which an RFC 6962 root alone does not.
 */
export function inputDigestOf(size: number, root: Uint8Array): Uint8Array {
  const count = new Uint8Array(8);
  const view = new DataView(count.buffer);
  // `size` is a safe integer: its high and low 32 bits, big-endian.
  view.setUint32(0, Math.floor(size / 2 ** 32));
  view.setUint32(4, size % 2 ** 32);
  const out = new Uint8Array(32);
  createHasherInto()(out, DIGEST_PREFIX, count, root);
  return out;
}

/**
 * True when `path` proves that `leafHash` (`inputLeafHash`) is the leaf at `index` of the input
 * tree of `size` leaves whose digest is `digest` (`computeInputDigest`): the RFC 6962 root
 * rebuilt from the leaf and its audit path (`inclusionPath`, as `verifyInclusion` checks it),
 * committed with `size`, gives `digest`. Since the digest commits to the leaf count, a leaf
 * cannot be shown under another size (leaf 4 of 7 does not verify as leaf 4 of 8).
 *
 * Never throws: false for anything else, in particular a `digest` that is not 64 lowercase hex
 * characters, and every case where `verifyInclusion` is false (`size` not an integer from 1 to
 * 2^53 - 1, `index` not below it, a hash that is not 32 bytes, a path of another length, its
 * length checked before any element is read).
 */
export function verifyInputInclusion(
  digest: string,
  size: number,
  index: number,
  leafHash: Uint8Array,
  path: readonly Uint8Array[],
): boolean {
  const expected: unknown = digest;
  if (typeof expected !== 'string' || !DIGEST_HEX.test(expected)) return false;
  const root = rootFromPath(leafHash, index, size, path);
  return root !== undefined && bytesToHex(inputDigestOf(size, root)) === expected;
}

/**
 * Writes the JSON text of a leaf's content `c` (D-15): `[pointer, kind]`, then its value or
 * length. Exactly `canonicalize(c)`: a three-member list of scalars, each written as
 * `canonicalize` writes a scalar (a number by `String`, a string as `JSON.stringify` escapes it,
 * slice by slice), without spaces; written piece by piece, never built whole.
 */
function writeContent(out: TextOut, content: LeafContent): void {
  out.text('[');
  writeJsonString(out, content.pointer);
  out.text(`,"${content.kind}"`);
  if (content.kind !== 'object') {
    const last = content.kind === 'array' ? content.length : content.value;
    out.text(',');
    if (typeof last === 'string') writeJsonString(out, last);
    else out.text(last === null ? 'null' : String(last));
  }
  out.text(']');
}

/**
 * The hash of a leaf from its content and its raw salt (D-15), written into `out`, through the
 * shared hash stream (`withSha256`): the content is hashed as it is written.
 */
function createLeafHasher(): (out: Uint8Array, content: LeafContent, salt: Uint8Array) => void {
  return (out, content, salt) => {
    const hash = withSha256((stream) => {
      stream.bytes(LEAF_PREFIX);
      stream.bytes(salt);
      writeContent(stream, content);
    });
    out.set(hash);
  };
}

const LEAF_KEYS: readonly string[] = ['pointer', 'kind', 'value', 'length', 'salt'];
const KINDS: readonly string[] = ['value', 'array', 'object'];
const SALT_HEX = /^[0-9a-f]{64}$/;

/** The content and the salt of a caller's leaf, or a thrown `SpecError` (`INVALID_INPUT`). */
function readLeaf(value: unknown): { content: LeafContent; salt: string } {
  let read: { content: LeafContent; salt: string } | undefined;
  const { issues } = runCheck(
    (reader) => {
      read = readLeafFields(value, reader);
    },
    (error) => ({ path: '', message: unreadableMessage('input leaf', error) }),
  );
  const [first] = issues;
  if (first !== undefined || read === undefined) {
    throw newSpecError(
      'INVALID_INPUT',
      `invalid input leaf: ${first?.message ?? 'unreadable'}`,
      first?.path,
    );
  }
  return read;
}

function readLeafFields(
  value: unknown,
  reader: Reader,
): { content: LeafContent; salt: string } | undefined {
  const { add } = reader;
  if (!expectPlainObject(value, '', 'a plain object', add, 'an input leaf')) return undefined;
  const fields = readFields(value, '', 'input leaf', LEAF_KEYS, reader);
  if (fields === undefined) return undefined;
  requireFields(fields, '', ['pointer', 'kind', 'salt'], add);
  const has = (key: string): boolean => fields.values.has(key);
  const located = has('pointer') ? readLeafPointer(fields.values.get('pointer'), add) : undefined;
  const at = located?.place;
  const kind = fields.values.get('kind');
  if (has('kind') && !isKind(kind)) add('/kind', `/kind must be one of ${KINDS.join(', ')}`);
  else if (isKind(kind) && at !== undefined && !at.kinds.includes(kind)) {
    add('/kind', `/kind must be ${at.kinds.join(' or ')} at this pointer`);
  }
  const pointer = located?.pointer;
  let content: LeafContent | undefined;
  if (kind === 'value') {
    if (has('length')) add('/length', '/length is only for a leaf of kind array');
    if (!has('value')) add('/value', '/value is required');
    else {
      const scalar = readScalar(fields.values.get('value'), add);
      const problem = scalar === undefined || at === undefined ? undefined : at.value(scalar.value);
      if (problem !== undefined) add('/value', problem);
      else if (pointer !== undefined && scalar !== undefined) {
        content = { pointer, kind, value: scalar.value };
      }
    }
  } else if (kind === 'array' || kind === 'object') {
    if (has('value')) add('/value', '/value is only for a leaf of kind value');
    if (kind === 'object') {
      if (has('length')) add('/length', '/length is only for a leaf of kind array');
      if (pointer !== undefined) content = { pointer, kind };
    } else if (!has('length')) add('/length', '/length is required');
    else {
      const length = fields.values.get('length');
      const min = at?.minLength ?? 0;
      const max = at?.maxLength ?? MAX_JSON_VALUES;
      if (
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < min ||
        length > max
      ) {
        add('/length', `/length must be an integer from ${min} to ${max}`);
      } else if (pointer !== undefined) content = { pointer, kind, length };
    }
  }
  const salt = fields.values.get('salt');
  if (has('salt') && (typeof salt !== 'string' || !SALT_HEX.test(salt))) {
    add('/salt', '/salt must be 64 lowercase hex characters');
  }
  if (content === undefined || typeof salt !== 'string' || reader.issues.length > 0) {
    return undefined;
  }
  return { content, salt };
}

function isKind(value: unknown): value is LeafKind {
  return typeof value === 'string' && KINDS.includes(value);
}

/**
 * The leaf's pointer and its place when a valid input can have a leaf there (`leafPlace`);
 * reports it otherwise: not a JSON pointer below `/data` or `/meta`, a place no valid input has
 * a leaf at (`/pointer names no leaf of a valid input: <why>`), or longer than a leaf there can
 * be.
 */
function readLeafPointer(
  value: unknown,
  add: (path: string, message: string) => void,
): { pointer: string; place: LeafPlace } | undefined {
  const invalid = '/pointer must be a JSON pointer below /data or /meta';
  if (typeof value !== 'string') {
    add('/pointer', invalid);
    return undefined;
  }
  let segments: string[];
  try {
    segments = parsePointer(value);
  } catch {
    add('/pointer', invalid);
    return undefined;
  }
  const [head] = segments;
  if (head !== 'data' && head !== 'meta') {
    add('/pointer', invalid);
    return undefined;
  }
  const place = leafPlace(segments);
  if (typeof place === 'string') {
    add('/pointer', `/pointer names no leaf of a valid input: ${place}`);
    return undefined;
  }
  if (value.length > place.maxPointer) {
    add('/pointer', `/pointer is longer than ${place.maxPointer} code units`);
    return undefined;
  }
  return { pointer: value, place };
}

/** The leaf's value when it is a JSON scalar as an input holds it; reports it otherwise. */
function readScalar(
  value: unknown,
  add: (path: string, message: string) => void,
): { value: JsonScalar } | undefined {
  const path = '/value';
  if (value === null || typeof value === 'boolean') return { value };
  if (typeof value === 'string') {
    if (!hasLoneSurrogate(value)) return { value };
    add(path, loneSurrogateMessage(path));
    return undefined;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) add(path, `${path} is not JSON: ${String(value)}`);
    else if (Math.abs(value) >= 2 ** 53) add(path, `number beyond 2^53 at ${citeName(path)}`);
    else return { value: Object.is(value, -0) ? 0 : value };
    return undefined;
  }
  add(path, `${path} must be a JSON scalar`);
  return undefined;
}
