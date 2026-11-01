import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import {
  compareOutputValues,
  contributionMatchesDeclaration,
  emptyOutput,
  normalizeOutputDeclaration,
  sameDeclaration,
  validateOutputDeclaration,
  valueMatchesOutputType,
} from '../src/index.js';
import type { CombineStrategy, JsonValue, OutputDeclaration } from '../src/index.js';
import { lastValuesSpent } from '../src/values.js';
import { countValues, loose, specError } from './helpers.js';

const DATE: OutputDeclaration = { type: 'date', combine: 'max' };
const DATE_TIME: OutputDeclaration = { type: 'dateTime', combine: 'min' };
const COUNT: OutputDeclaration = { type: 'number', combine: 'count' };

describe('valueMatchesOutputType: dates and instants', () => {
  it('date: a real civil date only', () => {
    expect(valueMatchesOutputType('2028-02-29', DATE)).toBe(true);
    expect(valueMatchesOutputType('0000-01-01', DATE)).toBe(true);
    expect(valueMatchesOutputType('9999-12-31', DATE)).toBe(true);
    for (const value of [
      '2026-02-29',
      '2026-01-01T00:00:00.000Z',
      '2026-1-01',
      '20260101',
      '',
      20260101,
      null,
      ['2026-01-01'],
    ]) {
      expect([value, valueMatchesOutputType(value, DATE)]).toEqual([value, false]);
    }
  });

  it('dateTime: the canonical instant form only', () => {
    expect(valueMatchesOutputType('2026-01-01T00:00:00.000Z', DATE_TIME)).toBe(true);
    expect(valueMatchesOutputType('2028-02-29T23:59:59.999Z', DATE_TIME)).toBe(true);
    for (const value of [
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00.000+00:00',
      '2026-01-01T01:00:00.000+01:00',
      '2026-01-01T00:00:00.000z',
      '2026-02-29T00:00:00.000Z',
      '2026-01-01',
      0,
      null,
    ]) {
      expect([value, valueMatchesOutputType(value, DATE_TIME)]).toEqual([value, false]);
    }
  });
});

