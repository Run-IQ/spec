import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import {
  computeInputDigest,
  deriveInputSeed,
  inputLeafHash,
  inputLeaves,
  merkleRoot,
  UNSALTED_SEED,
} from '../src/index.js';
import type { InputLeaf, ProofInput } from '../src/index.js';
import { inputDigestOf } from '../src/input/tree.js';
import { readValidInput } from '../src/input/validate.js';
import {
  fromHex,
  hex,
  nodeHmac,
  nodeInputDigest,
  nodeInputSeed,
  nodeSha256,
  referenceRoot,
} from './helpers.js';
import vector from './vectors/input-v1.json';
import second from './vectors/input-v2.json';

const SECRET = fromHex(vector.secret);
const INPUT: ProofInput = vector.input;

/**
 * The leaves of the vector's input written by hand, in their order (D-15): the expected
 * contents, independent of `inputLeaves`.
 */
const CONTENTS: [string, string][] = [
  ['/data/a', '["value",1]'],
  ['/data/b', '["array",0]'],
  ['/data/c', '["object"]'],
  ['/data/d/e', '["value",null]'],
  ['/meta/assertions', '["object"]'],
  ['/meta/context', '["object"]'],
  ['/meta/dates', '["object"]'],
  ['/meta/dimensions', '["object"]'],
  ['/meta/tags', '["array",0]'],
  ['/meta/tenantId', '["value","t"]'],
];

/**
 * The hash of the leaf at `pointer` holding `content` (its JCS text) under `seed`, by
 * `node:crypto` alone, every byte of D-14 and D-15 written out here.
 */
function nodeLeaf(seed: Uint8Array, pointer: string, content: string): Uint8Array {
  const tag = ['run-iq.input/1', Uint8Array.of(0)] as const;
  const commitment = nodeSha256(
    Uint8Array.of(3),
    ...tag,
    nodeHmac(seed, `value:${pointer}`),
    content,
  );
  const pointerHash = nodeSha256(JSON.stringify(pointer));
  const salt = nodeHmac(seed, `input:${pointer}`);
  return nodeSha256(Uint8Array.of(0), ...tag, salt, pointerHash, commitment);
}

/** The RFC 6962 root of the vector's input under `seed`, by `node:crypto` alone. */
function nodeRoot(seed: Uint8Array): Uint8Array {
  return referenceRoot(CONTENTS.map(([pointer, content]) => nodeLeaf(seed, pointer, content)));
}

/** The content `c` of a leaf in JCS (D-15). */
const contentOf = (leaf: InputLeaf): string =>
  JSON.stringify(
    leaf.kind === 'value'
      ? [leaf.kind, leaf.value]
      : leaf.kind === 'array'
        ? [leaf.kind, leaf.length]
        : [leaf.kind],
  );

describe('frozen vector input-v1', () => {
  it('node:crypto alone gives the frozen values', () => {
    expect(hex(nodeInputSeed(SECRET, vector.requestId))).toBe(vector.salted.seed);
    const salted = nodeRoot(fromHex(vector.salted.seed));
    const unsalted = nodeRoot(new Uint8Array(32));
    expect(CONTENTS).toHaveLength(vector.salted.leafCount);
    expect(vector.unsalted.leafCount).toBe(vector.salted.leafCount);
    expect(hex(salted)).toBe(vector.salted.merkleRoot);
    expect(hex(unsalted)).toBe(vector.unsalted.merkleRoot);
    expect(nodeInputDigest(CONTENTS.length, salted)).toBe(vector.salted.inputDigest);
    expect(nodeInputDigest(CONTENTS.length, unsalted)).toBe(vector.unsalted.inputDigest);
    expect(hex(nodeSha256())).toBe(vector.empty.merkleRoot);
    expect(nodeInputDigest(vector.empty.leafCount, nodeSha256())).toBe(vector.empty.inputDigest);
    expect(hex(nodeHmac(new Uint8Array(32), 'input:/data/a'))).toBe(vector.unsalted.firstLeaf.salt);
    expect(hex(nodeHmac(new Uint8Array(32), 'value:/data/a'))).toBe(
      vector.unsalted.firstLeaf.valueSalt,
    );
  });

  it('the seed', () => {
    expect(hex(deriveInputSeed(SECRET, vector.requestId))).toBe(vector.salted.seed);
  });

  it('the first leaf: its salts, its commitment and its hash', () => {
    const seed = deriveInputSeed(SECRET, vector.requestId);
    const [first] = inputLeaves(INPUT, seed);
    const frozen = vector.salted.firstLeaf;
    expect(first).toEqual({
      pointer: frozen.pointer,
      kind: 'value',
      value: 1,
      salt: frozen.salt,
      valueSalt: frozen.valueSalt,
    });
    expect(first === undefined ? '' : hex(inputLeafHash(first))).toBe(frozen.hash);
    expect(hex(nodeLeaf(seed, frozen.pointer, '["value",1]'))).toBe(frozen.hash);
    const commitment = nodeSha256(
      Uint8Array.of(3),
      'run-iq.input/1',
      Uint8Array.of(0),
      fromHex(frozen.valueSalt),
      '["value",1]',
    );
    expect(hex(commitment)).toBe(frozen.commitment);
  });

  it('the leaf contents, in order', () => {
    const leaves = inputLeaves(INPUT, UNSALTED_SEED);
    expect(leaves.map((leaf) => [leaf.pointer, contentOf(leaf)])).toEqual(CONTENTS);
  });

  it('the Merkle roots of the leaves, salted and unsalted', () => {
    const seed = deriveInputSeed(SECRET, vector.requestId);
    expect(hex(merkleRoot(inputLeaves(INPUT, seed).map(inputLeafHash)))).toBe(
      vector.salted.merkleRoot,
    );
    expect(hex(merkleRoot(inputLeaves(INPUT, UNSALTED_SEED).map(inputLeafHash)))).toBe(
      vector.unsalted.merkleRoot,
    );
  });

  it('the input digest of an empty tree: its count 0 and the sha256 of nothing', () => {
    expect(hex(merkleRoot([]))).toBe(vector.empty.merkleRoot);
    expect(hex(inputDigestOf(0, merkleRoot([])))).toBe(vector.empty.inputDigest);
  });

  it('the salted input digest', () => {
    const seed = deriveInputSeed(SECRET, vector.requestId);
    expect(computeInputDigest(INPUT, seed)).toBe(vector.salted.inputDigest);
    expect(canonicalEntry.computeInputDigest(INPUT, seed)).toBe(vector.salted.inputDigest);
  });

  it('the unsalted input digest: salts are HMACs under 32 zero bytes', () => {
    expect(hex(UNSALTED_SEED)).toBe(vector.unsalted.seed);
    const [first] = inputLeaves(INPUT, UNSALTED_SEED);
    expect(first?.salt).toBe(vector.unsalted.firstLeaf.salt);
    expect(first?.valueSalt).toBe(vector.unsalted.firstLeaf.valueSalt);
    expect(computeInputDigest(INPUT, UNSALTED_SEED)).toBe(vector.unsalted.inputDigest);
  });

  it('the Merkle root of sha256(a), sha256(b), sha256(c)', () => {
    const leaves = ['a', 'b', 'c'].map((text) => nodeSha256(text));
    expect(hex(merkleRoot(leaves))).toBe(vector.merkle.root);
    expect(hex(referenceRoot(leaves))).toBe(vector.merkle.root);
  });
});

