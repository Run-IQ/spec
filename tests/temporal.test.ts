import { describe, expect, it } from 'vitest';
import { validateTemporalFact } from '../src/index.js';
import type { TemporalValue } from '../src/index.js';
import { nested } from './helpers.js';

const SALARY: TemporalValue[] = [
  { from: '2026-01-01', until: '2026-01-15', value: '3000' },
  { from: '2026-01-15', until: null, value: '3300' },
];

const check = (value: unknown): unknown => validateTemporalFact(value, '/salaire');
const MERGE = 'merge adjacent periods with the same value at /salaire/1';

describe('validateTemporalFact', () => {
  it('accepts periods that follow each other', () => {
    expect(check(SALARY)).toEqual([]);
  });

  it('accepts a gap between periods and any JSON value', () => {
    expect(
      check([
        { from: '2026-01-01', until: '2026-01-10', value: { base: 3000, primes: [100] } },
        { from: '2026-02-01', until: '2026-03-01', value: null },
        { from: '2026-03-01', until: null, value: true },
      ]),
    ).toEqual([]);
  });

  it('refuses adjacent periods with the same value: one meaning, one written form', () => {
    expect(
      check([
        { from: '2026-01-01', until: '2026-01-15', value: { a: 1, b: [2] } },
        { from: '2026-01-15', until: null, value: { b: [2], a: 1 } },
      ]),
    ).toEqual([{ path: '/salaire/1', message: MERGE }]);
    expect(
      check([
        { from: '2026-01-01', until: '2026-01-15', value: '3000' },
        { from: '2026-01-15', until: '2026-02-01', value: '3000' },
      ]),
    ).toEqual([{ path: '/salaire/1', message: MERGE }]);
  });

  it('refuses an empty history: one written form for "no value at any date"', () => {
    expect(check([])).toEqual([
      {
        path: '/salaire',
        message: '/salaire is empty: omit the fact: an empty history says nothing',
      },
    ]);
  });

  it('never merges values that have a problem (M4)', () => {
    expect(
      check([
        { from: '2026-01-01', until: '2026-01-15', value: { '\ud800': 1 } },
        { from: '2026-01-15', until: null, value: { '\ud801': 2 } },
      ]),
    ).toEqual([
      {
        path: '/salaire/0/value',
        message: '/salaire/0/value has a key with a lone UTF-16 surrogate: "\\ud800"',
      },
      {
        path: '/salaire/1/value',
        message: '/salaire/1/value has a key with a lone UTF-16 surrogate: "\\ud801"',
      },
    ]);
    expect(
      check([
        { from: '2026-01-01', until: '2026-01-15', value: 2 ** 53 },
        { from: '2026-01-15', until: null, value: 2 ** 53 },
      ]),
    ).toEqual([
      { path: '/salaire/0/value', message: 'number beyond 2^53 at /salaire/0/value' },
      { path: '/salaire/1/value', message: 'number beyond 2^53 at /salaire/1/value' },
    ]);
  });

  it('lists at most 100 problems, then says more were not listed', () => {
    const periods = Array.from({ length: 500 }, () => ({ from: 'x', until: null, value: 1 }));
    const issues = check(periods) as { path: string; message: string }[];
    expect(issues).toHaveLength(101);
    expect(issues[99]).toEqual({
      path: '/salaire/99/from',
      message: '/salaire/99/from must be a civil date YYYY-MM-DD',
    });
    expect(issues[100]).toEqual({ path: '', message: 'further problems not listed (limit 100)' });
  });

  it('accepts the same value after a gap, and adjacent periods with different values', () => {
    expect(
      check([
        { from: '2026-01-01', until: '2026-01-15', value: '3000' },
        { from: '2026-01-16', until: null, value: '3000' },
      ]),
    ).toEqual([]);
    expect(
      check([
        { from: '2026-01-01', until: '2026-01-15', value: 3000 },
        { from: '2026-01-15', until: null, value: '3000' },
      ]),
    ).toEqual([]);
  });

  it('compares a value shared by many paths without walking every path', () => {
    let a: unknown = 1;
    let b: unknown = 1;
    for (let i = 0; i < 60; i++) {
      a = { l: a, r: a };
      b = { r: b, l: b };
    }
    expect(
      check([
        { from: '2026-01-01', until: '2026-01-15', value: a },
        { from: '2026-01-15', until: null, value: b },
      ]),
    ).toEqual([{ path: '/salaire/1', message: MERGE }]);
  });

  it.each([
    [
      'an open period followed by another',
      [
        { from: '2026-01-01', until: null, value: 1 },
        { from: '2026-02-01', until: null, value: 2 },
      ],
    ],
    [
      'a period ending after the next one starts',
      [
        { from: '2026-01-01', until: '2026-02-01', value: 1 },
        { from: '2026-01-31', until: '2026-03-01', value: 2 },
      ],
    ],
    [
      'two periods starting the same day',
      [
        { from: '2026-01-01', until: '2026-01-02', value: 1 },
        { from: '2026-01-01', until: '2026-01-03', value: 2 },
      ],
    ],
  ])('refuses %s', (_name, periods) => {
    expect(check(periods)).toEqual([{ path: '/salaire/1', message: 'overlap at /salaire/1' }]);
  });

  it('reports an overlap with any earlier period, not only the previous one', () => {
    expect(
      check([
        { from: '2026-01-01', until: '2026-12-31', value: 1 },
        { from: '2026-02-01', until: '2026-03-01', value: 2 },
        { from: '2026-04-01', until: '2026-05-01', value: 3 },
      ]),
    ).toEqual([
      { path: '/salaire/1', message: 'overlap at /salaire/1' },
      { path: '/salaire/2', message: 'overlap at /salaire/2' },
    ]);
  });

  it('refuses periods out of order: one meaning, one written form', () => {
    expect(check([...SALARY].reverse())).toEqual([
      {
        path: '/salaire/1',
        message: '/salaire/1 must start after /salaire/0: periods are sorted by from',
      },
    ]);
  });

  it.each([
    ['ends the day it starts', '2026-01-15'],
    ['ends before it starts', '2026-01-14'],
  ])('refuses a period that %s (until %s)', (_name, until) => {
    expect(check([{ from: '2026-01-15', until, value: 1 }])).toEqual([
      {
        path: '/salaire/0/until',
        message: '/salaire/0/until must be after from 2026-01-15: the period is empty',
      },
    ]);
  });

  it.each([
    ['an instant', '2026-01-01T00:00:00.000Z'],
    ['a day that does not exist', '2026-02-30'],
    ['null', null],
  ])('refuses from as %s', (_name, from) => {
    expect(check([{ from, until: null, value: 1 }])).toEqual([
      { path: '/salaire/0/from', message: '/salaire/0/from must be a civil date YYYY-MM-DD' },
    ]);
  });

  it('refuses an until that is not a civil date or null, and an absent until', () => {
    expect(check([{ from: '2026-01-01', until: '2026-02-01T00:00:00.000Z', value: 1 }])).toEqual([
      {
        path: '/salaire/0/until',
        message: '/salaire/0/until must be a civil date YYYY-MM-DD or null',
      },
    ]);
    expect(check([{ from: '2026-01-01', value: 1 }])).toEqual([
      { path: '/salaire/0/until', message: '/salaire/0/until is required: null has no end' },
    ]);
  });

  it('refuses an absent value, an unknown key and a period that is not an object', () => {
    expect(check([{ from: '2026-01-01', until: null }])).toEqual([
      { path: '/salaire/0/value', message: '/salaire/0/value is required' },
    ]);
    expect(check([{ from: '2026-01-01', until: null, value: 1, to: '2026-02-01' }])).toEqual([
      { path: '/salaire/0/to', message: '/salaire/0 has an unknown key "to"' },
    ]);
    expect(check(['2026-01-01'])).toEqual([
      { path: '/salaire/0', message: '/salaire/0 must be a period { from, until, value }' },
    ]);
  });

  it.each([
    ['an object', { from: '2026-01-01', until: null, value: 1 }],
    ['a text', '3000'],
    ['null', null],
  ])('refuses %s as a temporal fact', (_name, value) => {
    expect(check(value)).toEqual([
      { path: '/salaire', message: '/salaire must be a list of periods { from, until, value }' },
    ]);
  });

  it('checks the value as input data: no number beyond 2^53, no lone surrogate', () => {
    expect(
      check([
        { from: '2026-01-01', until: '2026-02-01', value: { n: 2 ** 53 } },
        { from: '2026-02-01', until: null, value: ['x\uD800'] },
      ]),
    ).toEqual([
      {
        path: '/salaire/0/value/n',
        message: 'number beyond 2^53 at /salaire/0/value/n',
      },
      {
        path: '/salaire/1/value/0',
        message: '/salaire/1/value/0 contains a lone UTF-16 surrogate',
      },
    ]);
  });

  it('never throws: a getter that throws, a revoked Proxy, a deep nesting', () => {
    const period = { from: '2026-01-01', until: null };
    Object.defineProperty(period, 'value', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(check([period])).toEqual([
      { path: '/salaire/0/value', message: '/salaire/0/value could not be read: boom' },
    ]);
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    expect(check(proxy)).toEqual([
      {
        path: '/salaire',
        message:
          "/salaire could not be read: Cannot perform 'IsArray' on a proxy that has been revoked",
      },
    ]);
    const deep = check([{ from: '2026-01-01', until: null, value: nested(10_000) }]);
    const path = `/salaire/0/value${'/a'.repeat(1000)}`;
    expect(deep).toEqual([
      {
        path: `${path.slice(0, 1024)}…`,
        message: `${path.slice(0, 256)}… nests values more than 1000 levels deep`,
      },
    ]);
  });

  it('reads each property once', () => {
    const reads = new Map<string, number>();
    const period = (index: number, fields: Record<string, unknown>): object => {
      const out = {};
      for (const [key, value] of Object.entries(fields)) {
        Object.defineProperty(out, key, {
          enumerable: true,
          get() {
            reads.set(`${index}.${key}`, (reads.get(`${index}.${key}`) ?? 0) + 1);
            return value;
          },
        });
      }
      return out;
    };
    const periods = SALARY.map((p, i) => period(i, { ...p }));
    expect(check(periods)).toEqual([]);
    expect(reads.size).toBe(6);
    expect([...reads.values()].every((n) => n === 1)).toBe(true);
  });
});