describe('count', () => {
  it('a contribution is a boolean, never a number', () => {
    expect(contributionMatchesDeclaration(true, COUNT)).toBe(true);
    expect(contributionMatchesDeclaration(false, COUNT)).toBe(true);
    for (const value of [1, 0, 'true', null, [true]]) {
      expect([value, contributionMatchesDeclaration(value, COUNT)]).toEqual([value, false]);
    }
  });

  it('the combined value is a non-negative safe integer', () => {
    expect(valueMatchesOutputType(2, COUNT)).toBe(true);
    expect(valueMatchesOutputType(0, COUNT)).toBe(true);
    expect(valueMatchesOutputType(Number.MAX_SAFE_INTEGER, COUNT)).toBe(true);
    for (const value of [1.5, -1, 2 ** 53, true, '2', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect([value, valueMatchesOutputType(value, COUNT)]).toEqual([value, false]);
    }
  });

  it('another strategy checks a contribution as a value of the output', () => {
    const sum: OutputDeclaration = { type: 'decimal', combine: 'sum' };
    expect(contributionMatchesDeclaration('12.5', sum)).toBe(true);
    expect(contributionMatchesDeclaration('12.50', sum)).toBe(false);
    expect(contributionMatchesDeclaration(true, sum)).toBe(false);
    const all: OutputDeclaration = { type: 'boolean', combine: 'all' };
    expect(contributionMatchesDeclaration(true, all)).toBe(true);
    expect(contributionMatchesDeclaration(1, all)).toBe(false);
  });
});

describe('sign', () => {
  const nonNegative = (type: 'number' | 'decimal'): OutputDeclaration => ({
    type,
    combine: 'sum',
    sign: 'nonNegative',
  });
  const nonPositive = (type: 'number' | 'decimal'): OutputDeclaration => ({
    type,
    combine: 'sum',
    sign: 'nonPositive',
  });

  it('nonNegative: zero and above, for values and contributions alike', () => {
    for (const check of [valueMatchesOutputType, contributionMatchesDeclaration]) {
      expect([0, 3.5, -0].map((v) => check(v, nonNegative('number')))).toEqual([true, true, true]);
      expect(check(-0.1, nonNegative('number'))).toBe(false);
      expect(['0', '7', '0.01'].map((v) => check(v, nonNegative('decimal')))).toEqual([
        true,
        true,
        true,
      ]);
      expect(check('-0.01', nonNegative('decimal'))).toBe(false);
    }
  });

  it('nonPositive: zero and below', () => {
    expect([0, -3.5].map((v) => valueMatchesOutputType(v, nonPositive('number')))).toEqual([
      true,
      true,
    ]);
    expect(valueMatchesOutputType(0.1, nonPositive('number'))).toBe(false);
    expect(['0', '-7'].map((v) => valueMatchesOutputType(v, nonPositive('decimal')))).toEqual([
      true,
      true,
    ]);
    expect(valueMatchesOutputType('0.5', nonPositive('decimal'))).toBe(false);
  });

  it('absent: no constraint', () => {
    expect(valueMatchesOutputType(-5, { type: 'number', combine: 'sum' })).toBe(true);
    expect(valueMatchesOutputType('-5', { type: 'decimal', combine: 'sum' })).toBe(true);
  });
});

describe('emptyOutput: the output no contribution reached', () => {
  const cases: [string, OutputDeclaration, { value?: JsonValue; status: string }][] = [
    ['sum of numbers', { type: 'number', combine: 'sum' }, { value: 0, status: 'determined' }],
    ['sum of decimals', { type: 'decimal', combine: 'sum' }, { value: '0', status: 'determined' }],
    ['count', COUNT, { value: 0, status: 'determined' }],
    ['union', { type: 'list', combine: 'union' }, { value: [], status: 'determined' }],
    ['any', { type: 'boolean', combine: 'any' }, { value: false, status: 'determined' }],
    ['all', { type: 'boolean', combine: 'all' }, { status: 'undetermined' }],
    [
      'all with empty: true',
      { type: 'boolean', combine: 'all', empty: true },
      { value: true, status: 'determined' },
    ],
    [
      'all with empty: false',
      { type: 'boolean', combine: 'all', empty: false },
      { status: 'undetermined' },
    ],
    ['max', { type: 'number', combine: 'max' }, { status: 'determined' }],
    ['min of dates', { type: 'date', combine: 'min' }, { status: 'determined' }],
    ['highestPriority', { type: 'string', combine: 'highestPriority' }, { status: 'determined' }],
  ];

  it.each(cases)('%s', (_name, declaration, expected) => {
    const empty = emptyOutput(declaration);
    expect(empty).toStrictEqual(expected);
    // No `value` member at all when there is no value: never `value: undefined` nor `null`.
    expect(Object.hasOwn(empty, 'value')).toBe(Object.hasOwn(expected, 'value'));
  });

  it('gives a fresh object each time: a caller cannot change the next one', () => {
    const union: OutputDeclaration = { type: 'list', combine: 'union' };
    const first = emptyOutput(union);
    if (!Array.isArray(first.value)) throw new Error('union gives a list');
    first.value.push(1);
    expect(emptyOutput(union)).toStrictEqual({ value: [], status: 'determined' });
  });

  it('every strategy has an empty output', () => {
    const strategies: CombineStrategy[] = [
      'sum',
      'max',
      'min',
      'highestPriority',
      'union',
      'all',
      'any',
      'count',
    ];
    const typeOf: Record<CombineStrategy, OutputDeclaration['type']> = {
      sum: 'number',
      max: 'number',
      min: 'number',
      highestPriority: 'object',
      union: 'list',
      all: 'boolean',
      any: 'boolean',
      count: 'number',
    };
    expect(
      strategies.map((combine) => emptyOutput({ type: typeOf[combine], combine }).status),
    ).toEqual([
      'determined',
      'determined',
      'determined',
      'determined',
      'determined',
      'undetermined',
      'determined',
      'determined',
    ]);
  });
});

describe('a declaration the validator refuses is never used', () => {
  const invalid: [string, unknown, string, string][] = [
    [
      'a combination that cannot be',
      { type: 'string', combine: 'sum' },
      'output.combine',
      'output.combine "sum" cannot combine a string output: it applies to number, decimal',
    ],
    [
      'an enum without values',
      { type: 'enum', combine: 'highestPriority' },
      'output.values',
      'output.values is required for an enum output: list its allowed strings',
    ],
    [
      'an unknown type',
      { type: 'x', combine: 'sum' },
      'output.type',
      'output.type must be one of ' +
        'number, boolean, string, enum, list, object, decimal, date, dateTime',
    ],
    [
      'a sign on a max',
      { type: 'number', combine: 'max', sign: 'nonNegative' },
      'output.sign',
      'output.sign applies only to a sum output',
    ],
  ];
  const calls: [string, (d: OutputDeclaration) => unknown][] = [
    ['valueMatchesOutputType', (d) => valueMatchesOutputType('a', d)],
    ['contributionMatchesDeclaration', (d) => contributionMatchesDeclaration('a', d)],
    ['emptyOutput', (d) => emptyOutput(d)],
  ];

  it.each(invalid)('%s', (_name, declaration, path, message) => {
    for (const [name, call] of calls) {
      const error = specError(() => call(loose<OutputDeclaration>(declaration)));
      expect([name, error.code, error.message, error.path]).toEqual([
        name,
        'INVALID_RULE',
        `invalid output declaration: ${message}`,
        path,
      ]);
    }
  });

  it('a value that cannot be inspected matches no type', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const list: OutputDeclaration = { type: 'list', combine: 'union' };
    expect(valueMatchesOutputType(loose<JsonValue>(proxy), list)).toBe(false);
    expect(contributionMatchesDeclaration(loose<JsonValue>(proxy), list)).toBe(false);
  });

  it('the canonical entry exports the same functions', () => {
    expect(canonicalEntry.contributionMatchesDeclaration).toBe(contributionMatchesDeclaration);
    expect(canonicalEntry.emptyOutput).toBe(emptyOutput);
  });
});

