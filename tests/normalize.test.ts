import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  normalizeRuleDefinition,
  SpecError,
  validateRuleDefinition,
} from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';

/** Copy of `obj` without `key` (as if the property had never been written). */
function without(obj: object, key: string): RuleDefinitionInput {
  const copy: Record<string, unknown> = { ...obj };
  delete copy[key];
  return copy as RuleDefinitionInput;
}

const base = {
  id: 'r1',
  version: 1,
  model: 'PERCENTAGE',
  params: { rate: 0.05, base: 'orderTotal' },
  priority: 1,
  effectiveFrom: '2025-01-01',
};

const invalidDate = expect.objectContaining({ code: 'INVALID_DATE' });
const invalidRule = expect.objectContaining({ code: 'INVALID_RULE' });

describe('normalizeRuleDefinition: shape', () => {
  it('fills the defaults and writes dates as full UTC ISO strings', () => {
    expect(normalizeRuleDefinition(base)).toEqual({
      id: 'r1',
      version: 1,
      model: 'PERCENTAGE',
      params: { rate: 0.05, base: 'orderTotal' },
      priority: 1,
      effectiveFrom: '2025-01-01T00:00:00.000Z',
      effectiveUntil: null,
      dimensions: {},
      tags: [],
    });
  });

  it('keeps every named optional field and the extensions', () => {
    const def = normalizeRuleDefinition({
      ...base,
      condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'x' }, 1] } },
      effectiveUntil: new Date('2026-01-01T00:00:00Z'),
      output: 'tax',
      dimensions: { country: 'TG' },
      tags: ['vat'],
      dominanceGroup: 'VAT',
      exceptions: [{ kind: 'inhibit', targets: { ids: ['r0'] } }],
      sourceRef: 'CGI art. 1',
      jurisdiction: 'NATIONAL',
      meta: { a: 1 },
    });
    expect(def).toEqual({
      id: 'r1',
      version: 1,
      model: 'PERCENTAGE',
      params: { rate: 0.05, base: 'orderTotal' },
      condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'x' }, 1] } },
      priority: 1,
      effectiveFrom: '2025-01-01T00:00:00.000Z',
      effectiveUntil: '2026-01-01T00:00:00.000Z',
      output: 'tax',
      dimensions: { country: 'TG' },
      tags: ['vat'],
      dominanceGroup: 'VAT',
      exceptions: [{ kind: 'inhibit', targets: { ids: ['r0'] } }],
      sourceRef: 'CGI art. 1',
      jurisdiction: 'NATIONAL',
      meta: { a: 1 },
    });
  });

  it('removes checksum', () => {
    expect(normalizeRuleDefinition({ ...base, checksum: 'abc' })).not.toHaveProperty('checksum');
  });

  it('removes undefined properties', () => {
    const def = normalizeRuleDefinition({
      ...base,
      condition: undefined,
      output: undefined,
      dominanceGroup: undefined,
      exceptions: undefined,
      sourceRef: undefined,
      jurisdiction: undefined,
    });
    expect(Object.keys(def).sort()).toEqual(
      [
        'dimensions',
        'effectiveFrom',
        'effectiveUntil',
        'id',
        'model',
        'params',
        'priority',
        'tags',
        'version',
      ].sort(),
    );
  });

  it('sorts and deduplicates tags', () => {
    expect(normalizeRuleDefinition({ ...base, tags: ['b', 'a', 'b', 'c', 'a'] }).tags).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('turns nested values into plain JSON (Date to ISO, undefined dropped)', () => {
    const def = normalizeRuleDefinition({
      ...base,
      params: { at: new Date('2025-06-01T00:00:00Z'), gone: undefined, list: [undefined] },
    });
    expect(def.params).toEqual({ at: '2025-06-01T00:00:00.000Z', list: [null] });
  });
});

