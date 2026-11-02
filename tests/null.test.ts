import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  computeRuleFingerprint,
  normalizeRuleDefinition,
  validateRuleDefinition,
} from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';
import { specError } from './helpers.js';

/** A rule where every optional field is absent. */
const minimal: RuleDefinitionInput = {
  id: 'r1',
  version: 1,
  model: 'FLAT',
  params: { amount: 10 },
  priority: 1,
  effectiveFrom: '2025-01-01',
};

/** The same rule with every optional field set, to check what null and undefined do to each. */
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
  extensions: { jurisdiction: 'NATIONAL' },
};

function without(obj: object, key: string): RuleDefinitionInput {
  const copy: Record<string, unknown> = { ...obj };
  delete copy[key];
  return copy as unknown as RuleDefinitionInput;
}

const OPTIONAL_FIELDS = [
  'output',
  'dominanceGroup',
  'sourceRef',
  'condition',
  'tags',
  'dimensions',
  'exceptions',
  'extensions',
];

describe('top-level undefined means absent; null is refused (Task 9K5, M8)', () => {
  describe.each(OPTIONAL_FIELDS)('%s', (field) => {
    it('undefined and absent give the same checksum and fingerprint', () => {
      const absent = without(full, field);
      const asUndefined = { ...full, [field]: undefined } as RuleDefinitionInput;
      expect(computeRuleChecksum(asUndefined)).toBe(computeRuleChecksum(absent));
      expect(computeRuleFingerprint(asUndefined)).toBe(computeRuleFingerprint(absent));
      expect(normalizeRuleDefinition(asUndefined)).toEqual(normalizeRuleDefinition(absent));
    });

    it('null is refused, in every function that reads a rule, naming the field', () => {
      const asNull = { ...full, [field]: null } as unknown as RuleDefinitionInput;
      const message = `${field} is null: omit the field instead`;
      for (const call of [
        () => normalizeRuleDefinition(asNull),
        () => computeRuleChecksum(asNull),
        () => computeRuleFingerprint(asNull),
      ]) {
        expect(specError(call)).toMatchObject({ code: 'INVALID_RULE', message });
      }
      expect(validateRuleDefinition(asNull).errors).toEqual([message]);
    });
  });

  it('every optional field absent or undefined at once equals the minimal rule', () => {
    const undefineds = Object.fromEntries(OPTIONAL_FIELDS.map((f) => [f, undefined]));
    const allAbsent = { ...minimal, ...undefineds } as RuleDefinitionInput;
    expect(normalizeRuleDefinition(allAbsent)).toEqual(normalizeRuleDefinition(minimal));
    expect(computeRuleChecksum(allAbsent)).toBe(computeRuleChecksum(minimal));
  });

  it('effectiveUntil is the one null accepted: the written form of no end', () => {
    const asNull = { ...minimal, effectiveUntil: null };
    expect(computeRuleChecksum(asNull)).toBe(computeRuleChecksum(minimal));
    expect(computeRuleFingerprint(asNull)).toBe(computeRuleFingerprint(minimal));
  });

  it('defaults stay explicit: tags, dimensions and effectiveUntil', () => {
    const def = normalizeRuleDefinition({
      ...minimal,
      tags: undefined,
      dimensions: undefined,
      effectiveUntil: undefined,
    });
    expect(def.tags).toEqual([]);
    expect(def.dimensions).toEqual({});
    expect(def.effectiveUntil).toBeNull();
  });
});

describe('a null dimension value is refused; an undefined one means the dimension is unset', () => {
  const asNull = { ...minimal, dimensions: { country: null } } as unknown as RuleDefinitionInput;

  it('{country: null} is refused, the dimension named', () => {
    const message = 'dimensions.country is null: omit the field instead';
    expect(specError(() => computeRuleChecksum(asNull))).toMatchObject({
      code: 'INVALID_RULE',
      message,
    });
    expect(validateRuleDefinition(asNull).errors).toEqual([message]);
  });

  it('{country: undefined}, {} and absent dimensions give the same checksum and fingerprint', () => {
    const unset = { ...minimal, dimensions: { country: undefined } };
    const empty = { ...minimal, dimensions: {} };
    expect(computeRuleChecksum(unset)).toBe(computeRuleChecksum(empty));
    expect(computeRuleChecksum(unset)).toBe(computeRuleChecksum(minimal));
    expect(computeRuleFingerprint(unset)).toBe(computeRuleFingerprint(minimal));
  });

  it('drops only the undefined key', () => {
    const def = normalizeRuleDefinition({
      ...minimal,
      dimensions: { country: 'TG', category: undefined },
    });
    expect(def.dimensions).toEqual({ country: 'TG' });
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
    const a = { ...minimal, extensions: { extra: { owner: null } } };
    const b = { ...minimal, extensions: { extra: {} } };
    expect(computeRuleFingerprint(a)).not.toBe(computeRuleFingerprint(b));
    expect(normalizeRuleDefinition(a).extensions).toEqual({ extra: { owner: null } });
  });

  it('an extension that is null is data, not absence', () => {
    const a = { ...minimal, extensions: { extra: null } };
    expect(computeRuleChecksum(a)).not.toBe(computeRuleChecksum(minimal));
    expect(normalizeRuleDefinition(a).extensions).toEqual({ extra: null });
  });

  it('inside exceptions', () => {
    const exceptions = [{ kind: 'shortCircuit', output: 'note', value: null }];
    const def = normalizeRuleDefinition({ ...minimal, exceptions });
    expect(def.exceptions).toEqual(exceptions);
  });
});
