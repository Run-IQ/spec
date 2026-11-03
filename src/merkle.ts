import { sha256 } from '@noble/hashes/sha2.js';
import { isOwnError, newSpecError, unreadableMessage } from './errors.js';
import { hashWork } from './stream.js';
import {
  bytesOf,
  copyBytesInto,
  holeMessage,
  spendValues,
  tooLargeMessage,
  typeName,
  undefinedMessage,
  withValueBudget,
} from './values.js';
import {
  NativeDataView,
  NativeMap,
  NativeString,
  NativeUint8Array,
  arrayForEach,
  arrayIsArray,
  arrayMap,
  arrayPush,
  dataViewSetUint32,
  mapGet,
  mapSet,
  mathFloor,
  mathMax,
  numberIsSafeInteger,
  uint8ArrayBuffer,
  uint8ArrayEvery,
  uint8ArrayFrom,
  uint8ArrayLength,
  uint8ArrayOf,
  uint8ArraySet,
  uint8ArraySlice,
  uint8ArraySubarray,
} from './intrinsics.js';

/**
 * Merkle trees as RFC 6962 (section 2.1) defines them, shared by the input digest (D-15) and
 * the proof digest (D-16). The hash of an empty tree is the sha256 of nothing; the hash of a
 * one-leaf tree is that leaf; a larger tree of n leaves is split at k, the largest power of two
 * strictly below n, and its hash is `sha256(0x01 ‖ hash(first k) ‖ hash(the rest))`. A leaf is
 * a 32-byte hash computed by its owner, under its own domain prefix (`0x00 ‖ …`), so a leaf
 * can never pass for a node.
 *
 * Every function here works by levels, without recursion: an odd node at the end of a level
 * goes up unchanged, which gives exactly the split of RFC 6962.
 */

/** The bytes of a leaf hash or a node hash: a sha256 digest. */
const HASH_BYTES = 32;
/** The domain prefix of a node (RFC 6962): `0x01`. */
const NODE_PREFIX = uint8ArrayOf(1);
/** How a list of hashes is named in messages. */
const LEAVES = 'leaf hashes';

/**
 * Internal: a sha256 of several byte strings written into `out` (32 bytes), reusing one hasher
 * instead of building one per call (a digest of 500 000 leaves hashes about 1.5 million times).
 */
export function createHasherInto(): (out: Uint8Array, ...parts: Uint8Array[]) => void {
  const fresh = sha256.create();
  const work = sha256.create();
  return (out, ...parts) => {
    fresh._cloneInto(work);
    hashWork.calls += 1;
    for (const part of parts) {
      hashWork.bytes += uint8ArrayLength(part);
      work.update(part);
    }
    work.digestInto(out);
  };
}

/** Internal: as `createHasherInto`, each digest in a fresh array. */
export function createHasher(): (...parts: Uint8Array[]) => Uint8Array {
  const hashInto = createHasherInto();
  return (...parts) => {
    const out = new NativeUint8Array(HASH_BYTES);
    hashInto(out, ...parts);
    return out;
  };
}

/**
 * Internal: hashes kept end to end in one buffer (32 bytes each), so that a tree of many leaves
 * allocates no array per hash, and its root (`root`) or an audit path (`path`) is computed in
 * place. Made for `capacity` hashes when their number is known (it then never grows), else it
 * grows by doubling. `allocated` counts the bytes of the buffers it made.
 */
export class PackedHashes {
  private bytes: Uint8Array;
  private count = 0;
  /** The bytes of every buffer this one allocated. */
  allocated: number;

  constructor(capacity = 1024) {
    this.bytes = new NativeUint8Array(HASH_BYTES * mathMax(capacity, 1));
    this.allocated = uint8ArrayLength(this.bytes);
  }

  /** How many hashes it holds. */
  get length(): number {
    return this.count;
  }

  /** A copy of the hash at `index` (below `length`). */
  copyAt(index: number): Uint8Array {
    return uint8ArraySlice(this.bytes, index * HASH_BYTES, (index + 1) * HASH_BYTES);
  }

  /** A copy of the hashes held, end to end (32 bytes each). */
  copyAll(): Uint8Array {
    return uint8ArraySlice(this.bytes, 0, this.count * HASH_BYTES);
  }

  /** The 32 bytes where the next hash is to be written; `push` then keeps them. */
  next(): Uint8Array {
    const end = (this.count + 1) * HASH_BYTES;
    if (end > uint8ArrayLength(this.bytes)) {
      const grown = new NativeUint8Array(uint8ArrayLength(this.bytes) * 2);
      this.allocated += uint8ArrayLength(grown);
      uint8ArraySet(grown, this.bytes);
      this.bytes = grown;
    }
    return uint8ArraySubarray(this.bytes, end - HASH_BYTES, end);
  }

