import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  computeRuleFingerprint,
  isEffectiveAt,
  normalizeRuleDefinition,
  verifyRuleChecksum,
} from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function makeInput(): RuleDefinitionInput {
  return {
    id: 'r1',
    version: 1,
    model: 'PROGRESSIVE_BRACKET',
    params: { brackets: [{ from: 0, rate: 0.1, until: undefined }], base: 'income' },
    condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'x' }, 1] } },
    priority: 1,
    effectiveFrom: new Date('2025-01-01T00:00:00Z'),
    effectiveUntil: '2026-01-01T00:00:00+01:00',
    dimensions: { country: 'TG', category: 'VAT' },
    tags: ['z', 'a', 'z'],
    exceptions: ['r0'],
    checksum: 'stale',
    output: undefined,
    jurisdiction: 'NATIONAL',
    extra: { b: 1, a: [3, 1, 2] },
  };
}

const calls: [string, (input: RuleDefinitionInput) => unknown][] = [
  ['normalizeRuleDefinition', normalizeRuleDefinition],
  ['computeRuleChecksum', computeRuleChecksum],
  ['computeRuleFingerprint', computeRuleFingerprint],
  ['verifyRuleChecksum', (i) => verifyRuleChecksum({ ...i, checksum: 'x' })],
  ['isEffectiveAt', (i) => isEffectiveAt(i, new Date('2025-06-01T00:00:00Z'))],
];

describe('purity (A4)', () => {
  it.each(calls)('%s works on a deep-frozen input', (_name, call) => {
    expect(() => call(deepFreeze(makeInput()))).not.toThrow();
  });

  it.each(calls)('%s leaves its input unchanged', (_name, call) => {
    const input = makeInput();
    const before = structuredClone(input);
    call(input);
    expect(input).toStrictEqual(before);
    expect(Object.keys(input)).toEqual(Object.keys(before));
    expect(input.tags).toEqual(['z', 'a', 'z']);
  });

  it('the normalized definition shares no reference with the input', () => {
    const input = makeInput();
    const before = structuredClone(input);
    const def = normalizeRuleDefinition(input);
    (def.params as { base: string }).base = 'changed';
    def.tags.push('changed');
    def.dimensions.country = 'changed';
    (def.condition!.value as Record<string, unknown>).x = 1;
    (def.extra as { a: number[] }).a.push(9);
    expect(input).toStrictEqual(before);
  });

  it('gives the same results on frozen and unfrozen inputs', () => {
    expect(computeRuleChecksum(deepFreeze(makeInput()))).toBe(computeRuleChecksum(makeInput()));
    expect(computeRuleFingerprint(deepFreeze(makeInput()))).toBe(
      computeRuleFingerprint(makeInput()),
    );
  });
});
