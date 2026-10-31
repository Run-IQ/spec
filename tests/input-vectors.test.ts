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
import type { ProofInput } from '../src/index.js';
import { fromHex, hex, nodeHmac, nodeInputSeed, nodeSha256, referenceRoot } from './helpers.js';
import vector from './vectors/input-v1.json';

const SECRET = fromHex(vector.secret);
const INPUT: ProofInput = vector.input;

/**
 * The leaves of the vector's input written by hand, in their order (D-15): the expected
 * contents, independent of `inputLeaves`.
 */
const CONTENTS = [
  '["/data/a","value",1]',
  '["/data/b","array",0]',
  '["/data/c","object"]',
  '["/data/d/e","value",null]',
  '["/meta/assertions","object"]',
  '["/meta/context","object"]',
  '["/meta/dates","object"]',
  '["/meta/dimensions","object"]',
  '["/meta/tags","array",0]',
  '["/meta/tenantId","value","t"]',
];

/** The root of the vector's input under `seed`, by `node:crypto` alone. */
function nodeRoot(seed: Uint8Array): string {
  const leaves = CONTENTS.map((content) => {
    const pointer = (JSON.parse(content) as string[])[0] ?? '';
    const salt = nodeHmac(seed, `input:${pointer}`);
    return nodeSha256(Uint8Array.of(0), 'run-iq.input/1', Uint8Array.of(0), salt, content);
  });
  return hex(referenceRoot(leaves));
}

describe('frozen vector input-v1', () => {
  it('node:crypto alone gives the frozen values', () => {
    expect(hex(nodeInputSeed(SECRET, vector.requestId))).toBe(vector.salted.seed);
    expect(nodeRoot(fromHex(vector.salted.seed))).toBe(vector.salted.inputDigest);
    expect(nodeRoot(new Uint8Array(32))).toBe(vector.unsalted.inputDigest);
    expect(hex(nodeHmac(new Uint8Array(32), 'input:/data/a'))).toBe(vector.unsalted.firstLeaf.salt);
  });

  it('the seed', () => {
    expect(hex(deriveInputSeed(SECRET, vector.requestId))).toBe(vector.salted.seed);
  });

  it('the first leaf: its salt and its hash', () => {
    const seed = deriveInputSeed(SECRET, vector.requestId);
    const [first] = inputLeaves(INPUT, seed);
    expect(first).toEqual({
      pointer: vector.salted.firstLeaf.pointer,
      kind: 'value',
      value: 1,
      salt: vector.salted.firstLeaf.salt,
    });
    expect(first === undefined ? '' : hex(inputLeafHash(first))).toBe(vector.salted.firstLeaf.hash);
  });

  it('the leaf contents, in order', () => {
    const contents = inputLeaves(INPUT, UNSALTED_SEED).map((leaf) =>
      JSON.stringify(
        leaf.kind === 'value'
          ? [leaf.pointer, leaf.kind, leaf.value]
          : leaf.kind === 'array'
            ? [leaf.pointer, leaf.kind, leaf.length]
            : [leaf.pointer, leaf.kind],
      ),
    );
    expect(contents).toEqual(CONTENTS);
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
    expect(computeInputDigest(INPUT, UNSALTED_SEED)).toBe(vector.unsalted.inputDigest);
  });

  it('the Merkle root of sha256(a), sha256(b), sha256(c)', () => {
    const leaves = ['a', 'b', 'c'].map((text) => nodeSha256(text));
    expect(hex(merkleRoot(leaves))).toBe(vector.merkle.root);
    expect(hex(referenceRoot(leaves))).toBe(vector.merkle.root);
  });
});
