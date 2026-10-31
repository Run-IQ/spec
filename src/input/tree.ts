import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { JsonValue } from '../canonical.js';
import { citeName, newSpecError, unreadableMessage } from '../errors.js';
import { createHasherInto, PackedHashes } from '../merkle.js';
import { parsePointer } from '../path/pointer.js';
import type { JsonPointer } from '../path/pointer.js';
import type { ProofInput } from './types.js';
import {
  hasLoneSurrogate,
  loneSurrogateMessage,
  MAX_INPUT_POINTER_TEXT,
  MAX_JSON_VALUES,
  ownCopy,
  withValueBudget,
} from '../values.js';
import { Utf8Writer } from '../utf8.js';
import { forEachLeaf } from './leaves.js';
import type { JsonScalar, LeafContent } from './leaves.js';
import { expectPlainObject, readFields, requireFields, runCheck } from './read.js';
import type { Reader } from './read.js';
import { inputSalter, readSeed } from './seed.js';
import { readValidInput } from './validate.js';

/**
 * The domain tag of the input tree (D-15): every leaf hash starts with
 * `0x00 ‖ utf8('run-iq.input/1') ‖ 0x00`, so it can be taken neither for a node of the tree
 * (`0x01 ‖ …`) nor for the leaf of another tree.
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

/** The fixed start of every leaf hash: `0x00 ‖ utf8(INPUT_TREE_TAG) ‖ 0x00`. */
const LEAF_PREFIX = Uint8Array.from([0, ...utf8ToBytes(INPUT_TREE_TAG), 0]);

/** The leaves the last digest of an input hashed (`lastInputLeafCount`). */
let lastLeafCount = 0;

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
 * `[pointer, 'array', length]` or `[pointer, 'object']`.
 *
 * `leaf` is read once, and refused unless some valid input could have it: a plain object with
 * exactly the members of its kind; `pointer` a JSON pointer below `/data` or `/meta`, at most
 * `MAX_INPUT_POINTER_TEXT` code units; `value` a JSON scalar as an input holds it (no lone
 * surrogate, a finite number below 2^53 in absolute value); `length` an integer from 0 to
 * `MAX_JSON_VALUES`; `salt` 64 lowercase hex characters. Throws `SpecError`
 * (`INVALID_INPUT`, `invalid input leaf: <first problem>`, its path in the leaf as `path`).
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
 * Internal: the RFC 6962 root of the input tree of `input` under `seed`, with the checks and
 * errors of `inputLeaves`. Hashes as it walks, into one packed buffer: no leaf object is kept.
 */
export function inputRoot(input: ProofInput, seed: Uint8Array): Uint8Array {
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
  lastLeafCount = hashes.length;
  return hashes.root();
}

/** Internal, for tests: the leaves the last `inputRoot` hashed. */
export function lastInputLeafCount(): number {
  return lastLeafCount;
}

/**
 * The JSON text of a leaf's content `c` (D-15): `[pointer, kind]`, then its value or length.
 * Exactly `canonicalize(c)`: a three-member list of scalars, each written as `canonicalize`
 * writes a scalar (a number by `String`, any other scalar by `JSON.stringify`), without spaces.
 */
function contentText(content: LeafContent): string {
  const head = `[${JSON.stringify(content.pointer)},"${content.kind}"`;
  if (content.kind === 'object') return `${head}]`;
  const last = content.kind === 'array' ? content.length : content.value;
  return `${head},${typeof last === 'number' ? String(last) : JSON.stringify(last)}]`;
}

/**
 * The hash of a leaf from its content and its raw salt (D-15), written into `out`, reusing one
 * hasher.
 */
function createLeafHasher(): (out: Uint8Array, content: LeafContent, salt: Uint8Array) => void {
  const hashInto = createHasherInto();
  const writer = new Utf8Writer();
  return (out, content, salt) => {
    hashInto(out, LEAF_PREFIX, salt, writer.encode(contentText(content)));
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
  const pointer = readLeafPointer(fields.values.get('pointer'), fields.values.has('pointer'), add);
  const kind = fields.values.get('kind');
  if (fields.values.has('kind') && (typeof kind !== 'string' || !KINDS.includes(kind))) {
    add('/kind', `/kind must be one of ${KINDS.join(', ')}`);
  }
  const has = (key: string): boolean => fields.values.has(key);
  let content: LeafContent | undefined;
  if (kind === 'value') {
    if (has('length')) add('/length', '/length is only for a leaf of kind array');
    if (!has('value')) add('/value', '/value is required');
    else {
      const scalar = readScalar(fields.values.get('value'), add);
      if (pointer !== undefined && scalar !== undefined) {
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
      if (
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_JSON_VALUES
      ) {
        add('/length', `/length must be an integer from 0 to ${MAX_JSON_VALUES}`);
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

/** The leaf's pointer when it can be one of an input's leaves; reports it otherwise. */
function readLeafPointer(
  value: unknown,
  present: boolean,
  add: (path: string, message: string) => void,
): string | undefined {
  if (!present) return undefined;
  const invalid = '/pointer must be a JSON pointer below /data or /meta';
  if (typeof value !== 'string') {
    add('/pointer', invalid);
    return undefined;
  }
  if (value.length > MAX_INPUT_POINTER_TEXT) {
    add('/pointer', `/pointer is longer than ${MAX_INPUT_POINTER_TEXT} code units`);
    return undefined;
  }
  let head: string | undefined;
  try {
    [head] = parsePointer(value);
  } catch {
    head = undefined;
  }
  if (head !== 'data' && head !== 'meta') {
    add('/pointer', invalid);
    return undefined;
  }
  return value;
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
