import { describe, expect, it, vi } from 'vitest';
import { normalizeRuleDefinition } from '../../src/index.js';
import type { RuleDefinition, RuleDefinitionInput, UnsignedProof } from '../../src/index.js';
import { carrierRuleFindings } from '../../src/proof/carrier-rules.js';
import { contextOf } from '../../src/proof/consistency.js';
import { Scope } from '../../src/proof/ties.js';
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

/**
 * The property reads of the decisions of `proof` and of `rules` the carrier checks make, and
 * the carrier instances they mark in a trie (`Scope`); none is found.
 */
function costOf(
  proof: UnsignedProof,
  rules: ReadonlyMap<string, RuleDefinition> = definitions,
): { reads: number; marks: number } {
  const mark = vi.spyOn(Scope.prototype, 'mark');
  try {
    const reads = readsOf(proof, rules);
    return { reads, marks: mark.mock.calls.length };
  } finally {
    mark.mockRestore();
  }
}

/** The property reads of `costOf`. */
function readsOf(
  proof: UnsignedProof,
  rules: ReadonlyMap<string, RuleDefinition> = definitions,
): number {
  const counter = { reads: 0 };
  const watched: UnsignedProof = {
    ...proof,
    applied: proof.applied.map((step) => counted(step, counter)),
    pending: proof.pending.map((entry) => counted(entry, counter)),
  };
  const read = new Map([...rules].map(([key, rule]) => [key, counted(rule, counter)]));
  const found: string[] = [];
  carrierRuleFindings(watched, read, contextOf(proof), (message) => found.push(message));
  expect(found).toEqual([]);
  return counter.reads;
}

/**
 * `k` carrier rules X<i>, each pending once without firing at `/e/<i>` and selecting the tag
 * `vat` (or T by id, every other one), and `n` steps of T, tagged `vat`, at `/f/<i>`: no step
 * is in the scope of a carrier.
 */
function manyCarriers(k: number, n: number): [UnsignedProof, Map<string, RuleDefinition>] {
  const proof = hostile(n);
  proof.pending = Array.from({ length: k }, (_, i) => ({
    ...proof.pending[0]!,
    ruleId: `X${pad(i)}`,
  }));
  proof.pending = proof.pending.map((entry, i) => ({ ...entry, subject: `/e/${pad(i)}` }));
  const rules = new Map([['T@1', definition({ ...ruleA, id: 'T', tags: ['vat'] })]]);
  for (let i = 0; i < k; i++) {
    const targets = i % 2 === 0 ? { tags: ['vat'] } : { ids: ['T'] };
    const exceptions = [{ kind: 'inhibit' as const, targets }];
    rules.set(`X${pad(i)}@1`, definition({ ...ruleA, id: `X${pad(i)}`, exceptions }));
  }
  return [proof, rules];
}

const step = (ruleId: string) => ({
  ruleId,
  version: 1,
  subject: `/f/${pad(0)}`,
  model: 'M',
  output: 'value',
  contribution: 1,
  status: 'determined' as const,
  stratum: 0,
  salt,
});

/**
 * Carriers pending without firing, `n` instances each at `/e/<i>`: X selecting the tag `vat`
 * (and, with `groups`, W selecting `gst`); `m` target rules T<i> with one step each at
 * `/f/0`, tagged `vat` (with `groups`: `vat`, `gst` or both, in turn: three groups of target
 * rules by the carriers selecting them). No step is in the scope of a carrier.
 */
function broad(n: number, m: number, groups = false): [UnsignedProof, Map<string, RuleDefinition>] {
  const proof = outputProof({ type: 'number', combine: 'sum', value: m });
  proof.applied = Array.from({ length: m }, (_, i) => step(`T${pad(i)}`));
  const carriers = groups ? ['W', 'X'] : ['X'];
  proof.pending = carriers.flatMap((ruleId) =>
    hostile(n).pending.map((entry) => ({ ...entry, ruleId })),
  );
  const selecting = (id: string, tag: string) =>
    definition({ ...ruleA, id, exceptions: [{ kind: 'inhibit', targets: { tags: [tag] } }] });
  const rules = new Map([['X@1', selecting('X', 'vat')]]);
  if (groups) rules.set('W@1', selecting('W', 'gst'));
  const tagsOf = (i: number): string[] =>
    groups ? [['vat'], ['gst'], ['vat', 'gst']][i % 3]! : ['vat'];
  for (let i = 0; i < m; i++) {
    rules.set(`T${pad(i)}@1`, definition({ ...ruleA, id: `T${pad(i)}`, tags: tagsOf(i) }));
  }
  return [proof, rules];
}

/** The reads of the carrier checks on `manyCarriers(k, n)`. */
const readsWith = (k: number, n: number): number => readsOf(...manyCarriers(k, n));

describe('the carriers against their rules, on hostile proofs', () => {
  it('20 000 carrier instances and 20 000 target steps: reads linear in their number', () => {
    const once = readsOf(hostile(10_000));
    const twice = readsOf(hostile(20_000));
    expect(once).toBeGreaterThan(10_000);
    expect(twice).toBeLessThanOrEqual(2 * once + 200);
    expect(twice).toBeGreaterThanOrEqual(2 * once - 200);
  }, 600_000);

  it('4 000 carrier rules and 20 000 target steps: reads linear in their sum', () => {
    const one = readsWith(1, 20_000);
    const thousand = readsWith(1_000, 20_000);
    const many = readsWith(4_000, 20_000);
    // Each carrier rule costs a few reads (a tag and an id selector differ by a few), whatever
    // the number of carriers or steps: never one per other rule, nor one per step.
    expect(Math.abs(many - thousand - 3 * (thousand - one))).toBeLessThanOrEqual(3_000);
    expect(thousand - one).toBe(readsWith(1_000, 10_000) - readsWith(1, 10_000));
    expect(thousand - one).toBeLessThan(1_000 * 100);
  }, 600_000);

  it('one broad carrier, 20 000 instances, 400 targets: marks the instances once', () => {
    const cost = (n: number, m: number) => costOf(...broad(n, m));
    const [one, hundred, many] = [1, 100, 400].map((m) => cost(20_000, m));
    // One trie for the target rules X selects: its instances marked once, whatever their number.
    expect([one!.marks, hundred!.marks, many!.marks]).toEqual([20_000, 20_000, 20_000]);
    // Each target rule costs the same few reads, whatever the instances.
    const perTargets = many!.reads - one!.reads;
    expect(perTargets).toBe(cost(10_000, 400).reads - cost(10_000, 1).reads);
    expect((hundred!.reads - one!.reads) * 399).toBe(perTargets * 99);
    expect(perTargets).toBeLessThan(399 * 100);
  }, 600_000);

  it('two carriers, three groups of targets: each group marks its carriers once', () => {
    const cost = (n: number, m: number) => costOf(...broad(n, m, true));
    // `vat` (X), `gst` (W), both (W and X): n + n + 2n marks, whatever the targets.
    expect(cost(10_000, 3).marks).toBe(40_000);
    expect(cost(10_000, 300).marks).toBe(40_000);
    const perInstances = cost(20_000, 300).reads - cost(10_000, 300).reads;
    expect(perInstances).toBe(cost(20_000, 3).reads - cost(10_000, 3).reads);
  }, 600_000);
});
