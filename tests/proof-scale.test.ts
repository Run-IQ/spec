import { describe, expect, it } from 'vitest';
import { arithmeticWork } from '../src/proof/arithmetic.js';
import { inconsistencies, orderProblems } from '../src/proof/consistency.js';
import { strataProblems } from '../src/proof/placement.js';
import { nonCanonicalDecimals, offDeclarationValues } from '../src/proof/output-values.js';
import {
  inclusionPath,
  proofLeafHash,
  proofLeafHashes,
  sealProof,
  verifyProofInclusion,
} from '../src/index.js';
import type { ProofLeaf } from '../src/index.js';
import { hashWork } from '../src/stream.js';
import { counted } from './helpers.js';
import { unsalted } from './proof-cases.js';
import { wideProof } from './proof-builders.js';
import type { ProofView } from '../src/proof/types.js';

/** The reads of the lists of `wideProof(n, type)` that `check` makes. */
function readsOf(check: (p: ProofView) => string[], n: number, type: 'number' | 'decimal') {
  const counter = { reads: 0 };
  const proof = wideProof(n, type);
  proof.strata = [counted(proof.strata[0]!, counter)];
  proof.rules = counted(proof.rules, counter);
  proof.outputs = counted(proof.outputs, counter);
  proof.items = counted(proof.items, counter);
  proof.applied = counted(proof.applied, counter);
  proof.skipped = counted(proof.skipped, counter);
  proof.exceptions = [
    { ...proof.exceptions[0]!, affected: counted(proof.exceptions[0]!.affected, counter) },
  ];
  proof.factsRead = counted(proof.factsRead, counter);
  expect(check(proof)).toEqual([]);
  return counter.reads;
}

const listed = (p: ProofView) => new Map(p.outputs.map((output) => [output.name, output]));

const N = 2_000;

describe('proof consistency checks are linear', () => {
  const checks = [
    ['inconsistencies', inconsistencies],
    ['orderProblems', (p: ProofView) => orderProblems(p, listed(p))],
    ['strataProblems', (p: ProofView) => strataProblems(p, listed(p))],
    ['nonCanonicalDecimals', nonCanonicalDecimals],
    ['offDeclarationValues', offDeclarationValues],
  ] as const;

  it.each(
    checks.flatMap(([label, check]) =>
      (['number', 'decimal'] as const).map((type) => [label, type, check] as const),
    ),
  )(
    '%s reads each list a fixed number of times (%s outputs): twice the proof, twice the reads',
    (_label, type, check) => {
      const once = readsOf(check, N, type);
      const twice = readsOf(check, 2 * N, type);
      expect(once).toBeGreaterThan(N);
      // Linear: the reads of a proof twice as large are twice those of the proof, up to the
      // fixed reads of each list; a scan per entry, or a sort, reads N more at least.
      expect(twice).toBeLessThanOrEqual(2 * once + 200);
      expect(twice).toBeGreaterThanOrEqual(2 * once - 200);
    },
    60_000,
  );

  it('the arithmetic of the combination goes through each digit a fixed number of times', () => {
    const digitsOf = (n: number): number => {
      const before = arithmeticWork().digits;
      expect(inconsistencies(wideProof(n, 'decimal'))).toEqual([]);
      return arithmeticWork().digits - before;
    };
    const once = digitsOf(N);
    expect(once).toBeGreaterThan(N);
    expect(digitsOf(2 * N)).toBe(2 * once);
  });
});

describe('the proof tree is linear, and one leaf is checked in O(log n) (D-16)', () => {
  /** The sha256 calls and bytes of the leaves and digest of the sealed `wideProof(n)`. */
  function workOf(n: number): { calls: number; bytes: number; leaves: number } {
    const sealed = sealProof(unsalted(wideProof(n, 'decimal')));
    const before = { ...hashWork };
    const leaves = proofLeafHashes(sealed).length;
    return { calls: hashWork.calls - before.calls, bytes: hashWork.bytes - before.bytes, leaves };
  }

  it('hashes each leaf once: twice the proof, twice the work', () => {
    const once = workOf(N);
    const twice = workOf(2 * N);
    expect(once.calls).toBe(once.leaves);
    expect(twice.calls).toBe(twice.leaves);
    expect(twice.leaves).toBeLessThanOrEqual(2 * once.leaves);
    // Up to one more digit per leaf: its index in its section.
    expect(twice.bytes).toBeLessThanOrEqual(2 * once.bytes + twice.leaves);
  });

  it('checks one leaf from the header, the leaf and its path only', () => {
    const sealed = sealProof(unsalted(wideProof(N, 'decimal')));
    const leaves = proofLeafHashes(sealed);
    const index = 1 + sealed.rules.length + 3;
    const path = inclusionPath(leaves, index);
    let reads = 0;
    const watched = new Proxy(path, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const before = hashWork.calls;
    const entry = (sealed.outputs as object[])[3]!;
    const leaf = proofLeafHash({ s: 'outputs', i: 3, e: entry } as ProofLeaf, 'run-iq.proof/1');
    expect(
      verifyProofInclusion(sealed.digest, leaves.length, index, leaf, watched, 'run-iq.proof/1'),
    ).toBe(true);
    expect(reads).toBe(Math.ceil(Math.log2(leaves.length)));
    // One leaf hash, one node hash per level, the digest: never another leaf.
    expect(hashWork.calls - before).toBe(1 + path.length + 1);
  });
});
