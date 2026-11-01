import { describe, expect, it } from 'vitest';
import type { UnsignedProof } from '../src/index.js';
import { arithmeticWork } from '../src/proof/arithmetic.js';
import { inconsistencies, orderProblems, strataProblems } from '../src/proof/consistency.js';
import { nonCanonicalDecimals, offDeclarationValues } from '../src/proof/output-values.js';
import { wideProof } from './proof-builders.js';

/** `target` behind a Proxy that counts every property read. */
function counted<T extends object>(target: T, counter: { reads: number }): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      counter.reads++;
      return Reflect.get(object, key, receiver) as unknown;
    },
  });
}

/** The reads of the lists of `wideProof(n, type)` that `check` makes. */
function readsOf(check: (p: UnsignedProof) => string[], n: number, type: 'number' | 'decimal') {
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

const listed = (p: UnsignedProof) => new Map(p.outputs.map((output) => [output.name, output]));

const N = 2_000;

describe('proof consistency checks are linear', () => {
  const checks = [
    ['inconsistencies', inconsistencies],
    ['orderProblems', (p: UnsignedProof) => orderProblems(p, listed(p))],
    ['strataProblems', (p: UnsignedProof) => strataProblems(p, listed(p))],
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
