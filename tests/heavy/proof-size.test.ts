import { describe, expect, it } from 'vitest';
import { sealProof, verifyProof } from '../../src/index.js';
import { inconsistencies } from '../../src/proof/consistency.js';
import { counted, specError } from '../helpers.js';
import { outputProof, wideProof } from '../proof-builders.js';
import { unsaltedSalt } from '../proof-cases.js';
import { unsalted } from '../proof-cases.js';
import type { ProofView } from '../../src/proof/types.js';

// Lists as long as a proof can hold are read in loops: never spread into the arguments of a
// call (a RangeError, reported as "too deeply nested"), and problems stop at the issue cap.

const pad = (i: number): string => String(i).padStart(7, '0');
const salt = unsaltedSalt('rules', 0);
const rule = (id: string) => ({
  id,
  version: 1,
  checksum: 'b'.repeat(64),
  ruleSet: 'local',
  priority: 0,
  salt,
});

/** `n` rules `s<i>`, each excluded INHIBITED by the one exception of `x`. */
function inhibited(n: number): ProofView {
  const proof = outputProof({ type: 'number', combine: 'sum', value: 0 });
  const ids = Array.from({ length: n }, (_, i) => `s${pad(i)}`);
  proof.rules = [...ids.map(rule), rule('x')];
  proof.skipped = ids.map((ruleId) => ({
    ruleId,
    version: 1,
    output: 'value',
    reason: 'INHIBITED',
    status: 'determined',
    stratum: 0,
    salt,
  }));
  proof.exceptions = [
    {
      ruleId: 'x',
      version: 1,
      kind: 'inhibit',
      affected: ids.map((ruleId) => ({ ruleId })),
      status: 'determined',
      stratum: 0,
      salt,
    },
  ];
  return proof;
}

/** One decimal sum of `n` contributions `'1'`, by the rules `r<i>`. */
function summed(n: number): ProofView {
  const ids = Array.from({ length: n }, (_, i) => `r${pad(i)}`);
  const proof = outputProof({ type: 'decimal', combine: 'sum', value: String(n) });
  proof.rules = ids.map(rule);
  proof.outputs[0]!.contributors = ids;
  proof.applied = ids.map((ruleId) => ({
    ruleId,
    version: 1,
    model: 'M',
    output: 'value',
    contribution: '1',
    status: 'determined',
    stratum: 0,
    salt,
  }));
  return proof;
}

/**
 * `n` rules `c<i>` pending on one output, each PENDING_CARRIER behind the next, the last
 * pending UNDETERMINED: a chain of `n` pending carriers down to its root.
 */
function carriers(n: number): ProofView {
  const ids = Array.from({ length: n }, (_, i) => `c${pad(i)}`);
  const proof = outputProof({ type: 'number', combine: 'sum' });
  proof.outputs[0]!.status = 'undetermined';
  proof.outputs[0]!.pending = ids;
  proof.rules = ids.map(rule);
  proof.pending = ids.map((ruleId, i) => ({
    ruleId,
    version: 1,
    output: 'value',
    ...(i + 1 < n
      ? { reason: 'PENDING_CARRIER', detail: 'x', carrier: { ruleId: ids[i + 1]!, version: 1 } }
      : { reason: 'UNDETERMINED', detail: 'missing /a' }),
    missing: [],
    ...(i === 0 ? {} : { fired: false }),
    stratum: 0,
    salt,
  }));
  return proof;
}

/** The property reads of the lists of `proof` that `inconsistencies` makes; none is found. */
function readsOf(proof: ProofView): number {
  const counter = { reads: 0 };
  const watched: ProofView = {
    ...proof,
    rules: counted(proof.rules, counter),
    outputs: proof.outputs.map((output) => ({
      ...output,
      contributors: counted(output.contributors, counter),
    })),
    applied: counted(proof.applied, counter),
    skipped: counted(proof.skipped, counter),
    exceptions: proof.exceptions.map((exception) => ({
      ...exception,
      affected: counted(exception.affected, counter),
    })),
    factsRead: counted(proof.factsRead, counter),
    pending: counted(proof.pending, counter),
  };
  expect(inconsistencies(watched)).toEqual([]);
  return counter.reads;
}

/** The reads at `n` and `2n` agree with linear work: twice, up to the fixed reads of a list. */
function expectLinear(build: (n: number) => ProofView, n: number): void {
  const once = readsOf(build(n));
  const twice = readsOf(build(2 * n));
  expect(once).toBeGreaterThan(n);
  expect(twice).toBeLessThanOrEqual(2 * once + 200);
  expect(twice).toBeGreaterThanOrEqual(2 * once - 200);
}

describe('proofs as large as the format allows', () => {
  it('300 000 facts read out of order: refused in full, never "too deeply nested"', () => {
    const proof = outputProof({ type: 'number', combine: 'sum', value: 0 });
    proof.factsRead = Array.from({ length: 300_000 }, (_, i) => ({
      path: `/f/${pad(300_000 - i)}`,
      salt,
    }));
    expect(specError(() => sealProof(unsalted(proof))).message).toBe(
      'Cannot seal the proof: factsRead not sorted at 1',
    );
    const result = verifyProof({ ...proof, digest: '0'.repeat(64) });
    expect(result.status).toBe('invalid');
    expect(result.issues.length).toBe(101);
    expect(result.issues.slice(0, 3)).toEqual([
      'digest mismatch',
      'factsRead not sorted at 1',
      'factsRead not sorted at 2',
    ]);
    expect(result.issues.at(-1)).toBe('further problems not listed (limit 100)');
  }, 600_000);

  it('200 000 affected rules: sealed and verified, in linear work', () => {
    const proof = sealProof(unsalted(inhibited(200_000)));
    expect(verifyProof(proof)).toEqual({ status: 'consistent', issues: ['unsigned'] });
    expectLinear(inhibited, 100_000);
  }, 600_000);

  it('250 000 contributors: sealed and verified, in linear work', () => {
    const proof = sealProof(unsalted(summed(250_000)));
    expect(verifyProof(proof)).toEqual({ status: 'consistent', issues: ['unsigned'] });
    expectLinear(summed, 125_000);
  }, 600_000);

  it('a chain of 100 000 pending carriers: sealed and verified, in linear work', () => {
    const proof = sealProof(unsalted(carriers(100_000)));
    expect(verifyProof(proof)).toEqual({ status: 'consistent', issues: ['unsigned'] });
    expectLinear(carriers, 50_000);
  }, 600_000);

  it('80 000 steps: verified in work linear in their number', () => {
    // 80 000 steps: 40 000 feeding as many outputs, 40 000 feeding the items of one output.
    const steps = (n: number): ProofView => {
      const content = wideProof(n, 'decimal');
      content.rules = content.rules.filter((r) => r.id.startsWith('a') || r.id === 'k');
      content.skipped = [];
      content.exceptions = [];
      content.factsRead = [];
      return content;
    };
    const proof = sealProof(unsalted(steps(40_000)));
    expect(proof.applied.length).toBe(80_000);
    expect(verifyProof(proof)).toEqual({ status: 'consistent', issues: ['unsigned'] });
    expectLinear(steps, 20_000);
  }, 600_000);
});
