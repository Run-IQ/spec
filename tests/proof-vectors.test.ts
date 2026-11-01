import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import {
  merkleRoot,
  proofLeafHash,
  proofLeafHashes,
  sealProof,
  validateProof,
  verifyProof,
} from '../src/index.js';
import type { DecisionProof, ProofLeaf, UnsaltedProof } from '../src/index.js';
import { fromHex, hex, nodeHmac, nodeSha256 } from './hashing.js';
import { treeDigestOf } from './helpers.js';
import inputVector from './vectors/input-v1.json';
import vector from './vectors/proof-v1.json';

const SEED = fromHex(vector.seed);
const PLAN = vector.sealed;
const unsaltedProof = PLAN.proof as unknown as UnsaltedProof;

/** The proof digest of `leaves`, by node:crypto: sha256(0x02 ‖ T ‖ uint64be(n) ‖ root). */
function nodeProofDigest(leaves: readonly Uint8Array[]): string {
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(leaves.length));
  return hex(nodeSha256(new Uint8Array([2]), 'run-iq.proof/1\u0000', count, merkleRoot(leaves)));
}

describe('the frozen proof-v1 vector (D-14, D-16), recomputed by an independent Python script', () => {
  it('uses the seed of input-v1 and its salted input digest', () => {
    expect(vector.seed).toBe(inputVector.salted.seed);
    expect(PLAN.proof.inputDigest).toBe(inputVector.salted.inputDigest);
  });

  it.each([
    ['@run-iq/spec', sealProof],
    ['@run-iq/spec/canonical', canonicalEntry.sealProof],
  ])('%s seals the proof to its salts, leaves and digest', (_entry, seal) => {
    const sealed = seal(unsaltedProof, SEED) as DecisionProof & Record<string, unknown>;
    const salts = (section: 'rules' | 'outputs' | 'applied') =>
      (sealed[section][0] as { salt: string }).salt;
    expect({ rules: salts('rules'), outputs: salts('outputs'), applied: salts('applied') }).toEqual(
      {
        rules: PLAN.salts['rules/0'],
        outputs: PLAN.salts['outputs/0'],
        applied: PLAN.salts['applied/0'],
      },
    );
    const leaves = proofLeafHashes(sealed);
    expect(leaves.map(hex)).toEqual(PLAN.leaves);
    expect(leaves).toHaveLength(PLAN.leafCount);
    expect(hex(merkleRoot(leaves))).toBe(PLAN.merkleRoot);
    expect(sealed.digest).toBe(PLAN.digest);
    expect(nodeProofDigest(leaves)).toBe(PLAN.digest);
    expect(verifyProof(sealed)).toEqual({ status: 'consistent', issues: ['unsigned'] });
  });

  it('salts each entry with the first 16 bytes of HMAC-SHA256(seed, "proof:" + section + ":" + index)', () => {
    for (const [key, salt] of Object.entries(PLAN.salts)) {
      const [section, index] = key.split('/');
      expect(hex(nodeHmac(SEED, `proof:${section}:${index}`).subarray(0, 16))).toBe(salt);
    }
  });

  it('keeps the values of the plan that still hold, and rebuilds the others', () => {
    // The plan's salts and the leaves of outputs/0 and applied/0 are unchanged.
    expect(PLAN.leaves.slice(2)).toEqual([
      'deae2a8e2ed38a9d36c5e4ee765229806ffdd32ebfebcbe5046a585bef7923f8',
      '58f27d7ef5824335c14a073a5495679ea869de798baf9b17b98e0cd663c882ce',
    ]);
    // Its header leaf is that of the input digest of input-v1 before Task 9H2 (round 3).
    const header = Object.fromEntries(
      Object.entries(PLAN.proof).filter(([key]) => !isSection(key)),
    );
    const oldHeader = proofLeafHash({
      s: 'header',
      e: { ...header, inputDigest: PLAN.plan.inputDigest },
    } as ProofLeaf);
    expect(hex(oldHeader)).toBe('9552348910ee15465b77128c44bc269725da0641577d7a4a227c4160b20fbba0');
    expect(PLAN.plan.headerLeaf).toBe(hex(oldHeader));
    // Its rule had no priority (Task 9J made it required): the leaf, by node:crypto.
    const ruleLeaf = nodeSha256(
      new Uint8Array([0]),
      'run-iq.proof/1\u0000',
      `{"e":{"checksum":"${'ab'.repeat(32)}","id":"R1","ruleSet":"local","salt":"${PLAN.salts['rules/0']}","version":1},"i":0,"s":"rules"}`,
    );
    expect(hex(ruleLeaf)).toBe('cb99c513b2a1722a75de92bb56fb658c097ff85012af65abddc9efd4478abe1f');
    expect(PLAN.plan.ruleLeaf).toBe(hex(ruleLeaf));
    // Its digest was the bare root of those leaves, before the digest committed to their count.
    const planLeaves = [oldHeader, ruleLeaf, ...PLAN.leaves.slice(2).map(fromHex)];
    expect(hex(merkleRoot(planLeaves))).toBe(
      '34e56aff10f280f71329210a6b7feaa259fba62bec6271614f71f8d504af4ca6',
    );
    expect(PLAN.plan.merkleRoot).toBe(hex(merkleRoot(planLeaves)));
  });

  it('hashes a proof with escapes, astral characters, decimals, nested lists, index 10 and a redacted entry', () => {
    const rich = vector.redacted;
    const proof = rich.proof as unknown as DecisionProof;
    const leaves = proofLeafHashes(proof);
    expect(leaves.map(hex)).toEqual(rich.leaves);
    expect(leaves).toHaveLength(rich.leafCount);
    expect(hex(merkleRoot(leaves))).toBe(rich.merkleRoot);
    expect(nodeProofDigest(leaves)).toBe(rich.digest);
    expect(treeDigestOf(proof)).toBe(rich.digest);
    expect(canonicalEntry.proofLeafHashes(proof).map(hex)).toEqual(rich.leaves);
    // The redacted missing fact gives its leaf as it is.
    expect(rich.leaves.at(-1)).toBe((proof.missingFacts[0] as { redacted: string }).redacted);
    expect(validateProof({ ...proof, digest: rich.digest }).issues).toEqual([]);
  });
});

function isSection(key: string): boolean {
  return [
    'rules',
    'outputs',
    'items',
    'applied',
    'skipped',
    'pending',
    'exceptions',
    'factsRead',
    'missingFacts',
    'readsUndeclared',
  ].includes(key);
}