describe('normalizeRuleDefinition: dates (A1)', () => {
  it.each([
    ['YYYY-MM-DD as UTC midnight', '2025-03-15', '2025-03-15T00:00:00.000Z'],
    ['date-time with Z', '2025-03-15T10:20:30Z', '2025-03-15T10:20:30.000Z'],
    ['date-time with milliseconds and Z', '2025-03-15T10:20:30.123Z', '2025-03-15T10:20:30.123Z'],
    ['date-time without seconds, with Z', '2025-03-15T10:20Z', '2025-03-15T10:20:00.000Z'],
    ['positive offset', '2025-03-15T10:20:30+02:00', '2025-03-15T08:20:30.000Z'],
    ['negative offset', '2025-03-15T10:20:30-03:30', '2025-03-15T13:50:30.000Z'],
    ['offset crossing the day', '2025-01-01T00:30:00+01:00', '2024-12-31T23:30:00.000Z'],
    ['leap day', '2024-02-29', '2024-02-29T00:00:00.000Z'],
  ])('accepts %s', (_label, input, expected) => {
    expect(normalizeRuleDefinition({ ...base, effectiveFrom: input }).effectiveFrom).toBe(expected);
    expect(
      normalizeRuleDefinition({ ...base, effectiveFrom: '2000-01-01', effectiveUntil: input })
        .effectiveUntil,
    ).toBe(expected);
  });

  it.each([
    [
      'microseconds (as Postgres writes them)',
      '2025-03-15T10:20:30.123456Z',
      '2025-03-15T10:20:30.123Z',
    ],
    ['nanoseconds', '2025-03-15T10:20:30.123456789+00:00', '2025-03-15T10:20:30.123Z'],
    ['no rounding up', '2025-03-15T10:20:30.999999Z', '2025-03-15T10:20:30.999Z'],
    ['one digit', '2025-03-15T10:20:30.5Z', '2025-03-15T10:20:30.500Z'],
  ])('truncates fractional seconds beyond milliseconds: %s', (_label, input, expected) => {
    expect(normalizeRuleDefinition({ ...base, effectiveFrom: input }).effectiveFrom).toBe(expected);
  });

  it('two inputs differing only below the millisecond give the same checksum', () => {
    expect(computeRuleChecksum({ ...base, effectiveFrom: '2025-03-15T10:20:30.123456Z' })).toBe(
      computeRuleChecksum({ ...base, effectiveFrom: '2025-03-15T10:20:30.123Z' }),
    );
  });

  it('rejects more than nine fractional digits', () => {
    expect(() =>
      normalizeRuleDefinition({ ...base, effectiveFrom: '2025-03-15T10:20:30.1234567890Z' }),
    ).toThrow(invalidDate);
  });

  it('accepts a Date', () => {
    expect(
      normalizeRuleDefinition({ ...base, effectiveFrom: new Date(Date.UTC(2025, 2, 15, 10)) })
        .effectiveFrom,
    ).toBe('2025-03-15T10:00:00.000Z');
  });

  it.each([
    ['a date-time without time zone', '2025-01-01T00:00'],
    ['a date-time with seconds and no time zone', '2025-01-01T00:00:00'],
    ['free text', 'pas une date'],
    ['an empty string', ''],
    ['a non-existent day', '2025-02-30'],
    ['Feb 29 of a common year', '2025-02-29'],
    ['month 13', '2025-13-01'],
    ['hour 24', '2025-01-01T24:00:00Z'],
    ['minute 60', '2025-01-01T23:60Z'],
    ['an offset without colon', '2025-01-01T10:00+0100'],
    ['a space instead of T', '2025-01-01 10:00Z'],
    ['a year-month only', '2025-01'],
    ['a US date', '01/02/2025'],
    ['an expanded year', '+002025-01-01'],
    ['surrounding spaces', ' 2025-01-01 '],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizeRuleDefinition({ ...base, effectiveFrom: input })).toThrow(invalidDate);
    expect(() => normalizeRuleDefinition({ ...base, effectiveUntil: input })).toThrow(invalidDate);
  });

  it('rejects an invalid Date', () => {
    expect(() => normalizeRuleDefinition({ ...base, effectiveFrom: new Date('x') })).toThrow(
      invalidDate,
    );
  });

  it('rejects a number or a missing effectiveFrom', () => {
    expect(() =>
      normalizeRuleDefinition({ ...base, effectiveFrom: 0 } as unknown as RuleDefinitionInput),
    ).toThrow(invalidDate);
    expect(() => normalizeRuleDefinition(without(base, 'effectiveFrom'))).toThrow(invalidDate);
  });
});

