import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { normalizeRuleDefinition, validateRuleDefinition } from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';

const schema = JSON.parse(
  readFileSync(new URL('../schema/rule-definition.schema.json', import.meta.url), 'utf8'),
) as object;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const schemaAccepts = ajv.compile(schema);

const base = {
  id: 'r1',
  version: 1,
  model: 'PERCENTAGE',
  params: { rate: 0.05, base: 'orderTotal' },
  priority: 1,
  effectiveFrom: '2025-01-01',
};

function without(key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...base };
  delete copy[key];
  return copy;
}

function normalizeAccepts(value: unknown): boolean {
  try {
    normalizeRuleDefinition(value as RuleDefinitionInput);
    return true;
  } catch {
    return false;
  }
}

const VALID: [string, unknown][] = [
  ['the minimal definition', base],
  [
    'every named field and extensions',
    {
      ...base,
      condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'x' }, 1] } },
      effectiveUntil: '2026-01-01',
      output: 'tax',
      dimensions: { country: 'TG' },
      tags: ['vat'],
      dominanceGroup: 'VAT',
      exceptions: ['r0'],
      sourceRef: 'CGI art. 1',
      jurisdiction: 'NATIONAL',
      meta: { nested: [1, 'a', null] },
    },
  ],
  [
    'null as absent for every optional field and an extension',
    {
      ...base,
      condition: null,
      effectiveUntil: null,
      output: null,
      dimensions: null,
      tags: null,
      dominanceGroup: null,
      exceptions: null,
      sourceRef: null,
      checksum: null,
      jurisdiction: null,
    },
  ],
  [
    'a null dimension value (unset) and an empty one',
    { ...base, dimensions: { a: 'TG', b: null, c: '' } },
  ],
  [
    'null as data in params and condition.value',
    { ...base, params: null, condition: { dsl: 'x', value: null } },
  ],
  [
    'a date-time with Z and 9 fraction digits',
    { ...base, effectiveFrom: '2025-01-01T10:20:30.123456789Z' },
  ],
  [
    'a date-time with an offset and no seconds',
    { ...base, effectiveFrom: '2025-01-01T10:30+05:30' },
  ],
  [
    'a leap day',
    { ...base, effectiveFrom: '2024-02-29', effectiveUntil: '2400-02-29T00:00:00-23:59' },
  ],
  [
    'a large integer version, a negative fractional priority',
    { ...base, version: 1e6, priority: -2.5 },
  ],
  ['duplicate tags and a string checksum', { ...base, tags: ['b', 'a', 'b', ''], checksum: 'abc' }],
  [
    'a window of one millisecond',
    { ...base, effectiveFrom: '2025-01-01', effectiveUntil: '2025-01-01T00:00:00.001Z' },
  ],
];

const INVALID: [string, unknown][] = [
  ['a missing id', without('id')],
  ['a missing params', without('params')],
  ['a missing effectiveFrom', without('effectiveFrom')],
  ['an empty model', { ...base, model: '' }],
  ['a non-numeric priority', { ...base, priority: '1' }],
  ['a fractional version', { ...base, version: 1.5 }],
  ['a zero version', { ...base, version: 0 }],
  ['a non-string dimension value', { ...base, dimensions: { country: 1 } }],
  ['a non-string tag', { ...base, tags: ['a', 1] }],
  ['an impossible date', { ...base, effectiveFrom: '2025-02-30' }],
  ['a non-leap February 29', { ...base, effectiveFrom: '2023-02-29' }],
  ['a date-time without a time zone (A8)', { ...base, effectiveFrom: '2025-01-01T00:00' }],
  ['an invalid effectiveUntil', { ...base, effectiveUntil: '2025-13-01' }],
  ['an unknown condition key', { ...base, condition: { dsl: 'x', value: 1, extra: true } }],
  ['a condition without value', { ...base, condition: { dsl: 'x' } }],
  ['an empty output', { ...base, output: '' }],
  ['an array instead of an object', [base]],
];

/** JSON Schema cannot compare two fields: only the validator (and normalize) reject these. */
const VALIDATOR_ONLY: [string, unknown][] = [
  ['an empty window (until == from)', { ...base, effectiveUntil: '2025-01-01T00:00:00Z' }],
  ['a reversed window (until < from)', { ...base, effectiveUntil: '2024-12-31' }],
];

