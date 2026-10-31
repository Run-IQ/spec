import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { inclusionPath, merkleRoot, verifyInclusion } from '../src/index.js';
import { hex, leafHashes, nodeSha256, referencePath, referenceRoot, specError } from './helpers.js';

const NODE = Uint8Array.of(1);
const [A, B, C] = ['a', 'b', 'c'].map((text) => nodeSha256(text)) as [
  Uint8Array,
  Uint8Array,
  Uint8Array,
];

/** The elements a hostile list gave out: every read of an index, and every `in` test. */
let elementReads = 0;

/** A Proxy over an array that claims `length` elements, each a valid hash, counting reads. */
function claiming(length: number): Uint8Array[] {
  const hash = new Uint8Array(32);
  return new Proxy<Uint8Array[]>([], {
    get(target, key) {
      if (key === 'length') return length;
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        elementReads += 1;
        return hash;
      }
      return Reflect.get(target, key) as unknown;
    },
    has(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        elementReads += 1;
        return true;
      }
      return Reflect.has(target, key);
    },
  });
}

/** A Proxy that has been revoked: every operation on it throws a `TypeError`. */
function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** `value` typed as the leaf list a caller may pass from JavaScript. */
const asLeaves = (value: unknown): Uint8Array[] => value as Uint8Array[];
/** `value` typed as the hash a caller may pass from JavaScript. */
const asHash = (value: unknown): Uint8Array => value as Uint8Array;

