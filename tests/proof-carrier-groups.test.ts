import { describe, expect, it } from 'vitest';
import { normalizeRuleDefinition } from '../src/index.js';
import type { RuleDefinition, RuleDefinitionInput, UnsignedProof } from '../src/index.js';
import { carrierRuleFindings } from '../src/proof/carrier-rules.js';
import { contextOf } from '../src/proof/consistency.js';
import { outputProof } from './proof-builders.js';
import { ruleA, unsaltedSalt } from './proof-cases.js';

// The targets of carriers pending without firing, each judged against exactly the carriers its
// definition says select it, whether their instances are asked one carrier at a time or merged.

const salt = unsaltedSalt('rules', 0);
const step = (ruleId: string, subject: string) => ({
  ruleId,
  version: 1,
  subject,
  model: 'M',
  output: 'value',
  contribution: 1,
  status: 'determined' as const,
  stratum: 0,
  salt,
});
const pending = (ruleId: string, subject: string) => ({
  ruleId,
  version: 1,
  subject,
  reason: 'UNDETERMINED',
  detail: 'missing /a',
  missing: [],
  fired: false,
  stratum: 0,
  salt,
});
const definition = (id: string, extra: Partial<RuleDefinitionInput>): RuleDefinition =>
  normalizeRuleDefinition({ ...ruleA, id, ...extra });

/**
 * X selects `vat` (A, B), W the model M2 (A, C), V the id A; D none. X is pending at /e/1, W at
 * /e/2, V at /e/3, each also at `far` subjects under /z, out of every step's scope.
 */
function found(far: number): string[] {
  const proof: UnsignedProof = outputProof({ type: 'number', combine: 'sum', value: 0 });
  const subjects = ['/e/1', '/e/2', '/e/3', '/e/4'];
  proof.applied = [
    ...['A', 'B', 'C', 'D'].flatMap((id) => subjects.map((subject) => step(id, subject))),
    step('B', '/e/1/x'),
    step('C', '/e'),
  ];
  const away = (id: string) => Array.from({ length: far }, (_, i) => pending(id, `/z/${i}`));
  proof.pending = [
    pending('V', '/e/3'),
    ...away('V'),
    pending('W', '/e/2'),
    ...away('W'),
    pending('X', '/e/1'),
    ...away('X'),
  ];
  const definitions = new Map<string, RuleDefinition>([
    ['A@1', definition('A', { tags: ['vat'], model: 'M2' })],
    ['B@1', definition('B', { tags: ['vat'] })],
    ['C@1', definition('C', { model: 'M2' })],
    ['D@1', definition('D', {})],
    ['X@1', definition('X', { exceptions: [{ kind: 'inhibit', targets: { tags: ['vat'] } }] })],
    [
      'W@1',
      definition('W', {
        exceptions: [{ kind: 'substitute', targets: { models: ['M2'] }, params: {} }],
      }),
    ],
    ['V@1', definition('V', { exceptions: [{ kind: 'inhibit', targets: { ids: ['A'] } }] })],
  ]);
  const messages: string[] = [];
  carrierRuleFindings(proof, definitions, contextOf(proof), (message) => messages.push(message));
  return messages;
}

const decided = (instances: string[]): string[] =>
  instances.map((instance) => `target decided as if its carrier were not pending: ${instance}`);

describe('the targets of the carriers pending without firing, given the rules', () => {
  const expected = decided([
    'A@1 at /e/1',
    'A@1 at /e/2',
    'A@1 at /e/3',
    'B@1 at /e/1',
    'C@1 at /e/2',
    'B@1 at /e/1/x',
    'C@1 at /e',
  ]);

  it('judges each target against exactly the carriers selecting it, in decision order', () => {
    expect(found(0)).toEqual(expected);
  });

  it('judges the same with many carrier instances, asked one carrier at a time', () => {
    expect(found(40)).toEqual(expected);
  });
});
