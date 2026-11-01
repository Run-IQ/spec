import { describe, expect, it } from 'vitest';
import { normalizeRuleDefinition } from '../../src/index.js';
import type { RuleDefinition, UnsignedProof } from '../../src/index.js';
import { carrierRuleFindings } from '../../src/proof/carrier-rules.js';
import { contextOf } from '../../src/proof/consistency.js';
import { outputProof } from '../proof-builders.js';
import { ruleA, unsaltedSalt } from '../proof-cases.js';

// The carriers against their definitions on proofs repeating one rule: what derives from the
// rules alone (a carrier's exception signatures, whether it selects a target) is computed once
// per definition or pair, never once per entry (counters, not clocks).

const salt = unsaltedSalt('rules', 0);

/**
 * `n` applied instances of the carrier X, and `n` entries of T pending behind the carrier Y;
 * X and Y carry `e` exceptions each (Y one more, selecting T).
 */
function repeated(n: number, e: number): [UnsignedProof, Map<string, RuleDefinition>] {
  const proof = outputProof({ type: 'number', combine: 'sum', value: 0 });
  proof.applied = Array.from({ length: n }, (_, i) => ({
    ruleId: 'X',
    version: 1,
    subject: `/e/@${i}`,
    model: 'M',
    output: 'value',
    contribution: 0,
    status: 'determined' as const,
    stratum: 0,
    salt,
  }));
  proof.pending = Array.from({ length: n }, (_, i) => ({
    ruleId: 'T',
    version: 1,
    subject: `/f/@${i}`,
    reason: 'PENDING_CARRIER',
    detail: 'x',
    missing: [],
    carrier: { ruleId: 'Y', version: 1 },
    stratum: 0,
    salt,
  }));
  const exceptions = Array.from({ length: e }, (_, j) => ({
    kind: 'inhibit' as const,
    targets: { tags: [`t${j}`], dimensions: { d: 'v' } },
  }));
  const selectsT = { kind: 'inhibit' as const, targets: { ids: ['T'] } };
  const definitions = new Map<string, RuleDefinition>([
    ['X@1', normalizeRuleDefinition({ ...ruleA, id: 'X', exceptions })],
    ['Y@1', normalizeRuleDefinition({ ...ruleA, id: 'Y', exceptions: [...exceptions, selectsT] })],
    ['T@1', normalizeRuleDefinition({ ...ruleA, id: 'T' })],
  ]);
  return [proof, definitions];
}

/**
 * The reads of a definition's `exceptions` the carrier checks make: each signature build and
 * each selection (`matchesSelector` over a carrier's selectors) reads it once.
 */
function exceptionReads(n: number, e: number): number {
  const [proof, definitions] = repeated(n, e);
  let reads = 0;
  const watched = new Map(
    [...definitions].map(([key, definition]) => [
      key,
      new Proxy(definition, {
        get(target, property, receiver) {
          if (property === 'exceptions') reads++;
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    ]),
  );
  const found: string[] = [];
  carrierRuleFindings(proof, watched, contextOf(proof), (message) => found.push(message));
  // Each X records none of its exceptions: reported, once per instance.
  expect(found).toHaveLength(n);
  return reads;
}

describe('the carriers against their rules, one rule repeated', () => {
  it('100 000 entries: signatures and selections once per definition or pair', () => {
    for (const e of [1, 50, 200]) {
      const reads = [1, 1_000, 100_000].map((n) => exceptionReads(n, e));
      // One signature build (X) and one selection (Y of T), whatever the entries.
      expect(reads).toEqual([2, 2, 2]);
    }
  }, 600_000);
});