describe('normalizeRuleDefinition: validity window [from, until)', () => {
  it('rejects effectiveUntil equal to effectiveFrom (the window would be empty)', () => {
    expect(() => normalizeRuleDefinition({ ...base, effectiveUntil: '2025-01-01' })).toThrow(
      invalidRule,
    );
    expect(() =>
      normalizeRuleDefinition({ ...base, effectiveUntil: '2025-01-01T01:00:00+01:00' }),
    ).toThrow(invalidRule);
  });

  it('rejects effectiveUntil before effectiveFrom', () => {
    expect(() => normalizeRuleDefinition({ ...base, effectiveUntil: '2024-12-31' })).toThrow(
      invalidRule,
    );
    expect(() =>
      normalizeRuleDefinition({ ...base, effectiveUntil: '2024-12-31T23:59:59.999Z' }),
    ).toThrow(invalidRule);
  });

  it('accepts effectiveUntil one millisecond after effectiveFrom', () => {
    expect(
      normalizeRuleDefinition({ ...base, effectiveUntil: '2025-01-01T00:00:00.001Z' })
        .effectiveUntil,
    ).toBe('2025-01-01T00:00:00.001Z');
  });
});

describe('normalizeRuleDefinition: invalid rules', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['a missing id', { id: undefined }],
    ['an empty id', { id: '' }],
    ['a numeric id', { id: 1 }],
    ['a missing version', { version: undefined }],
    ['a string version', { version: '1' }],
    ['a NaN version', { version: NaN }],
    ['a fractional version', { version: 1.5 }],
    ['a zero version', { version: 0 }],
    ['a negative version', { version: -1 }],
    ['a missing model', { model: undefined }],
    ['an empty model', { model: '' }],
    ['missing params', { params: undefined }],
    ['a missing priority', { priority: undefined }],
    ['an infinite priority', { priority: Infinity }],
    ['a non-object condition', { condition: 'x > 1' }],
    ['a condition without dsl', { condition: { value: true } }],
    ['a condition without value', { condition: { dsl: 'jsonlogic' } }],
    ['a condition with an unknown key', { condition: { dsl: 'jsonlogic', value: true, x: 1 } }],
    ['non-array tags', { tags: 'a' }],
    ['a non-string tag', { tags: ['a', 1] }],
    ['an array as dimensions', { dimensions: ['a'] }],
    ['a non-string dimension value', { dimensions: { country: 1 } }],
    ['a non-string output', { output: 1 }],
    ['a non-string dominanceGroup', { dominanceGroup: 1 }],
    ['a non-string sourceRef', { sourceRef: 1 }],
  ];
  it.each(cases)('rejects %s', (_label, patch) => {
    expect(() =>
      normalizeRuleDefinition({ ...base, ...patch } as unknown as RuleDefinitionInput),
    ).toThrow(invalidRule);
  });

  it('rejects a non-object input', () => {
    expect(() => normalizeRuleDefinition(null as unknown as RuleDefinitionInput)).toThrow(
      invalidRule,
    );
    expect(() => normalizeRuleDefinition([] as unknown as RuleDefinitionInput)).toThrow(
      invalidRule,
    );
  });

  it('accepts null params', () => {
    expect(normalizeRuleDefinition({ ...base, params: null }).params).toBeNull();
  });

  it('throws SpecError instances', () => {
    expect(() =>
      normalizeRuleDefinition({ ...base, id: '' } as unknown as RuleDefinitionInput),
    ).toThrow(SpecError);
  });
});

describe('reserved output names (R36)', () => {
  const message = 'output must not start with "$": output names starting with "$" are reserved';

  it.each(['$outputs', '$', '$tax'])('refuses a rule output %j', (output) => {
    const value = { ...base, output };
    expect(validateRuleDefinition(value)).toEqual({
      valid: false,
      errors: [message],
      issues: [{ path: 'output', message }],
    });
    expect(() => normalizeRuleDefinition(value)).toThrow(
      expect.objectContaining({ code: 'INVALID_RULE', message }),
    );
  });

  it('accepts a $ that is not the first character', () => {
    const value = { ...base, output: 'tax$2025' };
    expect(validateRuleDefinition(value).valid).toBe(true);
    expect(normalizeRuleDefinition(value).output).toBe('tax$2025');
  });
});

