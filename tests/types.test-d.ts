import { describe, expectTypeOf, it } from 'vitest';
import {
  computeRuleChecksum,
  computeRuleFingerprint,
  fromStoredRecord,
  normalizeRuleDefinition,
  toExecutableRule,
  toStoredPayload,
  validateRuleDefinition,
} from '../src/index.js';
import type {
  ExecutableRule,
  JsonValue,
  RuleDefinition,
  RuleDefinitionBase,
  RuleDefinitionInput,
  StoredRuleRecord,
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

describe('ExecutableRule types (A6)', () => {
  const rule = toExecutableRule({
    id: 'r1',
    version: 1,
    model: 'FLAT',
    params: { rate: 0.1, base: 'x' },
    priority: 1,
    effectiveFrom: '2025-01-01',
  });

  it('has typed named fields, Date bounds and a checksum', () => {
    expectTypeOf(rule.priority).toEqualTypeOf<number>();
    expectTypeOf(rule.params).toEqualTypeOf<unknown>();
    expectTypeOf(rule.effectiveFrom).toEqualTypeOf<Date>();
    expectTypeOf(rule.effectiveUntil).toEqualTypeOf<Date | null>();
    expectTypeOf(rule.checksum).toEqualTypeOf<string>();
    expectTypeOf(rule.tags).toEqualTypeOf<readonly string[]>();
    expectTypeOf(rule.dimensions).toEqualTypeOf<Readonly<Record<string, string>>>();
    expectTypeOf(rule.condition).toEqualTypeOf<
      { readonly dsl: string; readonly value: unknown } | undefined
    >();
  });

  it('a plugin can narrow params, like FiscalRule', () => {
    interface FlatParams {
      readonly rate: number;
      readonly base: string;
    }
    interface MyRule extends ExecutableRule {
      params: FlatParams;
    }
    expectTypeOf<MyRule['params']>().toEqualTypeOf<FlatParams>();
    expectTypeOf<MyRule['priority']>().toEqualTypeOf<number>();
    expectTypeOf<MyRule>().toMatchTypeOf<ExecutableRule>();
  });

  it('an executable rule is a valid input again', () => {
    expectTypeOf<ExecutableRule>().toMatchTypeOf<RuleDefinitionInput>();
    expectTypeOf(toStoredPayload(rule)).toEqualTypeOf<{ payload: string; checksum: string }>();
    expectTypeOf(fromStoredRecord).returns.toEqualTypeOf<ExecutableRule>();
  });

  it('StoredRuleRecord and the validator result', () => {
    expectTypeOf<StoredRuleRecord>().toEqualTypeOf<{
      id: string;
      version: number;
      checksum: string;
      payload: string;
    }>();
    expectTypeOf(validateRuleDefinition).returns.toEqualTypeOf<{
      valid: boolean;
      errors: string[];
    }>();
  });
});
