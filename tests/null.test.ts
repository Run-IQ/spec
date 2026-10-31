import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  computeRuleFingerprint,
  normalizeRuleDefinition,
} from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';

/** A rule where every optional field is absent. */
const minimal: RuleDefinitionInput = {
  id: 'r1',
  version: 1,
  model: 'FLAT',
  params: { amount: 10 },
  priority: 1,
  effectiveFrom: '2025-01-01',
};

/** The same rule with every optional field set, to check null removes exactly that field. */
const full: RuleDefinitionInput = {
  ...minimal,
  condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'x' }, 1] } },
  effectiveUntil: '2026-01-01',
  output: 'tax',
  dimensions: { country: 'TG' },
  tags: ['vat'],
  dominanceGroup: 'VAT',
  exceptions: [{ kind: 'inhibit', targets: { ids: ['r0'] } }],
  sourceRef: 'CGI art. 1',
  jurisdiction: 'NATIONAL',
};

function without(obj: object, key: string): RuleDefinitionInput {
  const copy: Record<string, unknown> = { ...obj };
  delete copy[key];
  return copy as RuleDefinitionInput;
}

const OPTIONAL_FIELDS = [
  'output',
  'dominanceGroup',
  'sourceRef',
  'condition',
  'tags',
  'dimensions',
  'exceptions',
  'effectiveUntil',
  'jurisdiction', // an extension field
];

describe('top-level null means absent (A3: independent of how a database writes columns)', () => {
  describe.each(OPTIONAL_FIELDS)('%s', (field) => {
    it('null, undefined and absent give the same checksum and fingerprint', () => {
      const absent = without(full, field);
      const asNull = { ...full, [field]: null } as RuleDefinitionInput;
      const asUndefined = { ...full, [field]: undefined } as RuleDefinitionInput;
      expect(computeRuleChecksum(asNull)).toBe(computeRuleChecksum(absent));
      expect(computeRuleChecksum(asUndefined)).toBe(computeRuleChecksum(absent));
      expect(computeRuleFingerprint(asNull)).toBe(computeRuleFingerprint(absent));
      expect(computeRuleFingerprint(asUndefined)).toBe(computeRuleFingerprint(absent));
    });

    it('null on a minimal rule gives the minimal checksum and fingerprint', () => {
      const asNull = { ...minimal, [field]: null } as RuleDefinitionInput;
      expect(computeRuleChecksum(asNull)).toBe(computeRuleChecksum(minimal));
      expect(computeRuleFingerprint(asNull)).toBe(computeRuleFingerprint(minimal));
    });

    it('null gives the same normalized definition as absent', () => {
      expect(normalizeRuleDefinition({ ...full, [field]: null } as RuleDefinitionInput)).toEqual(
        normalizeRuleDefinition(without(full, field)),
      );
    });
  });

  it('every optional field null at once equals the minimal rule', () => {
    const allNull = { ...minimal, ...Object.fromEntries(OPTIONAL_FIELDS.map((f) => [f, null])) };
    expect(normalizeRuleDefinition(allNull as RuleDefinitionInput)).toEqual(
      normalizeRuleDefinition(minimal),
    );
    expect(computeRuleChecksum(allNull as RuleDefinitionInput)).toBe(computeRuleChecksum(minimal));
  });

  it('a null extension is dropped from the definition', () => {
    expect(normalizeRuleDefinition({ ...minimal, jurisdiction: null })).not.toHaveProperty(
      'jurisdiction',
    );
  });

  it('defaults stay explicit: tags, dimensions and effectiveUntil', () => {
    const def = normalizeRuleDefinition({
      ...minimal,
      tags: null,
      dimensions: null,
      effectiveUntil: null,
    });
    expect(def.tags).toEqual([]);
    expect(def.dimensions).toEqual({});
    expect(def.effectiveUntil).toBeNull();
  });
});

describe('a null dimension value means the dimension is unset', () => {
  it('{country: null}, {} and absent dimensions give the same checksum and fingerprint', () => {
    const asNull = { ...minimal, dimensions: { country: null } } as unknown as RuleDefinitionInput;
    const empty = { ...minimal, dimensions: {} };
    expect(computeRuleChecksum(asNull)).toBe(computeRuleChecksum(empty));
    expect(computeRuleChecksum(asNull)).toBe(computeRuleChecksum(minimal));
    expect(computeRuleFingerprint(asNull)).toBe(computeRuleFingerprint(empty));
    expect(computeRuleFingerprint(asNull)).toBe(computeRuleFingerprint(minimal));
  });

  it('drops only the null key', () => {
    const def = normalizeRuleDefinition({
      ...minimal,
      dimensions: { country: 'TG', category: null },
    } as unknown as RuleDefinitionInput);
    expect(def.dimensions).toEqual({ country: 'TG' });
    expect(
      computeRuleChecksum({
        ...minimal,
        dimensions: { country: 'TG', category: null },
      } as unknown as RuleDefinitionInput),
    ).toBe(computeRuleChecksum({ ...minimal, dimensions: { country: 'TG' } }));
  });

  it.each([
    ['a number', 1],
    ['a boolean', false],
    ['an object', { a: 'b' }],
    ['an array', ['TG']],
  ])('still rejects %s', (_label, value) => {
    expect(() =>
      normalizeRuleDefinition({
        ...minimal,
        dimensions: { country: value },
      } as unknown as RuleDefinitionInput),
    ).toThrow(expect.objectContaining({ code: 'INVALID_RULE' }));
  });
});

describe('nested null stays data', () => {
  it('inside params', () => {
    expect(computeRuleChecksum({ ...minimal, params: { amount: 10, cap: null } })).not.toBe(
      computeRuleChecksum(minimal),
    );
    expect(computeRuleFingerprint({ ...minimal, params: { amount: 10, cap: null } })).not.toBe(
      computeRuleFingerprint(minimal),
    );
    expect(
      normalizeRuleDefinition({ ...minimal, params: { amount: 10, cap: null } }).params,
    ).toEqual({ amount: 10, cap: null });
  });

  it('params itself null is data, not absence', () => {
    expect(normalizeRuleDefinition({ ...minimal, params: null }).params).toBeNull();
  });

  it('inside condition.value', () => {
    const a = {
      ...minimal,
      condition: { dsl: 'jsonlogic', value: { '==': [{ var: 'x' }, null] } },
    };
    const b = { ...minimal, condition: { dsl: 'jsonlogic', value: { '==': [{ var: 'x' }] } } };
    expect(computeRuleFingerprint(a)).not.toBe(computeRuleFingerprint(b));
    expect(normalizeRuleDefinition(a).condition).toEqual(a.condition);
  });

  it('condition.value null is data', () => {
    const def = normalizeRuleDefinition({
      ...minimal,
      condition: { dsl: 'jsonlogic', value: null },
    });
    expect(def.condition).toEqual({ dsl: 'jsonlogic', value: null });
  });

  it('inside an extension value', () => {
    const a = { ...minimal, extra: { owner: null } };
    const b = { ...minimal, extra: {} };
    expect(computeRuleFingerprint(a)).not.toBe(computeRuleFingerprint(b));
    expect(normalizeRuleDefinition(a).extra).toEqual({ owner: null });
  });

  it('inside exceptions', () => {
    const exceptions = [{ kind: 'shortCircuit', output: 'note', value: null }];
    const def = normalizeRuleDefinition({ ...minimal, exceptions });
    expect(def.exceptions).toEqual(exceptions);
  });
});
