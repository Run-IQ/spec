import { describe, expectTypeOf, it } from 'vitest';
import {
  computeRuleChecksum,
  computeRuleFingerprint,
  normalizeRuleDefinition,
} from '../src/index.js';
import type {
  JsonValue,
  RuleDefinition,
  RuleDefinitionBase,
  RuleDefinitionInput,
} from '../src/index.js';

const def = normalizeRuleDefinition({
  id: 'r1',
  version: 1,
  model: 'FLAT',
  params: { amount: 1 },
  priority: 1,
  effectiveFrom: '2025-01-01',
});

describe('RuleDefinition types (A5)', () => {
  it('keeps the named fields typed despite the extension index', () => {
    expectTypeOf(def.priority).toEqualTypeOf<number>();
    expectTypeOf(def.id).toEqualTypeOf<string>();
    expectTypeOf(def.version).toEqualTypeOf<number>();
    expectTypeOf(def.model).toEqualTypeOf<string>();
    expectTypeOf(def.params).toEqualTypeOf<JsonValue>();
    expectTypeOf(def.effectiveFrom).toEqualTypeOf<string>();
    expectTypeOf(def.effectiveUntil).toEqualTypeOf<string | null>();
    expectTypeOf(def.tags).toEqualTypeOf<string[]>();
    expectTypeOf(def.dimensions).toEqualTypeOf<Record<string, string>>();
    expectTypeOf(def.condition).toEqualTypeOf<{ dsl: string; value: JsonValue } | undefined>();
  });

  it('exposes extensions as unknown', () => {
    expectTypeOf(def['jurisdiction']).toEqualTypeOf<unknown>();
  });

  it('the base interface has no index signature, so Omit keeps the named fields', () => {
    type WithoutDates = Omit<RuleDefinitionBase, 'effectiveFrom' | 'effectiveUntil'>;
    expectTypeOf<WithoutDates['priority']>().toEqualTypeOf<number>();
    expectTypeOf<RuleDefinition>().toMatchTypeOf<RuleDefinitionBase>();
  });

  it('has no schemaVersion field', () => {
    expectTypeOf<RuleDefinitionBase>().not.toHaveProperty('schemaVersion');
  });

  it('accepts readonly arrays, readonly records, Date bounds and typed params', () => {
    interface FlatParams {
      readonly rate: number;
      readonly base: string;
    }
    const params: FlatParams = { rate: 0.1, base: 'x' };
    const tags = ['a', 'b'] as const;
    const dimensions: Readonly<Record<string, string>> = { country: 'TG' };
    const input = {
      id: 'r1',
      version: 1,
      model: 'FLAT',
      params,
      priority: 1,
      effectiveFrom: new Date(),
      effectiveUntil: null,
      tags,
      dimensions,
    };
    expectTypeOf(input).toMatchTypeOf<RuleDefinitionInput>();
    expectTypeOf(computeRuleChecksum(input)).toEqualTypeOf<string>();
    expectTypeOf(computeRuleFingerprint(input)).toEqualTypeOf<string>();
  });

  it('a normalized definition is a valid input again', () => {
    expectTypeOf<RuleDefinition>().toMatchTypeOf<RuleDefinitionInput>();
  });
});
