import { describe, expect, it } from 'vitest';
import { verifyProof } from '../src/index.js';

/**
 * A proof of `n` outputs in one stratum, each fed by one applied rule, listed in reverse
 * order. Every consistency check must stay linear in the size of the proof: a check that
 * scans a stratum or the applied list once per output or per step takes minutes here.
 */
function wide(n: number, type: 'number' | 'decimal'): unknown {
  const name = (i: number): string => `o${String(i).padStart(7, '0')}`;
  const outputs: Record<string, unknown> = {};
  const stratum: string[] = [];
  const applied: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const value = type === 'decimal' ? '1.5' : 1.5;
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
    digest: '0'.repeat(64),
  };
}

const STEPS = 200_000;
/** Linear checks verify such a proof in a few seconds; quadratic ones took about 3 minutes. */
const BOUND_MS = 30_000;

describe('verifyProof scales linearly', () => {
  it.each(['number', 'decimal'] as const)(
    `checks ${STEPS} %s outputs and steps within the bound`,
    (type) => {
      const proof = wide(STEPS, type);
      const start = performance.now();
      const result = verifyProof(proof);
      const elapsed = performance.now() - start;
      expect(result).toEqual({ status: 'invalid', issues: ['digest mismatch', 'unsigned'] });
      expect(elapsed).toBeLessThan(BOUND_MS);
    },
    120_000,
  );
});
