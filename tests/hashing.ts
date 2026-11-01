import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { expect } from 'vitest';
import { canonicalize, inputLeaves, UNSALTED_SEED } from '../src/index.js';
import { canonicalSha256Hex, isCanonicalText } from '../src/canonical.js';
import { hashWorkDone } from '../src/stream.js';
import { proofInput } from './helpers.js';
import type { JsonValue, InputLeaf, ProofInput } from '../src/index.js';

// Shared test helpers for hashing: sha256, HMAC and HKDF by `node:crypto`, RFC 6962 reference
// trees, the hash work a call does, and input trees built by hand.

/** The bytes of `text` in UTF-8, or the bytes given. */
function bytesOf(part: Uint8Array | string): Uint8Array {
  return typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
}

/** sha256 by `node:crypto` of the parts given, one after the other (texts in UTF-8). */
export function nodeSha256(...parts: (Uint8Array | string)[]): Uint8Array {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(bytesOf(part));
  return new Uint8Array(hash.digest());
}

/** HMAC-SHA256 by `node:crypto` of the UTF-8 text `message` under `key`. */
export function nodeHmac(key: Uint8Array, message: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(message, 'utf8').digest());
}

/** The input seed by `node:crypto`: HKDF-SHA256, salt `run-iq.input-seed/1`, 32 bytes. */
export function nodeInputSeed(secret: Uint8Array, requestId: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', secret, 'run-iq.input-seed/1', requestId, 32));
}

/**
 * The input digest by `node:crypto` (D-15) of a tree of `size` leaves whose RFC 6962 root is
 * `root`: `sha256(0x02 ‖ utf8('run-iq.input/1') ‖ 0x00 ‖ uint64be(size) ‖ root)`, in hex.
 */
export function nodeInputDigest(size: number, root: Uint8Array): string {
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(size));
  return hex(nodeSha256(Uint8Array.of(2), 'run-iq.input/1', Uint8Array.of(0), count, root));
}

/**
 * `canonicalize(value)`, after checking that the streamed writers agree with it: the digest
 * hashed as the text is written is the sha256 (by `node:crypto`) of that text, and the
 * comparison as it is written accepts it, and refuses it with one more character or one less.
 */
export function canonical(value: unknown): string {
  const text = canonicalize(value);
  expect(canonicalSha256Hex(value)).toBe(hex(nodeSha256(text)));
  expect(isCanonicalText(value, text)).toBe(true);
  expect(isCanonicalText(value, `${text} `)).toBe(false);
  expect(isCanonicalText(value, text.slice(0, -1))).toBe(false);
  return text;
}

/** Lowercase hex of `bytes`. */
export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** The bytes of a hex text. */
export function fromHex(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'hex'));
}

/** `n` distinct leaf hashes: the sha256 of `leaf 0`, `leaf 1`, … */
export function leafHashes(n: number): Uint8Array[] {
  return Array.from({ length: n }, (_, i) => nodeSha256(`leaf ${i}`));
}

/** The largest power of two strictly below `n` (n ≥ 2), as RFC 6962 splits a tree. */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * The Merkle tree hash of RFC 6962 (section 2.1), written as the RFC writes it, recursively:
 * a reference for test sizes only. `[]` gives the sha256 of nothing, one leaf gives itself.
 */
export function referenceRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return nodeSha256();
  const [only] = leaves;
  if (leaves.length === 1 && only !== undefined) return only;
  const k = split(leaves.length);
  const left = referenceRoot(leaves.slice(0, k));
  const right = referenceRoot(leaves.slice(k));
  return nodeSha256(Uint8Array.of(1), left, right);
}

/** The audit path of RFC 6962 (section 2.1.1), recursive: a reference for test sizes only. */
export function referencePath(leaves: readonly Uint8Array[], index: number): Uint8Array[] {
  if (leaves.length <= 1) return [];
  const k = split(leaves.length);
  return index < k
    ? [...referencePath(leaves.slice(0, k), index), referenceRoot(leaves.slice(k))]
    : [...referencePath(leaves.slice(k), index - k), referenceRoot(leaves.slice(0, k))];
}