describe('merkleRoot (RFC 6962)', () => {
  it('the empty tree is the sha256 of nothing', () => {
    expect(hex(merkleRoot([]))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('one leaf is the root, returned as a copy', () => {
    const root = merkleRoot([A]);
    expect(hex(root)).toBe(hex(A));
    expect(root).not.toBe(A);
    root[0] = (root[0] ?? 0) ^ 1;
    expect(hex(merkleRoot([A]))).toBe(hex(A));
  });

  it('three leaves: H(0x01 ‖ H(0x01 ‖ l0 ‖ l1) ‖ l2), the frozen vector', () => {
    const expected = nodeSha256(NODE, nodeSha256(NODE, A, B), C);
    expect(hex(merkleRoot([A, B, C]))).toBe(hex(expected));
    expect(hex(merkleRoot([A, B, C]))).toBe(
      '1394b29c3086a6150915a75bd1ab6c5dd7e461ec0c5e7d31939ae192d08eb59a',
    );
  });

  it('five leaves split 4 + 1', () => {
    const leaves = leafHashes(5);
    const [l0, l1, l2, l3, l4] = leaves as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    const four = nodeSha256(NODE, nodeSha256(NODE, l0, l1), nodeSha256(NODE, l2, l3));
    expect(hex(merkleRoot(leaves))).toBe(hex(nodeSha256(NODE, four, l4)));
  });

  it('agrees with the recursive RFC definition for every size up to 130', () => {
    const leaves = leafHashes(130);
    for (let n = 0; n <= 130; n++) {
      const slice = leaves.slice(0, n);
      expect([n, hex(merkleRoot(slice))]).toEqual([n, hex(referenceRoot(slice))]);
    }
  });

  it('accepts a Uint8Array of another realm and a Buffer', () => {
    const foreign = runInNewContext('new Uint8Array(32).fill(7)') as Uint8Array;
    const local = new Uint8Array(32).fill(7);
    expect(hex(merkleRoot([foreign, B]))).toBe(hex(merkleRoot([local, B])));
    expect(hex(merkleRoot([Buffer.from(local), B]))).toBe(hex(merkleRoot([local, B])));
  });

  it('refuses anything but a dense list of 32-byte hashes, with an own SpecError', () => {
    const notList = 'leaf hashes must be an array of 32-byte Uint8Array';
    const notHash = (i: number): string =>
      `leaf hash ${i} must be a Uint8Array of 32 bytes (a sha256 digest)`;
    const cases: [unknown, string][] = [
      [null, notList],
      ['abc', notList],
      [{ length: 1, 0: A }, notList],
      [[A, new Uint8Array(31)], notHash(1)],
      [[new Uint8Array(33)], notHash(0)],
      [[new Uint16Array(16)], notHash(0)],
      [[new Uint8Array(32).buffer], notHash(0)],
      [[Array.from(A)], notHash(0)],
      [[new Proxy(A, {})], notHash(0)],
      [[revokedProxy()], notHash(0)],
      // eslint-disable-next-line no-sparse-arrays -- a hole is the case under test
      [[A, , B], 'leaf hashes has a hole at index 1: arrays must be dense'],
      [[A, undefined], 'leaf hashes[1] is not JSON: undefined'],
    ];
    for (const [value, message] of cases) {
      expect(specError(() => merkleRoot(asLeaves(value)))).toMatchObject({
        code: 'INVALID_PROOF',
        message,
      });
    }
    expect(specError(() => merkleRoot(asLeaves(revokedProxy())))).toMatchObject({
      code: 'INVALID_PROOF',
      message:
        "leaf hashes could not be read: Cannot perform 'IsArray' on a proxy that has been revoked",
    });
  });

  it('refuses a list claiming more than 10 000 000 leaves before reading any', () => {
    elementReads = 0;
    const sparse: Uint8Array[] = [];
    sparse.length = 2 ** 32 - 1;
    for (const list of [sparse, claiming(10 ** 12)]) {
      expect(specError(() => merkleRoot(list))).toMatchObject({
        code: 'INVALID_PROOF',
        message: 'leaf hashes is too large: more than 10000000 values',
      });
    }
    expect(elementReads).toBe(0);
  });
});

describe('inclusionPath and verifyInclusion', () => {
  it('give and check the RFC 6962 audit path of every leaf, for every size up to 70', () => {
    const leaves = leafHashes(70);
    for (let n = 1; n <= 70; n++) {
      const slice = leaves.slice(0, n);
      const root = merkleRoot(slice);
      for (let i = 0; i < n; i++) {
        const path = inclusionPath(slice, i);
        expect([n, i, path.map(hex)]).toEqual([n, i, referencePath(slice, i).map(hex)]);
        expect([n, i, verifyInclusion(slice[i] ?? A, i, n, path, root)]).toEqual([n, i, true]);
      }
    }
  });

  it('a tree of 7 leaves: true at its own index, false at another or under another root', () => {
    const leaves = leafHashes(7);
    const root = merkleRoot(leaves);
    const other = merkleRoot(leafHashes(8));
    for (let i = 0; i < 7; i++) {
      const leaf = leaves[i] ?? A;
      const path = inclusionPath(leaves, i);
      expect(verifyInclusion(leaf, i, 7, path, root)).toBe(true);
      for (let j = 0; j < 7; j++) {
        if (j !== i) expect([i, j, verifyInclusion(leaf, j, 7, path, root)]).toEqual([i, j, false]);
      }
      expect(verifyInclusion(leaf, i, 7, path, other)).toBe(false);
      expect(verifyInclusion(leaves[(i + 1) % 7] ?? A, i, 7, path, root)).toBe(false);
      expect(verifyInclusion(leaf, i, 3, path, root)).toBe(false);
      expect(verifyInclusion(leaf, i, 16, path, root)).toBe(false);
    }
  });

  it('the root does not commit to the size: the caller takes it from a trusted source', () => {
    // RFC 6962 roots do not bind the number of leaves: leaf 4 of 7 has the same audit path
    // as leaf 4 of 8 whose last subtree hash is that of leaves 4 to 6. Leaves 0 to 6 keep
    // their place, but whoever relies on `size` (an absence after the last leaf) must check it;
    // the input digest commits to it (`verifyInputInclusion`).
    const leaves = leafHashes(7);
    const root = merkleRoot(leaves);
    const path = inclusionPath(leaves, 4);
    expect(verifyInclusion(leaves[4] ?? A, 4, 7, path, root)).toBe(true);
    expect(verifyInclusion(leaves[4] ?? A, 4, 8, path, root)).toBe(true);
    expect(verifyInclusion(leaves[6] ?? A, 6, 8, inclusionPath(leaves, 6), root)).toBe(false);
  });

  it('returns fresh copies: changing a path element changes nothing else', () => {
    const leaves = leafHashes(4);
    const path = inclusionPath(leaves, 1);
    path[0]?.fill(0);
    expect(inclusionPath(leaves, 1).map(hex)).toEqual(referencePath(leafHashes(4), 1).map(hex));
  });

  it('a one-leaf tree: the empty path, the leaf is the root', () => {
    expect(inclusionPath([A], 0)).toEqual([]);
    expect(verifyInclusion(A, 0, 1, [], A)).toBe(true);
    expect(verifyInclusion(A, 0, 1, [B], A)).toBe(false);
  });

  it('inclusionPath refuses an index that is not a leaf, with an own SpecError', () => {
    const leaves = leafHashes(3);
    const cases: [unknown, string][] = [
      [3, 'index 3 is not a leaf of a tree of 3 leaves'],
      [-1, 'index -1 is not a leaf of a tree of 3 leaves'],
      [1.5, 'index 1.5 is not a leaf of a tree of 3 leaves'],
      [Number.NaN, 'index NaN is not a leaf of a tree of 3 leaves'],
      ['1', 'index must be a number, got string'],
      [null, 'index must be a number, got null'],
    ];
    for (const [index, message] of cases) {
      expect(specError(() => inclusionPath(leaves, index as number))).toMatchObject({
        code: 'INVALID_PROOF',
        message,
      });
    }
    expect(specError(() => inclusionPath([], 0)).message).toBe(
      'index 0 is not a leaf of a tree of 0 leaves',
    );
    expect(specError(() => inclusionPath(asLeaves([A, 'x']), 0)).message).toBe(
      'leaf hash 1 must be a Uint8Array of 32 bytes (a sha256 digest)',
    );
  });

  it('verifyInclusion is false, never an exception, for an impossible index or size', () => {
    const leaves = leafHashes(4);
    const root = merkleRoot(leaves);
    const leaf = leaves[1] ?? A;
    const path = inclusionPath(leaves, 1);
    const sizes: unknown[] = [0, -4, 4.5, 2 ** 53, Number.NaN, Infinity, '4', null, 4n];
    for (const size of sizes) {
      expect([size, verifyInclusion(leaf, 1, size as number, path, root)]).toEqual([size, false]);
    }
    const indexes: unknown[] = [4, 5, -1, 1.5, Number.NaN, '1', null, 1n];
    for (const index of indexes) {
      expect([index, verifyInclusion(leaf, index as number, 4, path, root)]).toEqual([
        index,
        false,
      ]);
    }
  });

  it('verifyInclusion is false for a path longer or shorter than that of (index, size)', () => {
    const leaves = leafHashes(5);
    const root = merkleRoot(leaves);
    const path = inclusionPath(leaves, 4);
    expect(path).toHaveLength(1);
    expect(verifyInclusion(leaves[4] ?? A, 4, 5, path, root)).toBe(true);
    expect(verifyInclusion(leaves[4] ?? A, 4, 5, [...path, A], root)).toBe(false);
    expect(verifyInclusion(leaves[4] ?? A, 4, 5, [], root)).toBe(false);
    const full = inclusionPath(leaves, 0);
    expect(full).toHaveLength(3);
    expect(verifyInclusion(leaves[0] ?? A, 0, 5, full.slice(0, 2), root)).toBe(false);
  });

  it('verifyInclusion checks the length first: a path of 10^6 entries is never walked', () => {
    elementReads = 0;
    expect(verifyInclusion(A, 0, 4, claiming(10 ** 6), A)).toBe(false);
    expect(verifyInclusion(A, 0, 2 ** 53 - 1, claiming(10 ** 6), A)).toBe(false);
    expect(elementReads).toBe(0);
    // The path of leaf 0 among 2^53 - 1 leaves has 53 entries: only then are they read.
    expect(verifyInclusion(A, 0, 2 ** 53 - 1, claiming(52), A)).toBe(false);
    expect(verifyInclusion(A, 0, 2 ** 53 - 1, claiming(54), A)).toBe(false);
    expect(elementReads).toBe(0);
    expect(verifyInclusion(A, 0, 2 ** 53 - 1, claiming(53), A)).toBe(false);
    expect(elementReads).toBeGreaterThan(0);
    expect(elementReads).toBeLessThanOrEqual(2 * 53);
  });

  it('verifyInclusion is false, never an exception, for hostile hashes and paths', () => {
    const leaves = leafHashes(2);
    const root = merkleRoot(leaves);
    const leaf = leaves[0] ?? A;
    const path = inclusionPath(leaves, 0);
    expect(verifyInclusion(leaf, 0, 2, path, root)).toBe(true);
    const thrower = (): never => {
      throw new Error('trap');
    };
    const hostiles: unknown[] = [
      null,
      undefined,
      'x',
      new Uint8Array(31),
      new Uint8Array(33),
      revokedProxy(),
      new Proxy(leaf, {}),
      new Proxy([], { get: thrower, has: thrower, ownKeys: thrower }),
    ];
    for (const hostile of hostiles) {
      expect(verifyInclusion(asHash(hostile), 0, 2, path, root)).toBe(false);
      expect(verifyInclusion(leaf, 0, 2, path, asHash(hostile))).toBe(false);
      expect(verifyInclusion(leaf, 0, 2, asLeaves(hostile), root)).toBe(false);
      expect(verifyInclusion(leaf, 0, 2, asLeaves([hostile]), root)).toBe(false);
    }
    // eslint-disable-next-line no-sparse-arrays -- a hole is the case under test
    expect(verifyInclusion(leaf, 0, 2, asLeaves([,]), root)).toBe(false);
  });
});