describe('validateRuleDefinition, JSON schema and normalize agree', () => {
  it('has at least 10 valid and 10 invalid cases', () => {
    expect(VALID.length).toBeGreaterThanOrEqual(10);
    expect(INVALID.length).toBeGreaterThanOrEqual(10);
  });

  it.each(VALID)('accepts %s', (_name, value) => {
    expect(validateRuleDefinition(value)).toEqual({ valid: true, errors: [], issues: [] });
    expect(schemaAccepts(value)).toBe(true);
    expect(normalizeAccepts(value)).toBe(true);
  });

  it.each(INVALID)('rejects %s', (_name, value) => {
    const result = validateRuleDefinition(value);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(schemaAccepts(value)).toBe(false);
    expect(normalizeAccepts(value)).toBe(false);
  });

  it.each(VALIDATOR_ONLY)('validator-only: rejects %s (the schema cannot)', (_name, value) => {
    expect(validateRuleDefinition(value).valid).toBe(false);
    expect(normalizeAccepts(value)).toBe(false);
    expect(schemaAccepts(value)).toBe(true);
  });

  it('the schema documents the validator-only window check', () => {
    expect(JSON.stringify(schema)).toMatch(/effectiveUntil.*after.*effectiveFrom/);
  });
});

describe('date pattern parity', () => {
  const dates = [
    '2025-01-01',
    '2024-02-29',
    '2000-02-29',
    '1900-02-29',
    '0000-02-29',
    '2023-02-29',
    '2025-04-31',
    '2025-04-30',
    '2025-12-31',
    '2025-00-10',
    '2025-01-00',
    '2025-1-01',
    ' 2025-01-01',
    '2025-01-01 ',
    '2025-01-01T00:00Z',
    '2025-01-01T23:59:59Z',
    '2025-01-01T24:00Z',
    '2025-01-01T00:60Z',
    '2025-01-01T00:00:60Z',
    '2025-01-01T00:00:00.1Z',
    '2025-01-01T00:00:00.123456789Z',
    '2025-01-01T00:00:00.1234567891Z',
    '2025-01-01T00:00:00.Z',
    '2025-01-01T00:00:00z',
    '2025-01-01t00:00:00Z',
    '2025-01-01 00:00:00Z',
    '2025-01-01T00:00+00:00',
    '2025-01-01T00:00-23:59',
    '2025-01-01T00:00+24:00',
    '2025-01-01T00:00+05:60',
    '2025-01-01T00:00+0500',
    '2025-01-01T00:00+05',
    '2025-01-01T00:00',
    '2025-01-01T00:00:00',
    '20250101',
    '',
  ];

  it.each(dates)('schema, validator and normalize agree on %j', (date) => {
    const value = { ...base, effectiveFrom: date };
    const expected = normalizeAccepts(value);
    expect(validateRuleDefinition(value).valid).toBe(expected);
    expect(schemaAccepts(value)).toBe(expected);
  });
});

describe('validateRuleDefinition beyond JSON', () => {
  it('accepts a Date, like normalize', () => {
    expect(validateRuleDefinition({ ...base, effectiveFrom: new Date(0) }).valid).toBe(true);
  });

  it('rejects non-JSON values, like normalize', () => {
    for (const params of [
      new Map(),
      new Set(),
      NaN,
      Infinity,
      { toJSON: () => 1 },
      new Date(NaN),
    ]) {
      const value = { ...base, params: { x: params } };
      expect(validateRuleDefinition(value).valid).toBe(false);
      expect(normalizeAccepts(value)).toBe(false);
    }
  });

  it('collects every error and names the field', () => {
    const { valid, errors } = validateRuleDefinition({
      ...base,
      id: 1,
      priority: 'x',
      dimensions: { country: 1 },
    });
    expect(valid).toBe(false);
    expect(errors).toHaveLength(3);
    expect(errors.join('\n')).toMatch(/id/);
    expect(errors.join('\n')).toMatch(/priority/);
    expect(errors.join('\n')).toMatch(/dimensions\.country/);
  });

  it('returns structured issues alongside the error strings', () => {
    const result = validateRuleDefinition({
      ...base,
      id: 1,
      params: { rates: [0.1, Number.NaN] },
      effectiveUntil: '2024-01-01',
      dimensions: { country: 1 },
      condition: { dsl: 'jsonlogic' },
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.path)).toEqual([
      'id',
      'params.rates[1]',
      'effectiveUntil',
      'condition.value',
      'dimensions.country',
    ]);
    expect(result.errors).toEqual(result.issues.map((i) => i.message));
  });

  it('gives an empty path to a problem with the whole value', () => {
    expect(validateRuleDefinition(1).issues).toEqual([
      { path: '', message: 'a rule definition must be a plain object' },
    ]);
  });

  it('returns no issue for a valid definition', () => {
    expect(validateRuleDefinition(base)).toEqual({ valid: true, errors: [], issues: [] });
  });

  it('never throws', () => {
    for (const value of [undefined, null, 1, 'x', [], new Map()]) {
      expect(validateRuleDefinition(value).valid).toBe(false);
    }
  });
});