/** The UTF-16 code units of the leaf pointers of `input`, all added up (`inputLeaves`). */
export function pointerText(input: ProofInput): number {
  return inputLeaves(input, UNSALTED_SEED).reduce((total, leaf) => total + leaf.pointer.length, 0);
}

/**
 * A valid input whose leaf pointers hold exactly `units` code units, built from short texts: one
 * value `0` shared by the `2^depth` paths of a chain of `depth` objects `{ l, r }` (each object
 * holds the next one twice), under a key `k…` of `width` units (`/data/k…/l/r/…`, `6 + width +
 * 2 * depth` units each), one more value under a key `z…` for the remainder (`/data/z…`), and
 * the fixed leaves of `meta` (`proofInput`). Its `paths`, `width` and `rest` (the length of
 * `z…`) are given beside it.
 */
export function sharedPointerText(
  units: number,
  depth: number,
): { input: ProofInput; paths: number; width: number; rest: number } {
  const fixed = pointerText(proofInput({}, { z: 0 })) - '/data/z'.length;
  const paths = 2 ** depth;
  const width = Math.floor((units - fixed - 7) / paths) - 6 - 2 * depth;
  const rest = units - fixed - paths * (6 + width + 2 * depth) - 6;
  if (width < 1 || rest < 1) throw new RangeError(`no input of ${units} units at depth ${depth}`);
  let shared: JsonValue = 0;
  for (let level = 0; level < depth; level++) shared = { l: shared, r: shared };
  const input = proofInput({}, { ['k'.repeat(width)]: shared, ['z'.repeat(rest)]: 0 });
  return { input, paths, width, rest };
}

/** The UTF-8 bytes of a leaf's pointer, of its pointer in JCS, and of its content in JCS. */
export interface LeafBytes {
  pointerBytes: number;
  quotedBytes: number;
  contentBytes: number;
}

/**
 * The hash work (`hashWork`) a digest of these leaves does, by D-14 and D-15 alone: per leaf,
 * its two salts (HMACs of `input:` and `value:` with its pointer, the messages counted), its
 * commitment `C` (`0x03 ‖ tag ‖ 0x00`, 16 bytes, its value salt, its content) and its hash (16
 * bytes, its salt, `C`, its pointer in JCS); the `n - 1` nodes of 65 bytes; the digest
 * (`0x02 ‖ tag ‖ 0x00`, the count and the root, 56 bytes).
 */
export function expectedHashWork(leaves: Iterable<LeafBytes>): { calls: number; bytes: number } {
  let n = 0;
  let bytes = 0;
  for (const leaf of leaves) {
    n += 1;
    bytes += 2 * ('input:'.length + leaf.pointerBytes) + leaf.quotedBytes;
    bytes += 16 + 32 + leaf.contentBytes + 80;
  }
  bytes += 65 * Math.max(n - 1, 0) + 56;
  return { calls: 4 * n + Math.max(n - 1, 0) + 1, bytes };
}

/**
 * The hash work `call` does (`hashWork`): its hash computations and the bytes given to them.
 * A digest of an input of `n` leaves makes `3n` of them (a salt and a hash per leaf, `n - 1`
 * nodes, the digest itself), so its leaf count is read from here, never from a side channel.
 */
export function hashWorkOf(call: () => unknown): { calls: number; bytes: number } {
  const before = hashWorkDone();
  call();
  const after = hashWorkDone();
  return { calls: after.calls - before.calls, bytes: after.bytes - before.bytes };
}

/** The bytes of a leaf (`LeafBytes`): its content is `[kind, …]` in JCS. */
export function leafBytes(leaf: InputLeaf): LeafBytes {
  return {
    pointerBytes: Buffer.byteLength(leaf.pointer, 'utf8'),
    quotedBytes: Buffer.byteLength(canonicalize(leaf.pointer), 'utf8'),
    contentBytes: Buffer.byteLength(canonicalize(leafContent(leaf)), 'utf8'),
  };
}