describe('frozen vector input-v2: escapes, unicode, index order, numbers, nesting (M4)', () => {
  const secret = fromHex(second.secret);
  // A JSON module types `method` as any string: the validator's own reader gives the type.
  const input: ProofInput = readValidInput(second.input);

  it('node:crypto alone gives the frozen roots and digests from the frozen contents', () => {
    expect(second.contents).toHaveLength(second.leafCount);
    const rootOf = (seed: Uint8Array): Uint8Array =>
      referenceRoot(
        second.contents.map(([pointer = '', content = '']) => nodeLeaf(seed, pointer, content)),
      );
    const seed = nodeInputSeed(secret, second.requestId);
    expect(hex(seed)).toBe(second.salted.seed);
    expect(hex(rootOf(seed))).toBe(second.salted.merkleRoot);
    expect(hex(rootOf(new Uint8Array(32)))).toBe(second.unsalted.merkleRoot);
    expect(nodeInputDigest(second.leafCount, rootOf(seed))).toBe(second.salted.inputDigest);
    expect(nodeInputDigest(second.leafCount, rootOf(new Uint8Array(32)))).toBe(
      second.unsalted.inputDigest,
    );
  });

  it('inputLeaves gives the frozen leaves, in order, and the first salt and hash', () => {
    const seed = deriveInputSeed(secret, second.requestId);
    const leaves = inputLeaves(input, seed);
    expect(leaves.map((leaf) => [leaf.pointer, contentOf(leaf)])).toEqual(second.contents);
    const pointers = leaves.map((leaf) => leaf.pointer);
    expect(pointers.indexOf('/data/l/10')).toBeLessThan(pointers.indexOf('/data/l/2'));
    const [first] = leaves;
    expect(first?.pointer).toBe(second.salted.firstLeaf.pointer);
    expect(first?.salt).toBe(second.salted.firstLeaf.salt);
    expect(first?.valueSalt).toBe(second.salted.firstLeaf.valueSalt);
    expect(first === undefined ? '' : hex(inputLeafHash(first))).toBe(second.salted.firstLeaf.hash);
    expect(hex(merkleRoot(leaves.map(inputLeafHash)))).toBe(second.salted.merkleRoot);
  });

  it('the input digests, salted and unsalted, through both entries', () => {
    const seed = deriveInputSeed(secret, second.requestId);
    expect(computeInputDigest(input, seed)).toBe(second.salted.inputDigest);
    expect(canonicalEntry.computeInputDigest(input, seed)).toBe(second.salted.inputDigest);
    expect(computeInputDigest(input, UNSALTED_SEED)).toBe(second.unsalted.inputDigest);
    const unsalted = inputLeaves(input, UNSALTED_SEED).map(inputLeafHash);
    expect(hex(merkleRoot(unsalted))).toBe(second.unsalted.merkleRoot);
  });
});
