import { describe, expect, it } from 'vitest';
import { normalizeRuleDefinition } from '../../src/index.js';
import type { RuleDefinition, RuleDefinitionInput, UnsignedProof } from '../../src/index.js';
import { carrierRuleFindings } from '../../src/proof/carrier-rules.js';
import { counted } from '../helpers.js';
import { outputProof } from '../proof-builders.js';
import { ruleA, unsaltedSalt } from '../proof-cases.js';

// The carriers against their definitions (`verifyProof` with `rules`) on hostile proofs: work
// linear in the decisions, never their product with the pending carriers (counters, not clocks).

const pad = (i: number): string => String(i).padStart(7, '0');
const salt = unsaltedSalt('rules', 0);
const definition = (input: RuleDefinitionInput): RuleDefinition => normalizeRuleDefinition(input);

/**
 * `n` instances of the carrier X pending without firing, at `/e/<i>`, and `n` steps of its
 * target T at `/f/<i>`: no step is in the scope of any carrier instance, so each pair is a
 * question a quadratic check would ask.
 */
function hostile(n: number): UnsignedProof {
  const proof = outputProof({ type: 'number', combine: 'sum', value: n });
  proof.outputs[0]!.contributors = ['T'];
  const ref = (id: string) => ({
    id,
    version: 1,
    checksum: 'b'.repeat(64),
    ruleSet: 'local',
    priority: 1,
    salt,
  });
  proof.rules = [ref('T'), ref('X')];
  proof.applied = Array.from({ length: n }, (_, i) => ({
    ruleId: 'T',
    version: 1,
    subject: `/f/${pad(i)}`,
    model: 'M',
    output: 'value',
    contribution: 1,
    status: 'determined' as const,
    stratum: 0,
    salt,
  }));
  proof.pending = Array.from({ length: n }, (_, i) => ({
    ruleId: 'X',
    version: 1,
    subject: `/e/${pad(i)}`,
    reason: 'UNDETERMINED',
    detail: 'missing /a',
    missing: [],
    fired: false,
    stratum: 0,
    salt,
  }));
  return proof;
}

const definitions = new Map<string, RuleDefinition>([
  ['T@1', definition({ ...ruleA, id: 'T' })],
  [
    'X@1',
    definition({ ...ruleA, id: 'X', exceptions: [{ kind: 'inhibit', targets: { ids: ['T'] } }] }),
  ],
]);

/** The property reads of the decisions of `proof` the carrier checks make; none is found. */
function readsOf(proof: UnsignedProof): number {
  const counter = { reads: 0 };
  const watched: UnsignedProof = {
    ...proof,
    applied: proof.applied.map((step) => counted(step, counter)),
    pending: proof.pending.map((entry) => counted(entry, counter)),
  };
  const found: string[] = [];
  carrierRuleFindings(watched, definitions, (message) => found.push(message));
  expect(found).toEqual([]);
  return counter.reads;
}

describe('the carriers against their rules, on hostile proofs', () => {
  it('20 000 carrier instances and 20 000 target steps: reads linear in their number', () => {
    const once = readsOf(hostile(10_000));
    const twice = readsOf(hostile(20_000));
    expect(once).toBeGreaterThan(10_000);
    expect(twice).toBeLessThanOrEqual(2 * once + 200);
    expect(twice).toBeGreaterThanOrEqual(2 * once - 200);
  }, 600_000);
});
