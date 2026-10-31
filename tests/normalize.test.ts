import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  computeRuleChecksum,
  normalizeRuleDefinition,
  SpecError,
  validateRuleDefinition,
} from '../src/index.js';
import type { JsonValue, RuleDefinitionInput } from '../src/index.js';
import { MAX_JSON_DEPTH } from '../src/values.js';
import { nested, specError, tooDeepIssue } from './helpers.js';

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

/** Each free-form field of a rule, and a rule holding a given value there. */
const FREE_FORM_FIELDS: [string, (value: JsonValue) => RuleDefinitionInput][] = [
  ['params', (value) => ({ ...base, params: value })],
  ['condition.value', (value) => ({ ...base, condition: { dsl: 'jsonlogic', value } })],
  ['ext', (value) => ({ ...base, ext: value })],
];

const invalidDate = expect.objectContaining({ code: 'INVALID_DATE' });
const DATE_FORMS =
  'must be a Date, a civil date YYYY-MM-DD or an instant YYYY-MM-DDTHH:MM:SS[.sss] with Z ' +
  'or ±HH:MM, in the years 0000 to 9999';
const invalidRule = expect.objectContaining({ code: 'INVALID_RULE' });

describe('normalizeRuleDefinition: shape', () => {
  it('fills the defaults and keeps a civil date civil (D-13)', () => {
    expect(normalizeRuleDefinition(base)).toEqual({
      id: 'r1',
      version: 1,
      model: 'PERCENTAGE',
      params: { rate: 0.05, base: 'orderTotal' },
      priority: 1,
      effectiveFrom: '2025-01-01',
      effectiveUntil: null,
      dimensions: {},
      tags: [],
    });
  });

  it('keeps every named optional field and the extensions', () => {
    const def = normalizeRuleDefinition({
      ...base,
      condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'x' }, 1] } },
      effectiveUntil: '2026-01-01',
      timeZone: 'Europe/Paris',
      effectiveOn: '/$dates/facture',
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
      effectiveFrom: '2025-01-01',
      effectiveUntil: '2026-01-01',
      timeZone: 'Europe/Paris',
      effectiveOn: '/$dates/facture',
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
      timeZone: undefined,
      effectiveOn: undefined,
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

  it('turns nested values into plain JSON (Date to ISO)', () => {
    const def = normalizeRuleDefinition({
      ...base,
      params: { at: new Date('2025-06-01T00:00:00Z'), list: [null] },
    });
    expect(def.params).toEqual({ at: '2025-06-01T00:00:00.000Z', list: [null] });
  });
});