  /** Keeps the hash written into the last `next()`. */
  push(): void {
    this.count += 1;
  }

  /**
   * The RFC 6962 root of the hashes held, in order, computed in place by levels (an odd node at
   * the end of a level goes up unchanged): afterwards the buffer holds no meaningful hash.
   */
  root(): Uint8Array {
    return this.pathsAndRoot([]).root;
  }

  /**
   * The audit path of the hash at `index` (below `length`), from the bottom of the tree up.
   * Afterwards the buffer holds no meaningful hash.
   */
  path(index: number): Uint8Array[] {
    return this.pathsAndRoot([index]).paths[0] ?? [];
  }

  /**
   * The audit paths of the hashes at `indices` (each below `length`), from the bottom of the
   * tree up, and the RFC 6962 root, in one pass by levels: at each level the sibling of each node
   * on the way up is copied out (the last node of an odd level has none: it goes up unchanged),
   * then the level is hashed into the next, in place. So k paths cost the n - 1 node hashes of
   * the root, never k times them. Afterwards the buffer holds no meaningful hash.
   */
  pathsAndRoot(indices: readonly number[]): { paths: Uint8Array[][]; root: Uint8Array } {
    const hashInto = createHasherInto();
    const paths = arrayMap(indices, (): Uint8Array[] => []);
    if (this.count === 0) {
      const empty = new NativeUint8Array(HASH_BYTES);
      hashInto(empty);
      return { paths, root: empty };
    }
    const node = new NativeUint8Array(1 + 2 * HASH_BYTES);
    node[0] = 1;
    const at = (i: number): Uint8Array =>
      uint8ArraySubarray(this.bytes, i * HASH_BYTES, (i + 1) * HASH_BYTES);
    const positions = [...indices];
    let width = this.count;
    while (width > 1) {
      arrayForEach(positions, (position, k) => {
        const sibling = position % 2 === 1 ? position - 1 : position + 1;
        const path = paths[k];
        if (sibling < width && path !== undefined) arrayPush(path, uint8ArraySlice(at(sibling)));
        positions[k] = mathFloor(position / 2);
      });
      let next = 0;
      for (let i = 0; i < width; i += 2) {
        if (i + 1 < width) {
          // Both children are copied into `node` before their parent overwrites slot `next`.
          uint8ArraySet(
            node,
            uint8ArraySubarray(this.bytes, i * HASH_BYTES, (i + 2) * HASH_BYTES),
            1,
          );
          hashInto(at(next), node);
        } else {
          // The odd node at the end goes up unchanged; `next` < `i`, so the slots are distinct.
          uint8ArraySet(at(next), at(i));
        }
        next += 1;
      }
      width = next;
    }
    return { paths, root: uint8ArraySlice(at(0)) };
  }
}

/**
 * Internal: the digest of a tree of `size` leaves (a safe integer) whose RFC 6962 root is
 * `root`, committed with its size (D-15, D-16): `sha256(0x02 ‖ utf8(tag) ‖ 0x00 ‖
 * uint64be(size) ‖ root)`. The prefix `0x02` sets it apart from a leaf (`0x00`) and a node
 * (`0x01`), the tag from the digest of another kind of tree; the count makes the digest commit
 * to the size of the tree, which an RFC 6962 root alone does not.
 */
export function sizedDigest(tag: string, size: number, root: Uint8Array): Uint8Array {
  const count = new NativeUint8Array(8);
  const view = new NativeDataView(uint8ArrayBuffer(count));
  // `size` is a safe integer: its high and low 32 bits, big-endian.
  dataViewSetUint32(view, 0, mathFloor(size / 2 ** 32));
  dataViewSetUint32(view, 4, size % 2 ** 32);
  const out = new NativeUint8Array(HASH_BYTES);
  createHasherInto()(out, digestPrefix(tag), count, root);
  return out;
}

/** The prefix of the digest of a tree tagged `tag`: `0x02 ‖ utf8(tag) ‖ 0x00`, built once. */
function digestPrefix(tag: string): Uint8Array {
  let prefix = mapGet(DIGEST_PREFIXES, tag);
  if (prefix === undefined) {
    prefix = uint8ArrayFrom([2, ...new TextEncoder().encode(tag), 0]);
    mapSet(DIGEST_PREFIXES, tag, prefix);
  }
  return prefix;
}

const DIGEST_PREFIXES = new NativeMap<string, Uint8Array>();