describe('a declaration is read once, each value counted once', () => {
  /** `declaration` with each member, and each rounding member, behind a counting getter. */
  function counted(declaration: Record<string, unknown>, reads: Map<string, number>): object {
    const wrap = (source: Record<string, unknown>, prefix: string): object => {
      const target = {};
      for (const [key, value] of Object.entries(source)) {
        const inner =
          typeof value === 'object' && value !== null && !Array.isArray(value)
            ? wrap(loose<Record<string, unknown>>(value), `${key}.`)
            : value;
        Object.defineProperty(target, key, {
          enumerable: true,
          get: () => {
            reads.set(`${prefix}${key}`, (reads.get(`${prefix}${key}`) ?? 0) + 1);
            return inner;
          },
        });
      }
      return target;
    };
    return wrap(declaration, '');
  }

  const RICH = {
    type: 'decimal',
    combine: 'sum',
    rounding: { increment: '0.05', mode: 'halfUp', at: 'contribution' },
    unit: 'XOF',
    per: '/items',
    sign: 'nonNegative',
  };
  const calls: [string, (d: OutputDeclaration) => unknown][] = [
    ['validateOutputDeclaration', (d) => validateOutputDeclaration(d)],
    ['normalizeOutputDeclaration', normalizeOutputDeclaration],
    ['valueMatchesOutputType', (d) => valueMatchesOutputType('1', d)],
    ['contributionMatchesDeclaration', (d) => contributionMatchesDeclaration('1', d)],
    ['emptyOutput', emptyOutput],
    ['compareOutputValues', (d) => compareOutputValues('1', '2', d)],
  ];

  it.each(calls)('%s', (_name, call) => {
    const reads = new Map<string, number>();
    call(loose<OutputDeclaration>(counted(RICH, reads)));
    expect(Object.fromEntries(reads)).toEqual({
      type: 1,
      combine: 1,
      rounding: 1,
      'rounding.increment': 1,
      'rounding.mode': 1,
      'rounding.at': 1,
      unit: 1,
      per: 1,
      sign: 1,
    });
    expect(lastValuesSpent()).toBe(countValues(RICH));
  });

  it('sameDeclaration reads each side once, and counts both', () => {
    const reads = new Map<string, number>();
    const enumDeclaration = { type: 'enum', combine: 'max', values: ['a', 'b'] };
    sameDeclaration(
      loose<OutputDeclaration>(counted(enumDeclaration, reads)),
      loose<OutputDeclaration>(counted(enumDeclaration, reads)),
    );
    expect(Object.fromEntries(reads)).toEqual({ type: 2, combine: 2, values: 2 });
    expect(lastValuesSpent()).toBe(2 * countValues(enumDeclaration));
  });
});