describe('normalizeRuleDefinition: dates (A1, D-13)', () => {
  it.each([
    ['a civil date', '2025-03-15'],
    ['a leap day', '2024-02-29'],
    ['the first day of year 0000', '0000-01-01'],
    ['the last day of year 9999', '9999-12-31'],
  ])('keeps %s civil', (_label, input) => {
    expect(normalizeRuleDefinition({ ...base, effectiveFrom: input }).effectiveFrom).toBe(input);
  });

  it('keeps a civil effectiveUntil civil', () => {
    expect(
      normalizeRuleDefinition({
        ...base,
        effectiveFrom: '0000-01-01',
        effectiveUntil: '9999-12-31',
      }),
    ).toMatchObject({ effectiveFrom: '0000-01-01', effectiveUntil: '9999-12-31' });
  });

  it.each([
    ['date-time with Z', '2025-03-15T10:20:30Z', '2025-03-15T10:20:30.000Z'],
    ['date-time with milliseconds and Z', '2025-03-15T10:20:30.123Z', '2025-03-15T10:20:30.123Z'],
    ['one decimal', '2025-03-15T10:20:30.5Z', '2025-03-15T10:20:30.500Z'],
    ['positive offset', '2025-03-15T10:20:30+02:00', '2025-03-15T08:20:30.000Z'],
    ['negative offset', '2025-03-15T10:20:30-03:30', '2025-03-15T13:50:30.000Z'],
    ['offset crossing the day', '2025-01-01T00:30:00+01:00', '2024-12-31T23:30:00.000Z'],
    ['offset into a leap day', '2024-03-01T00:30:00+01:00', '2024-02-29T23:30:00.000Z'],
  ])('writes an instant as the canonical UTC form: %s', (_label, input, expected) => {
    expect(normalizeRuleDefinition({ ...base, effectiveFrom: input }).effectiveFrom).toBe(expected);
    expect(
      normalizeRuleDefinition({
        ...base,
        effectiveFrom: '0000-01-01T00:00:00Z',
        effectiveUntil: input,
      }).effectiveUntil,
    ).toBe(expected);
  });

  it("'2025-01-01T01:00:00+01:00' becomes '2025-01-01T00:00:00.000Z'", () => {
    expect(
      normalizeRuleDefinition({ ...base, effectiveFrom: '2025-01-01T01:00:00+01:00' })
        .effectiveFrom,
    ).toBe('2025-01-01T00:00:00.000Z');
  });

  it('a civil bound and the instant of its UTC midnight have different checksums (D-13)', () => {
    // Same meaning in the default time zone UTC, but a civil date follows the rule's time zone.
    expect(computeRuleChecksum({ ...base, effectiveFrom: '2025-01-01' })).not.toBe(
      computeRuleChecksum({ ...base, effectiveFrom: '2025-01-01T00:00:00.000Z' }),
    );
  });

  it('accepts a Date, as an instant', () => {
    expect(
      normalizeRuleDefinition({ ...base, effectiveFrom: new Date(Date.UTC(2025, 2, 15, 10)) })
        .effectiveFrom,
    ).toBe('2025-03-15T10:00:00.000Z');
  });

  it.each([
    ['a date-time without time zone', '2025-01-01T00:00'],
    ['a date-time with seconds and no time zone', '2025-01-01T00:00:00'],
    ['a date-time without seconds', '2025-03-15T10:20Z'],
    ['four decimals', '2025-03-15T10:20:30.1234Z'],
    ['microseconds (as Postgres writes them)', '2025-03-15T10:20:30.123456Z'],
    ['a lowercase z', '2025-01-01T00:00:00z'],
    ['a lowercase t', '2025-01-01t00:00:00Z'],
    ['a leap second', '2025-12-31T23:59:60Z'],
    ['offset hour 24', '2025-01-01T00:00:00+24:00'],
    ['free text', 'pas une date'],
    ['an empty string', ''],
    ['a non-existent day', '2025-02-30'],
    ['Feb 29 of a common year', '2025-02-29'],
    ['month 13', '2025-13-01'],
    ['hour 24', '2025-01-01T24:00:00Z'],
    ['minute 60', '2025-01-01T23:60:00Z'],
    ['an offset without colon', '2025-01-01T10:00:00+0100'],
    ['a space instead of T', '2025-01-01 10:00:00Z'],
    ['a year-month only', '2025-01'],
    ['a US date', '01/02/2025'],
    ['an expanded year', '+002025-01-01'],
    ['surrounding spaces', ' 2025-01-01 '],
    ['an instant before year 0000', '0000-01-01T00:00:00+01:00'],
  ])('rejects %s', (_label, input) => {
    const error = specError(() => normalizeRuleDefinition({ ...base, effectiveFrom: input }));
    expect(error.code).toBe('INVALID_DATE');
    expect(error.message.startsWith(`effectiveFrom ${DATE_FORMS}; got "`)).toBe(true);
    expect(() => normalizeRuleDefinition({ ...base, effectiveUntil: input })).toThrow(invalidDate);
  });

  it('rejects an invalid Date and a Date outside the years 0000 to 9999', () => {
    expect(
      specError(() => normalizeRuleDefinition({ ...base, effectiveFrom: new Date('x') })),
    ).toMatchObject({
      code: 'INVALID_DATE',
      message: `effectiveFrom ${DATE_FORMS}; got an invalid Date`,
    });
    const far = new Date(Date.UTC(10000, 0, 1));
    expect(specError(() => normalizeRuleDefinition({ ...base, effectiveFrom: far })).message).toBe(
      `effectiveFrom ${DATE_FORMS}; got a Date outside the years 0000 to 9999`,
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
  const empty = (until: string, from: string) =>
    `effectiveUntil (${until}) must be after effectiveFrom (${from}): ` +
    'the window [effectiveFrom, effectiveUntil) would be empty';

  it('rejects effectiveUntil equal to effectiveFrom (the window would be empty)', () => {
    expect(
      specError(() => normalizeRuleDefinition({ ...base, effectiveUntil: '2025-01-01' })),
    ).toMatchObject({ code: 'INVALID_RULE', message: empty('2025-01-01', '2025-01-01') });
    const instant = { ...base, effectiveFrom: '2025-01-01T00:00:00Z' };
    expect(
      specError(() =>
        normalizeRuleDefinition({ ...instant, effectiveUntil: '2025-01-01T01:00:00+01:00' }),
      ).message,
    ).toBe(empty('2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'));
  });

  it('rejects effectiveUntil before effectiveFrom', () => {
    expect(() => normalizeRuleDefinition({ ...base, effectiveUntil: '2024-12-31' })).toThrow(
      invalidRule,
    );
    expect(() =>
      normalizeRuleDefinition({
        ...base,
        effectiveFrom: '2025-01-01T00:00:00Z',
        effectiveUntil: '2024-12-31T23:59:59.999Z',
      }),
    ).toThrow(invalidRule);
  });

  it('accepts effectiveUntil one day, or one millisecond, after effectiveFrom', () => {
    expect(normalizeRuleDefinition({ ...base, effectiveUntil: '2025-01-02' }).effectiveUntil).toBe(
      '2025-01-02',
    );
    expect(
      normalizeRuleDefinition({
        ...base,
        effectiveFrom: '2025-01-01T00:00:00Z',
        effectiveUntil: '2025-01-01T00:00:00.001Z',
      }).effectiveUntil,
    ).toBe('2025-01-01T00:00:00.001Z');
  });

  it('rejects a rule mixing a civil bound and an instant bound (I7b, D-13)', () => {
    const message = 'effectiveFrom and effectiveUntil must both be civil dates or both instants';
    for (const rule of [
      { ...base, effectiveUntil: '2026-01-01T00:00:00Z' },
      { ...base, effectiveUntil: new Date('2026-01-01T00:00:00Z') },
      { ...base, effectiveFrom: new Date(0), effectiveUntil: '2026-01-01' },
    ]) {
      expect(specError(() => normalizeRuleDefinition(rule))).toMatchObject({
        code: 'INVALID_RULE',
        message,
      });
      expect(validateRuleDefinition(rule).issues).toEqual([{ path: 'effectiveUntil', message }]);
    }
  });

  it('a null effectiveUntil goes with both forms', () => {
    expect(normalizeRuleDefinition({ ...base, effectiveUntil: null }).effectiveUntil).toBeNull();
    expect(
      normalizeRuleDefinition({ ...base, effectiveFrom: new Date(0), effectiveUntil: null })
        .effectiveUntil,
    ).toBeNull();
  });
});

describe('normalizeRuleDefinition: timeZone and effectiveOn', () => {
  const zones = 'timeZone must be UTC, ±HH:MM or an IANA name Area/Location';

  it.each(['UTC', '+01:00', '-09:30', 'Europe/Paris', 'America/Argentina/Buenos_Aires'])(
    'accepts the time zone %j',
    (timeZone) => {
      expect(normalizeRuleDefinition({ ...base, timeZone }).timeZone).toBe(timeZone);
      expect(validateRuleDefinition({ ...base, timeZone }).valid).toBe(true);
    },
  );

  it("writes '+00:00' and '-00:00' as 'UTC'", () => {
    expect(normalizeRuleDefinition({ ...base, timeZone: '+00:00' }).timeZone).toBe('UTC');
    expect(normalizeRuleDefinition({ ...base, timeZone: '-00:00' }).timeZone).toBe('UTC');
  });

  it('drops a null timeZone and a null effectiveOn, as absent', () => {
    const rule = normalizeRuleDefinition({ ...base, timeZone: null, effectiveOn: null });
    expect(rule).not.toHaveProperty('timeZone');
    expect(rule).not.toHaveProperty('effectiveOn');
  });

  it.each([
    ['Paris', '"Paris"'],
    ['+24:00', '"+24:00"'],
    ['europe/paris', '"europe/paris"'],
    ['', '""'],
    ['Europe/Paris\uD800', '"Europe/Paris\\ud800"'],
    [5, 'a value of type number'],
  ])('refuses the time zone %j', (timeZone, got) => {
    const rule = { ...base, timeZone } as RuleDefinitionInput;
    const message = `${zones}; got ${got}`;
    expect(specError(() => normalizeRuleDefinition(rule))).toMatchObject({
      code: 'INVALID_RULE',
      message,
    });
    expect(validateRuleDefinition(rule).issues).toEqual([{ path: 'timeZone', message }]);
  });

  it.each([
    ['/$dates/facture', {}],
    ['/$dates/a~1b', {}],
    ['/$item/emission', { forEach: { path: '/factures', key: 'id' } }],
    ['/$item/dates/0/at', { forEach: { path: '/factures', key: 'id' } }],
    [
      '/$segment/from',
      { forEach: { segments: { from: '/$dates/a', until: '/$dates/b', facts: [] } } },
    ],
  ])('accepts effectiveOn %j', (effectiveOn, extra) => {
    const rule = { ...base, ...extra, effectiveOn };
    expect(normalizeRuleDefinition(rule).effectiveOn).toBe(effectiveOn);
    expect(validateRuleDefinition(rule).valid).toBe(true);
  });

  it.each([
    ['/revenue', {}, 'effectiveOn must start with /$dates/, /$item/ or /$segment/'],
    ['', {}, 'effectiveOn must start with /$dates/, /$item/ or /$segment/'],
    ['/$outputs/x', {}, 'effectiveOn must start with /$dates/, /$item/ or /$segment/'],
    ['/$dates', {}, 'effectiveOn must name one date: /$dates/<name>'],
    ['/$dates/', {}, 'effectiveOn must name one date: /$dates/<name>'],
    ['/$dates/a/b', {}, 'effectiveOn must name one date: /$dates/<name>'],
    [
      '/$item',
      { forEach: { path: '/a', key: 'id' } },
      'effectiveOn must name a field of the item: /$item/<path>',
    ],
    ['/$dates/-', {}, "effectiveOn must not hold a '-' segment: '-' is not an index"],
    [
      '/$item/x/-',
      { forEach: { path: '/a', key: 'id' } },
      "effectiveOn must not hold a '-' segment: '-' is not an index",
    ],
    ['/$segment/until', {}, 'effectiveOn must be /$segment/from to read a segment'],
    ['/$item/emission', {}, 'effectiveOn reads $item without forEach'],
    ['/$item/emission', { forEach: null }, 'effectiveOn reads $item without forEach'],
    ['/$segment/from', {}, 'effectiveOn reads $segment without segments'],
    [
      '/$segment/from',
      { forEach: { path: '/a', key: 'id' } },
      'effectiveOn reads $segment without segments',
    ],
    [
      'revenue',
      {},
      'effectiveOn must be a JSON pointer: invalid JSON pointer "revenue": ' +
        'must be empty or start with "/"',
    ],
    [
      '/$dates/a~2',
      {},
      'effectiveOn must be a JSON pointer: invalid JSON pointer "/$dates/a~2": ' +
        '"~" must be followed by 0 or 1',
    ],
    [
      '/$dates/\uD800',
      {},
      'effectiveOn must be a JSON pointer: invalid JSON pointer "/$dates/\\ud800": ' +
        'contains a lone UTF-16 surrogate',
    ],
    [7, {}, 'effectiveOn must be a JSON pointer: got a value of type number'],
  ])('refuses effectiveOn %j', (effectiveOn, extra, message) => {
    const rule = { ...base, ...extra, effectiveOn } as RuleDefinitionInput;
    expect(specError(() => normalizeRuleDefinition(rule))).toMatchObject({
      code: 'INVALID_RULE',
      message,
    });
    expect(validateRuleDefinition(rule).issues).toEqual([{ path: 'effectiveOn', message }]);
  });

  it('reads a huge effectiveOn in linear time, and cuts it in a message', () => {
    const deep = `/$item${'/a'.repeat(200_000)}`;
    const items = { forEach: { path: '/x', key: 'id' } };
    expect(normalizeRuleDefinition({ ...base, ...items, effectiveOn: deep }).effectiveOn).toBe(
      deep,
    );
    const bad = `${deep}/~`;
    const issues = validateRuleDefinition({ ...base, ...items, effectiveOn: bad }).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe(
      `effectiveOn must be a JSON pointer: invalid JSON pointer "${bad.slice(0, 256)}…": ` +
        '"~" must be followed by 0 or 1',
    );
  });

  it("drops effectiveOn '/$dates/effective', the default: absent and default are one rule", () => {
    const explicit = { ...base, effectiveOn: '/$dates/effective' };
    expect(normalizeRuleDefinition(explicit)).not.toHaveProperty('effectiveOn');
    expect(computeRuleChecksum(explicit)).toBe(computeRuleChecksum(base));
    expect(validateRuleDefinition(explicit).valid).toBe(true);
  });

  it('reads forEach once: a getter that changes its answer gives a rule that stays valid', () => {
    let reads = 0;
    const rule = {
      ...base,
      effectiveOn: '/$item/x',
      get forEach(): unknown {
        return reads++ === 0 ? { path: '/x', key: 'id' } : null;
      },
    };
    const out = normalizeRuleDefinition(rule);
    expect(reads).toBe(1);
    expect(out.forEach).toEqual({ path: '/x', key: 'id' });
    expect(normalizeRuleDefinition(out)).toEqual(out);
    expect(validateRuleDefinition(out).valid).toBe(true);
    reads = 0;
    expect(validateRuleDefinition(rule).valid).toBe(true);
  });

  it('checks forEach.segments on the copy it keeps', () => {
    let reads = 0;
    const forEach = {
      get segments(): unknown {
        return reads++ === 0 ? { from: '/$dates/a', until: '/$dates/b', facts: [] } : null;
      },
    };
    const rule = { ...base, effectiveOn: '/$segment/from', forEach };
    // `segments` is read once, into the copy; the context is checked on that copy.
    const out = normalizeRuleDefinition(rule);
    expect(reads).toBe(1);
    expect(out.forEach).toEqual({ segments: { from: '/$dates/a', until: '/$dates/b', facts: [] } });
    expect(out.effectiveOn).toBe('/$segment/from');
    expect(normalizeRuleDefinition(out)).toEqual(out);
    expect(validateRuleDefinition(out).valid).toBe(true);
  });

  it('timeZone and effectiveOn enter the checksum', () => {
    const h = computeRuleChecksum(base);
    expect(computeRuleChecksum({ ...base, timeZone: 'Europe/Paris' })).not.toBe(h);
    expect(computeRuleChecksum({ ...base, effectiveOn: '/$dates/facture' })).not.toBe(h);
    expect(computeRuleChecksum({ ...base, timeZone: null, effectiveOn: undefined })).toBe(h);
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

  it('reports a throwing getter at the top level, and normalize refuses it', () => {
    const rule = { ...base };
    throwing(rule, 'id', new Error('boom'));
    const message = 'rule definition could not be read: boom';
    expect(validateRuleDefinition(rule)).toEqual({
      valid: false,
      errors: [message],
      issues: [{ path: '', message }],
    });
    const error = specError(() => normalizeRuleDefinition(rule));
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
    const error = specError(() => normalizeRuleDefinition(rule as RuleDefinitionInput));
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
    const error = specError(() => normalizeRuleDefinition(rule));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe('params could not be read: nope');
  });

  it('names a nested unreadable field of params, condition and an extension', () => {
    const rates = {};
    throwing(rates, 'reduced', new Error('nope'));
    const nested = { ...base, params: { rates: [rates] } };
    expect(validateRuleDefinition(nested).errors).toEqual(['params could not be read: nope']);
    expect(specError(() => normalizeRuleDefinition(nested)).message).toBe(
      'params could not be read: nope',
    );
    const value = {};
    throwing(value, 'var', new Error('x'));
    const condition = { ...base, condition: { dsl: 'jsonlogic', value } };
    expect(specError(() => normalizeRuleDefinition(condition)).message).toBe(
      'condition.value could not be read: x',
    );
    expect(validateRuleDefinition(condition).errors).toEqual([
      'condition.value could not be read: x',
    ]);
    const meta = {};
    throwing(meta, 'owner', new Error('y'));
    const extension = { ...base, meta };
    expect(specError(() => normalizeRuleDefinition(extension)).message).toBe(
      'meta could not be read: y',
    );
    expect(validateRuleDefinition(extension).errors).toEqual(['meta could not be read: y']);
  });

  it(`accepts a free-form value ${MAX_JSON_DEPTH} levels deep, refuses one level more`, () => {
    expect(MAX_JSON_DEPTH).toBe(1000);
    for (const [field, at] of FREE_FORM_FIELDS) {
      const accepted = at(nested(MAX_JSON_DEPTH));
      expect(validateRuleDefinition(accepted)).toEqual({ valid: true, errors: [], issues: [] });
      expect(normalizeRuleDefinition(accepted)).toBeDefined();
      // The first container past the limit: level 1001, `field` being level 1.
      const issue = tooDeepIssue(`${field}${'.a'.repeat(MAX_JSON_DEPTH)}`);
      const refused = at(nested(MAX_JSON_DEPTH + 1));
      expect(validateRuleDefinition(refused)).toEqual({
        valid: false,
        errors: [issue.message],
        issues: [issue],
      });
      expect(specError(() => normalizeRuleDefinition(refused))).toMatchObject({
        code: 'NON_SERIALIZABLE',
        message: issue.message,
        path: issue.path,
      });
    }
  });

  it('counts only non-empty arrays and objects as levels', () => {
    let params: unknown = [];
    for (let i = 0; i < MAX_JSON_DEPTH; i++) params = i % 2 === 0 ? { a: params } : [params];
    const rule = { ...base, params };
    expect(validateRuleDefinition(rule).valid).toBe(true);
    expect(canonicalize(normalizeRuleDefinition(rule).params)).toBe(canonicalize(params));
    // Wrapped once more, the innermost `{ a: [] }` (built first, an object) is level 1001.
    let path = 'params[0]';
    for (let i = MAX_JSON_DEPTH - 1; i > 0; i--) path += i % 2 === 0 ? '.a' : '[0]';
    expect(validateRuleDefinition({ ...base, params: [params] }).issues).toEqual([
      tooDeepIssue(path),
    ]);
  });

  it('refuses a free-form value 200,000 levels deep without overflowing the stack', () => {
    let params: Record<string, unknown> = {};
    for (let i = 0; i < 200_000; i++) params = { a: params };
    expect(validateRuleDefinition({ ...base, params }).issues).toEqual([
      tooDeepIssue(`params${'.a'.repeat(MAX_JSON_DEPTH)}`),
    ]);
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
    expect(specError(() => normalizeRuleDefinition(hostile as RuleDefinitionInput)).message).toBe(
      'rule definition could not be read: keys',
    );
  });
});

describe('lone UTF-16 surrogates in a rule definition', () => {
  // Built from a code unit: an editor or a formatter could rewrite the character.
  const LONE = String.fromCharCode(0xd800);
  const escaped = '\\ud800';
  const lone = (field: string): string => `${field} contains a lone UTF-16 surrogate`;
  const notJson = (path: string): string =>
    `Value at "${path}" cannot be serialized to canonical JSON: ` +
    'a string with a lone UTF-16 surrogate';

  // [label, fields changed on `base`, issue path, issue message, SpecError code of normalize]
  const CASES: [string, Record<string, unknown>, string, string, string][] = [
    ['id', { id: `r${LONE}` }, 'id', lone('id'), 'INVALID_RULE'],
    ['model', { model: LONE }, 'model', lone('model'), 'INVALID_RULE'],
    ['output', { output: `x${LONE}` }, 'output', lone('output'), 'INVALID_RULE'],
    [
      'dominanceGroup',
      { dominanceGroup: LONE },
      'dominanceGroup',
      lone('dominanceGroup'),
      'INVALID_RULE',
    ],
    ['sourceRef', { sourceRef: `art. ${LONE}` }, 'sourceRef', lone('sourceRef'), 'INVALID_RULE'],
    [
      'condition.dsl',
      { condition: { dsl: LONE, value: true } },
      'condition.dsl',
      lone('condition.dsl'),
      'INVALID_RULE',
    ],
    ['a tag', { tags: ['a', LONE] }, 'tags[1]', lone('tags[1]'), 'INVALID_RULE'],
    [
      'a dimension value',
      { dimensions: { country: LONE } },
      'dimensions.country',
      lone('dimensions.country'),
      'INVALID_RULE',
    ],
    [
      'a dimension key',
      { dimensions: { [LONE]: 'BJ' } },
      'dimensions',
      `dimensions has a key with a lone UTF-16 surrogate: "${escaped}"`,
      'INVALID_RULE',
    ],
    [
      'an extension key',
      { [LONE]: 1 },
      '',
      `rule definition has an extension key with a lone UTF-16 surrogate: "${escaped}"`,
      'INVALID_RULE',
    ],
    ['an extension value', { ext: { a: LONE } }, 'ext.a', notJson('ext.a'), 'NON_SERIALIZABLE'],
    [
      'params',
      { params: { base: LONE } },
      'params.base',
      notJson('params.base'),
      'NON_SERIALIZABLE',
    ],
    [
      'condition.value',
      { condition: { dsl: 'jsonlogic', value: { var: LONE } } },
      'condition.value.var',
      notJson('condition.value.var'),
      'NON_SERIALIZABLE',
    ],
    [
      'exceptions',
      { exceptions: [{ kind: 'inhibit', targets: { ids: [LONE] } }] },
      'exceptions[0].targets.ids[0]',
      notJson('exceptions[0].targets.ids[0]'),
      'NON_SERIALIZABLE',
    ],
    [
      'effectiveFrom',
      { effectiveFrom: `2025-01-01${LONE}` },
      'effectiveFrom',
      `effectiveFrom ${DATE_FORMS}; got "2025-01-01${escaped}"`,
      'INVALID_DATE',
    ],
  ];

  it.each(CASES)(
    '%s: one issue, and normalize and the checksum refuse it alike',
    (_l, change, path, message, code) => {
      const rule = { ...base, ...change } as RuleDefinitionInput;
      expect(validateRuleDefinition(rule).issues).toEqual([{ path, message }]);
      const normalized = specError(() => normalizeRuleDefinition(rule));
      expect(normalized.code).toBe(code);
      expect(normalized.message).toBe(message);
      expect(specError(() => computeRuleChecksum(rule)).message).toBe(message);
    },
  );

  it('ignores a key with a lone surrogate whose value is null, as normalize drops it', () => {
    const rule = { ...base, dimensions: { [LONE]: null }, [LONE]: null } as RuleDefinitionInput;
    expect(validateRuleDefinition(rule).valid).toBe(true);
    expect(computeRuleChecksum(rule)).toBe(computeRuleChecksum(base));
  });
});
