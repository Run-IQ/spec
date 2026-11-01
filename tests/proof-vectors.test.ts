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
import { fromHex, hex, nodeHmac, nodeSha256, referenceRoot } from './hashing.js';
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
  return hex(nodeSha256(new Uint8Array([2]), 'run-iq.proof/1\u0000', count, referenceRoot(leaves)));
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

// From first principles, apart from the helpers of src: RFC 8785 written here (keys by UTF-16
// code units, strings as JSON.stringify, numbers as ECMAScript writes them), sha256 and HMAC of
// node:crypto, the RFC 6962 tree written recursively as the RFC writes it.

const SECTIONS = [
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
] as const;
const PREFIX = 'run-iq.proof/1\u0000';

/** RFC 8785 text of a JSON value, by hand. */
function jcs(value: unknown): string {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('not JSON');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  const record = value as Record<string, unknown>;
  const byUnits = (a: string, b: string): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const d = a.charCodeAt(i) - b.charCodeAt(i);
      if (d !== 0) return d;
    }
    return a.length - b.length;
  };
  const keys = Object.keys(record).sort(byUnits);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`).join(',')}}`;
}

const leafOf = (leaf: object): Uint8Array => nodeSha256(new Uint8Array([0]), PREFIX, jcs(leaf));

/** The leaves of a proof, by D-16. */
function firstLeaves(proof: Record<string, unknown>): Uint8Array[] {
  const header = Object.fromEntries(
    Object.entries(proof).filter(
      ([key]) => key !== 'digest' && key !== 'signature' && !SECTIONS.includes(key as never),
    ),
  );
  const leaves = [leafOf({ s: 'header', e: header })];
  for (const section of SECTIONS) {
    (proof[section] as Record<string, unknown>[]).forEach((e, i) => {
      leaves.push(
        typeof e.redacted === 'string' ? fromHex(e.redacted) : leafOf({ s: section, i, e }),
      );
    });
  }
  return leaves;
}

const saltOf = (section: string, i: number): string =>
  hex(nodeHmac(SEED, `proof:${section}:${i}`).subarray(0, 16));

describe('proof-v1 rebuilt from first principles (JCS, sha256, HMAC and RFC 6962 by hand)', () => {
  it('the sealed proof: salts, leaves, root and digest', () => {
    const salted: Record<string, unknown> = { ...PLAN.proof };
    for (const section of SECTIONS) {
      salted[section] = (PLAN.proof[section] as object[]).map((e, i) => ({
        ...e,
        salt: saltOf(section, i),
      }));
    }
    expect({
      rules: saltOf('rules', 0),
      outputs: saltOf('outputs', 0),
      applied: saltOf('applied', 0),
    }).toEqual({
      rules: PLAN.salts['rules/0'],
      outputs: PLAN.salts['outputs/0'],
      applied: PLAN.salts['applied/0'],
    });
    const leaves = firstLeaves(salted);
    expect(leaves.map(hex)).toEqual(PLAN.leaves);
    expect(leaves).toHaveLength(PLAN.leafCount);
    expect(hex(referenceRoot(leaves))).toBe(PLAN.merkleRoot);
    expect(nodeProofDigest(leaves)).toBe(PLAN.digest);
  });

  it('the richer redacted proof: leaves, root and digest, the redacted leaf among them', () => {
    const rich = vector.redacted;
    const proof = rich.proof as unknown as Record<string, unknown>;
    const leaves = firstLeaves(proof);
    expect(leaves.map(hex)).toEqual(rich.leaves);
    expect(leaves).toHaveLength(rich.leafCount);
    expect(hex(referenceRoot(leaves))).toBe(rich.merkleRoot);
    expect(nodeProofDigest(leaves)).toBe(rich.digest);
    // Its salts are those of the seed, and the hidden missing fact's leaf is the one given.
    for (const section of SECTIONS) {
      (proof[section] as Record<string, unknown>[]).forEach((e, i) => {
        if (typeof e.redacted !== 'string') expect(e.salt).toBe(saltOf(section, i));
      });
    }
  });

  it("the plan's values, from the reasons the vector records", () => {
    const { plan } = PLAN;
    expect(vector.sealed.note).toContain('before Task 9H2 (round 3)');
    expect(vector.sealed.note).toContain('priority');
    expect(vector.sealed.note).toContain('leaf count');
    const header = Object.fromEntries(
      Object.entries(PLAN.proof).filter(([key]) => !SECTIONS.includes(key as never)),
    );
    const oldHeader = leafOf({ s: 'header', e: { ...header, inputDigest: plan.inputDigest } });
    expect(hex(oldHeader)).toBe(plan.headerLeaf);
    const ruleLeaf = leafOf({ s: 'rules', i: 0, e: plan.rule });
    expect(hex(ruleLeaf)).toBe(plan.ruleLeaf);
    const planLeaves = [oldHeader, ruleLeaf, ...PLAN.leaves.slice(2).map(fromHex)];
    expect(hex(referenceRoot(planLeaves))).toBe(plan.merkleRoot);
  });
});