/**
 * The RFC 6962 hash of the tree whose leaves are `leafHashes`, in that order: 32 bytes, a fresh
 * copy (`[]` gives the sha256 of nothing; one leaf gives a copy of it).
 *
 * `leafHashes` is read once: its length first (at most `MAX_JSON_VALUES`, 10 000 000, checked
 * before any element is read), then each element in order, which must be a `Uint8Array` of 32
 * bytes (of any realm; a `Buffer` is one) and is copied straight into one buffer of 32 bytes per
 * leaf: no array is made per hash, and the list is not copied. Throws `SpecError`
 * (`INVALID_PROOF`) at the first problem: `leaf hashes must be an array of 32-byte Uint8Array`,
 * `leaf hashes has an invalid length`, `leaf hashes is too large: more than 10000000 values`,
 * `leaf hashes has a hole at index <i>: arrays must be dense`, `leaf hashes[<i>] is not JSON:
 * undefined`, `leaf hash <i> must be a Uint8Array of 32 bytes (a sha256 digest)`, or `leaf
 * hashes could not be read: <reason>`.
 */
export function merkleRoot(leafHashes: readonly Uint8Array[]): Uint8Array {
  return withValueBudget(() => readHashes(leafHashes).root());
}

/**
 * The audit path of the leaf at `index` in the tree of `leafHashes` (RFC 6962, section 2.1.1):
 * the hashes needed to rebuild the root from that leaf, from the bottom of the tree up, each a
 * fresh 32-byte copy (`[]` for a one-leaf tree). `verifyInclusion` checks it.
 *
 * `leafHashes` is read as `merkleRoot` reads it, with the same errors. Throws `SpecError`
 * (`INVALID_PROOF`) when `index` is not a number (`index must be a number, got <type>`) or not
 * the index of a leaf (`index <i> is not a leaf of a tree of <n> leaves`).
 */
export function inclusionPath(leafHashes: readonly Uint8Array[], index: number): Uint8Array[] {
  return withValueBudget(() => {
    const leaves = readHashes(leafHashes);
    const at: unknown = index;
    if (typeof at !== 'number') {
      throw newSpecError('INVALID_PROOF', `index must be a number, got ${typeName(at)}`);
    }
    if (!numberIsSafeInteger(at) || at < 0 || at >= leaves.length) {
      throw newSpecError(
        'INVALID_PROOF',
        `index ${NativeString(at)} is not a leaf of a tree of ${leaves.length} leaves`,
      );
    }
    return leaves.path(at);
  });
}

/**
 * True when `path` proves that `leafHash` is the leaf at `index` of a tree of `size` leaves
 * whose RFC 6962 hash is `root` (the verification of RFC 9162, section 2.1.3.2). Never throws:
 * false for anything else, in particular when `size` is not an integer from 1 to 2^53 - 1,
 * `index` is not an integer below `size`, `leafHash` or `root` is not a `Uint8Array` of 32
 * bytes, `path` is not a dense list of such hashes, or the length of `path` is not that of the
 * audit path of (`index`, `size`), at most 53. That length is checked before any element of
 * `path` is read, so a path of a million entries costs nothing.
 *
 * The root does not commit to `size` (RFC 6962): a leaf whose audit path is the same in a
 * larger tree (leaf 4 of 7 and of 8) verifies under both sizes. Its place is right in both,
 * but whoever relies on `size` itself (that a leaf is the last one) takes it from a source
 * that authenticates it: the input digest commits to it (`verifyInputInclusion`).
 */
export function verifyInclusion(
  leafHash: Uint8Array,
  index: number,
  size: number,
  path: readonly Uint8Array[],
  root: Uint8Array,
): boolean {
  const expected = hashOf(root);
  const computed = rootFromPath(leafHash, index, size, path);
  return expected !== undefined && computed !== undefined && sameBytes(computed, expected);
}

/**
 * Internal: the RFC 6962 root that `path` gives for `leafHash` at `index` of a tree of `size`
 * leaves (RFC 9162, section 2.1.3.2), or `undefined` when the arguments cannot be such a proof
 * (the checks of `verifyInclusion`, the length of `path` compared before any element is read).
 * Never throws.
 */
export function rootFromPath(
  leafHash: Uint8Array,
  index: number,
  size: number,
  path: readonly Uint8Array[],
): Uint8Array | undefined {
  const n: unknown = size;
  const at: unknown = index;
  if (typeof n !== 'number' || !numberIsSafeInteger(n) || n < 1) return undefined;
  if (typeof at !== 'number' || !numberIsSafeInteger(at) || at < 0 || at >= n) return undefined;
  const steps = auditSteps(at, n);
  const hashes = readPath(path, steps.length);
  const leaf = hashOf(leafHash);
  if (hashes === undefined || leaf === undefined) return undefined;
  const hash = createHasher();
  let current = leaf;
  arrayForEach(steps, (left, i) => {
    const sibling = hashes[i] ?? current;
    current = left ? hash(NODE_PREFIX, sibling, current) : hash(NODE_PREFIX, current, sibling);
  });
  return current;
}

