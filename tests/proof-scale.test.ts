import { describe, expect, it } from 'vitest';
import { verifyProof } from '../src/index.js';
import type { UnsignedProof } from '../src/index.js';
import { inconsistencies, nonCanonicalDecimals, strataProblems } from '../src/proof/digest.js';

const name = (i: number): string => `o${String(i).padStart(7, '0')}`;

/**
 * A proof of `n` outputs in one stratum, each fed by one applied rule, listed in reverse order
 * so that a scan from the start finds each output late.
 */
function wide(n: number, type: 'number' | 'decimal'): UnsignedProof {
  const value = type === 'decimal' ? '1.5' : 1.5;
  const outputs: UnsignedProof['outputs'] = {};
  const stratum: string[] = [];
  const applied: UnsignedProof['applied'] = [];
  for (let i = 0; i < n; i++) {
    outputs[name(i)] = { type, combine: 'sum', value, contributors: ['a'] };
    stratum.push(name(i));
    applied.push({
      ruleId: 'a',
      version: 1,
      model: 'M',
      output: name(n - 1 - i),
      contribution: value,
      ...(type === 'decimal' ? { unrounded: '1.5' } : {}),
      stratum: 0,
    });
  }
  return {
    format: 'run-iq.proof/1',
    requestId: 'r',
    evaluatedAt: null,
    sealedAt: '2025-06-01T10:00:00.000Z',
    inputDigest: '0'.repeat(64),
    rules: [{ id: 'a', version: 1, checksum: '1'.repeat(64) }],
    versions: { engine: '1', plugins: {}, dsls: {} },
    strata: [stratum],
    outputs,
    applied,
    skipped: [],
    exceptions: [],
  };
}

/** `target` behind a Proxy that counts every property read. */
function counted<T extends object>(target: T, counter: { reads: number }): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      counter.reads++;
      return Reflect.get(object, key, receiver) as unknown;
    },
  });
}

const N = 2_000;
/**
 * The most property reads allowed per output: c = 30. The linear checks read the stratum and
 * the applied list a fixed number of times (an iterator also reads `length` at each step):
 * about 5 reads per output for strataProblems, 2 for nonCanonicalDecimals and 11 for
 * inconsistencies. A check that scans the stratum or the applied list once per step reads
 * about N / 2 = 1 000 times per output instead.
 */
const READS_PER_OUTPUT = 30;

describe('proof consistency checks are linear', () => {
  const checks = [
    ['strataProblems', strataProblems],
    ['nonCanonicalDecimals', nonCanonicalDecimals],
    ['inconsistencies', inconsistencies],
  ] as const;

  it.each(
    checks.flatMap(([label, check]) =>
      (['number', 'decimal'] as const).map((type) => [label, type, check] as const),
    ),
  )('%s reads the stratum and the steps O(N) times (%s outputs)', (_label, type, check) => {
    const counter = { reads: 0 };
    const proof = wide(N, type);
    const stratum = proof.strata[0]!;
    proof.strata = [counted(stratum, counter)];
    proof.applied = counted(proof.applied, counter);
    expect(check(proof)).toEqual([]);
    expect(counter.reads).toBeGreaterThan(0);
    expect(counter.reads).toBeLessThanOrEqual(READS_PER_OUTPUT * N);
  });
});

describe('verifyProof on a wide proof', () => {
  it('verifies 20 000 decimal outputs and steps', () => {
    const proof = { ...wide(20_000, 'decimal'), digest: '0'.repeat(64) };
    expect(verifyProof(proof)).toEqual({
      status: 'invalid',
      issues: ['digest mismatch', 'unsigned'],
    });
  });
});