/** The content `c` of a leaf (D-15): `['value', value]`, `['array', length]` or `['object']`. */
export function leafContent(leaf: Pick<InputLeaf, 'kind' | 'value' | 'length'>): JsonValue[] {
  if (leaf.kind === 'value') return [leaf.kind, leaf.value ?? null];
  if (leaf.kind === 'array') return [leaf.kind, leaf.length ?? 0];
  return [leaf.kind];
}

/**
 * The commitment `C` of a leaf (D-15), by `node:crypto`: `sha256(0x03 ‖ tag ‖ 0x00 ‖ valueSalt
 * ‖ utf8(canonicalize(c)))`.
 */
export function nodeCommitment(leaf: InputLeaf): Uint8Array {
  return nodeSha256(
    Uint8Array.of(3),
    'run-iq.input/1',
    Uint8Array.of(0),
    fromHex(leaf.valueSalt),
    canonicalize(leafContent(leaf)),
  );
}

/**
 * The hash of a leaf from its pointer, its salt (hex) and its commitment (D-15), by
 * `node:crypto`: `sha256(0x00 ‖ tag ‖ 0x00 ‖ salt ‖ C ‖ utf8(canonicalize(pointer)))`.
 */
export function nodeCommittedLeafHash(
  pointer: string,
  salt: string,
  commitment: Uint8Array,
): Uint8Array {
  return nodeSha256(
    Uint8Array.of(0),
    'run-iq.input/1',
    Uint8Array.of(0),
    fromHex(salt),
    commitment,
    canonicalize(pointer),
  );
}

/** The leaf hash of D-15, by `node:crypto`: what `inputLeafHash` must give. */
export function nodeLeafHash(leaf: InputLeaf): Uint8Array {
  return nodeCommittedLeafHash(leaf.pointer, leaf.salt, nodeCommitment(leaf));
}

/** A leaf of a tree built by hand: its content, before its salts. */
export type TreeLeaf = Omit<InputLeaf, 'salt' | 'valueSalt'>;

/** A shown leaf of a tree built by hand: an input leaf, its index and its audit path. */
export interface HandLeaf extends InputLeaf {
  index: number;
  path: string[];
}

/** A neighbour of a tree built by hand: pointer, salt, commitment, index and audit path. */
export interface HandNeighbour {
  pointer: string;
  salt: string;
  commitment: string;
  index: number;
  path: string[];
}

/**
 * A tree of input leaves built by hand, in the order given (sorted or not: it may be a tree no
 * honest signer builds), each salted under `seed` as D-14 salts it. Gives its digest (D-15, by
 * `node:crypto`), each leaf as a disclosure shows it (`leaf(i)`) and as a neighbour
 * (`neighbour(i)`).
 */
export function handTree(
  contents: readonly TreeLeaf[],
  seed: Uint8Array,
): {
  digest: string;
  size: number;
  leaf: (index: number) => HandLeaf;
  neighbour: (index: number) => HandNeighbour;
} {
  const leaves: InputLeaf[] = contents.map((content) => ({
    ...content,
    salt: hex(nodeHmac(seed, `input:${content.pointer}`)),
    valueSalt: hex(nodeHmac(seed, `value:${content.pointer}`)),
  }));
  const hashes = leaves.map(nodeLeafHash);
  const at = (index: number): InputLeaf => {
    const leaf = leaves[index];
    if (leaf === undefined) throw new RangeError(`no leaf ${index}`);
    return leaf;
  };
  return {
    digest: nodeInputDigest(hashes.length, referenceRoot(hashes)),
    size: hashes.length,
    leaf: (index) => ({ ...at(index), index, path: referencePath(hashes, index).map(hex) }),
    neighbour: (index) => {
      const { pointer, salt } = at(index);
      const commitment = hex(nodeCommitment(at(index)));
      return { pointer, salt, commitment, index, path: referencePath(hashes, index).map(hex) };
    },
  };
}