describe('unreadable rule definitions', () => {
  const throwing = (target: object, key: string, thrown: unknown): void => {
    Object.defineProperty(target, key, {
      enumerable: true,
      get: () => {
        throw thrown;
      },
    });
  };

  /** The `SpecError` `call` throws; fails the test when it throws anything else. */
  function specErrorOf(call: () => unknown): SpecError {
    try {
      call();
    } catch (error) {
      if (error instanceof SpecError) return error;
      throw error;
    }
    throw new Error('expected a SpecError');
  }

  it('reports a throwing getter at the top level, and normalize refuses it', () => {
    const rule = { ...base };
    throwing(rule, 'id', new Error('boom'));
    const message = 'rule definition could not be read: boom';
    expect(validateRuleDefinition(rule)).toEqual({
      valid: false,
      errors: [message],
      issues: [{ path: '', message }],
    });
    const error = specErrorOf(() => normalizeRuleDefinition(rule));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe(message);
    expect(() => computeRuleChecksum(rule)).toThrow(
      expect.objectContaining({ code: 'INVALID_RULE', message }),
    );
  });

  it('reports a throwing getter inside exceptions at its field', () => {
    const exception = { targets: { ids: ['r0'] } };
    throwing(exception, 'kind', Symbol('kind'));
    const rule = { ...base, exceptions: [exception] };
    expect(validateRuleDefinition(rule)).toEqual({
      valid: false,
      errors: ['exceptions could not be read: Symbol(kind)'],
      issues: [{ path: 'exceptions', message: 'exceptions could not be read: Symbol(kind)' }],
    });
    const error = specErrorOf(() => normalizeRuleDefinition(rule as RuleDefinitionInput));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe('exceptions could not be read: Symbol(kind)');
  });

  it('reports a throwing getter inside params at its field', () => {
    const params = {};
    throwing(params, 'rate', new Error('nope'));
    const rule = { ...base, params };
    expect(validateRuleDefinition(rule).issues).toEqual([
      { path: 'params', message: 'params could not be read: nope' },
    ]);
    const error = specErrorOf(() => normalizeRuleDefinition(rule));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe('params could not be read: nope');
  });

  it('names a nested unreadable field of params, condition and an extension', () => {
    const rates = {};
    throwing(rates, 'reduced', new Error('nope'));
    const nested = { ...base, params: { rates: [rates] } };
    expect(validateRuleDefinition(nested).errors).toEqual(['params could not be read: nope']);
    expect(specErrorOf(() => normalizeRuleDefinition(nested)).message).toBe(
      'params could not be read: nope',
    );
    const value = {};
    throwing(value, 'var', new Error('x'));
    const condition = { ...base, condition: { dsl: 'jsonlogic', value } };
    expect(specErrorOf(() => normalizeRuleDefinition(condition)).message).toBe(
      'condition.value could not be read: x',
    );
    expect(validateRuleDefinition(condition).errors).toEqual([
      'condition.value could not be read: x',
    ]);
    const meta = {};
    throwing(meta, 'owner', new Error('y'));
    const extension = { ...base, meta };
    expect(specErrorOf(() => normalizeRuleDefinition(extension)).message).toBe(
      'meta could not be read: y',
    );
    expect(validateRuleDefinition(extension).errors).toEqual(['meta could not be read: y']);
  });

  it('says a too deeply nested field is too deeply nested', () => {
    let params: Record<string, unknown> = {};
    for (let i = 0; i < 200_000; i++) params = { a: params };
    const rule = { ...base, params };
    expect(validateRuleDefinition(rule)).toEqual({
      valid: false,
      errors: ['params is too deeply nested'],
      issues: [{ path: 'params', message: 'params is too deeply nested' }],
    });
    const error = specErrorOf(() => normalizeRuleDefinition(rule));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe('params is too deeply nested');
  });

  it('reports a hostile Proxy', () => {
    const hostile = new Proxy(
      { ...base },
      {
        ownKeys: () => {
          throw new Error('keys');
        },
      },
    );
    expect(validateRuleDefinition(hostile).issues).toEqual([
      { path: '', message: 'rule definition could not be read: keys' },
    ]);
    expect(specErrorOf(() => normalizeRuleDefinition(hostile as RuleDefinitionInput)).message).toBe(
      'rule definition could not be read: keys',
    );
  });
});