/**
 * Internal: the number of hashes in the audit path of the leaf at `index` of a tree of `size`
 * leaves (both safe integers, `index` below `size`): at most 53, 24 for 10 000 000 leaves.
 */
export function auditPathLength(index: number, size: number): number {
  return auditSteps(index, size).length;
}

/**
 * The audit path of (`index`, `size`) as RFC 9162 (section 2.1.3.2) walks it: for each of its
 * entries, true when that entry is the left sibling. Its length is the length a valid path must
 * have: at most 53, since `size` is below 2^53 (each step halves `size - 1`). Integer arithmetic
 * by division, exact up to 2^53.
 */
function auditSteps(index: number, size: number): boolean[] {
  const steps: boolean[] = [];
  let fn = index;
  let sn = size - 1;
  while (sn > 0) {
    const odd = fn % 2 === 1;
    arrayPush(steps, odd || fn === sn);
    if (!odd && fn === sn) {
      // The last node of its level: it goes up unchanged until it becomes a right child.
      while (fn % 2 === 0 && fn !== 0) {
        fn /= 2;
        sn = mathFloor(sn / 2);
      }
    }
    fn = mathFloor(fn / 2);
    sn = mathFloor(sn / 2);
  }
  return steps;
}

/**
 * The hashes of `list`, copied straight into one packed buffer of exactly their size (no array
 * per hash, no copy of the list): its length is read and counted first (`MAX_JSON_VALUES`),
 * then each element once, in order. The first problem throws `SpecError` (`INVALID_PROOF`):
 * `leaf hashes must be an array of 32-byte Uint8Array`, `leaf hashes has an invalid length`,
 * `leaf hashes is too large: more than 10000000 values`, `leaf hashes has a hole at index
 * <i>: arrays must be dense`, `leaf hashes[<i>] is not JSON: undefined`, `leaf hash <i> must be
 * a Uint8Array of 32 bytes (a sha256 digest)`, or `leaf hashes could not be read: <reason>`.
 */
function readHashes(list: readonly Uint8Array[]): PackedHashes {
  try {
    if (!arrayIsArray(list)) {
      throw newSpecError('INVALID_PROOF', `${LEAVES} must be an array of 32-byte Uint8Array`);
    }
    const length: unknown = list.length;
    if (typeof length !== 'number' || !numberIsSafeInteger(length) || length < 0) {
      throw newSpecError('INVALID_PROOF', `${LEAVES} has an invalid length`);
    }
    if (!spendValues(length)) throw newSpecError('INVALID_PROOF', tooLargeMessage(LEAVES));
    const packed = new PackedHashes(length);
    for (let i = 0; i < length; i++) {
      if (!(i in list)) throw newSpecError('INVALID_PROOF', holeMessage(LEAVES, i));
      const item: unknown = list[i];
      if (item === undefined) {
        throw newSpecError('INVALID_PROOF', undefinedMessage(`${LEAVES}[${i}]`));
      }
      if (!copyBytesInto(item, packed.next())) {
        throw newSpecError(
          'INVALID_PROOF',
          `leaf hash ${i} must be a Uint8Array of ${HASH_BYTES} bytes (a sha256 digest)`,
        );
      }
      packed.push();
    }
    lastPacked = packed.allocated;
    return packed;
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw newSpecError('INVALID_PROOF', unreadableMessage(LEAVES, error));
  }
}

/** The bytes of packed storage the last `merkleRoot` or `inclusionPath` allocated. */
let lastPacked = 0;

/** Internal, for tests: the bytes of packed storage the last read of leaf hashes allocated. */
export function lastPackedBytes(): number {
  return lastPacked;
}

/**
 * Copies of the hashes of the caller's `path` when it is a dense list of exactly `length`
 * hashes, else `undefined`. The length is read and compared first: no element of a list of
 * another length is ever read. Never throws.
 */
function readPath(path: readonly Uint8Array[], length: number): Uint8Array[] | undefined {
  try {
    if (!arrayIsArray(path) || path.length !== length) return undefined;
    const hashes: Uint8Array[] = [];
    for (let i = 0; i < length; i++) {
      if (!(i in path)) return undefined;
      const hash = hashOf(path[i]);
      if (hash === undefined) return undefined;
      arrayPush(hashes, hash);
    }
    return hashes;
  } catch {
    return undefined;
  }
}

/** A copy of `value` when it is a `Uint8Array` of 32 bytes, else `undefined`. */
function hashOf(value: unknown): Uint8Array | undefined {
  const bytes = bytesOf(value);
  return bytes !== undefined && uint8ArrayLength(bytes) === HASH_BYTES ? bytes : undefined;
}

/** Internal: true when `a` and `b` hold the same bytes. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return (
    uint8ArrayLength(a) === uint8ArrayLength(b) && uint8ArrayEvery(a, (byte, i) => byte === b[i])
  );
}
