import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import {
  canonicalize,
  normalizeOutputDeclaration,
  sameDeclaration,
  sha256Hex,
  validateOutputDeclaration,
  validateRuleDefinition,
} from '../src/index.js';
import type { OutputDeclaration } from '../src/index.js';
import { BASE_RULE, loose, specError } from './helpers.js';

const SUM: OutputDeclaration = { type: 'decimal', combine: 'sum' };
const LONE = String.fromCharCode(0xd800);

/** The problems of `SUM` (or `base`) with `field` set to `value`. */
function issuesWith(
  field: string,
  value: unknown,
  base: Record<string, unknown> = { ...SUM },
): unknown {
  return validateOutputDeclaration({ ...base, [field]: value });
}

describe('rounding.increment', () => {
  const rounded = (rounding: unknown): unknown => issuesWith('rounding', rounding);

  it.each(['0.05', '10', '0.25', '12', '1000', '0.00000000000000000005'])(
    'accepts %s',
    (increment) => {
      expect(rounded({ increment, mode: 'halfUp' })).toEqual([]);
    },
  );

  const refused: [unknown, string][] = [
    ['0', 'output.rounding.increment must be greater than 0'],
    ['-1', 'output.rounding.increment must be greater than 0'],
    ['-0.050', 'output.rounding.increment must be greater than 0'],
    ['0.050', 'output.rounding.increment must be written "0.05"'],
    ['05', 'output.rounding.increment must be written "5"'],
    ['0.000000000000000000001', 'output.rounding.increment must have at most 20 decimal places'],
    ['1e-2', 'output.rounding.increment must be a decimal string ("0.05", "10")'],
    ['.05', 'output.rounding.increment must be a decimal string ("0.05", "10")'],
    ['', 'output.rounding.increment must be a decimal string ("0.05", "10")'],
    [0.05, 'output.rounding.increment must be a decimal string ("0.05", "10")'],
    [null, 'output.rounding.increment must be a decimal string ("0.05", "10")'],
  ];

  it.each(refused)('refuses %j, at its path', (increment, message) => {
    expect(rounded({ increment, mode: 'halfUp' })).toEqual([
      { path: 'output.rounding.increment', message },
    ]);
  });

  it('refuses scale and increment together, and neither, at the rounding', () => {
    expect(rounded({ scale: 2, increment: '0.05', mode: 'halfUp' })).toEqual([
      {
        path: 'output.rounding',
        message: 'output.rounding must have scale or increment, not both',
      },
    ]);
    expect(rounded({ mode: 'halfUp' })).toEqual([
      { path: 'output.rounding', message: 'output.rounding needs scale or increment' },
    ]);
  });

  it('refuses any rounding on a count: its value is an integer', () => {
    const count = { type: 'number', combine: 'count' };
    for (const rounding of [
      { scale: 0, mode: 'down' },
      { increment: '10', mode: 'down' },
    ]) {
      expect(issuesWith('rounding', rounding, count)).toEqual([
        {
          path: 'output.rounding',
          message: 'output.rounding does not apply to a count: its value is an integer',
        },
      ]);
    }
  });
});

describe('unit', () => {
  it('accepts a non-empty string on a number or decimal output', () => {
    expect(issuesWith('unit', 'XOF')).toEqual([]);
    expect(issuesWith('unit', 'm²', { type: 'number', combine: 'max' })).toEqual([]);
    expect(issuesWith('unit', 'persons', { type: 'number', combine: 'count' })).toEqual([]);
  });

  it('refuses an empty string and any other value', () => {
    for (const unit of ['', 1, null, ['XOF']]) {
      expect(issuesWith('unit', unit)).toEqual([
        { path: 'output.unit', message: 'output.unit must be a non-empty string' },
      ]);
    }
  });

  it('refuses white space around it and a lone surrogate: one unit, one written form', () => {
    for (const unit of [' XOF', 'XOF ', '\tXOF', 'XOF\n']) {
      expect(issuesWith('unit', unit)).toEqual([
        { path: 'output.unit', message: 'output.unit must not start or end with white space' },
      ]);
    }
    expect(issuesWith('unit', `X${LONE}`)).toEqual([
      { path: 'output.unit', message: 'output.unit contains a lone UTF-16 surrogate' },
    ]);
  });

  it.each(['boolean', 'string', 'list', 'object', 'date', 'dateTime'] as const)(
    'refuses a unit on a %s output',
    (type) => {
      expect(issuesWith('unit', 'XOF', { type, combine: 'highestPriority' })).toEqual([
        { path: 'output.unit', message: 'output.unit applies only to a number or decimal output' },
      ]);
    },
  );
});

describe('empty', () => {
  const all = { type: 'boolean', combine: 'all' };

  it('is allowed on an all output, true or false', () => {
    expect(issuesWith('empty', true, all)).toEqual([]);
    expect(issuesWith('empty', false, all)).toEqual([]);
  });

  it('is refused with any other strategy, even false', () => {
    for (const [empty, base] of [
      [true, { type: 'boolean', combine: 'any' }],
      [false, { type: 'boolean', combine: 'any' }],
      [true, { type: 'number', combine: 'sum' }],
    ] as const) {
      expect(issuesWith('empty', empty, base)).toEqual([
        { path: 'output.empty', message: 'output.empty applies only to an all output' },
      ]);
    }
  });

  it('must be a boolean', () => {
    for (const empty of ['true', 1, null]) {
      expect(issuesWith('empty', empty, all)).toEqual([
        { path: 'output.empty', message: 'output.empty must be a boolean' },
      ]);
    }
  });
});

describe('sign', () => {
  it('is allowed on a sum of numbers or decimals', () => {
    for (const sign of ['nonNegative', 'nonPositive']) {
      expect(issuesWith('sign', sign)).toEqual([]);
      expect(issuesWith('sign', sign, { type: 'number', combine: 'sum' })).toEqual([]);
    }
  });

  it('is refused with any other strategy', () => {
    for (const base of [
      { type: 'number', combine: 'max' },
      { type: 'number', combine: 'count' },
      { type: 'decimal', combine: 'highestPriority' },
    ]) {
      expect(issuesWith('sign', 'nonNegative', base)).toEqual([
        { path: 'output.sign', message: 'output.sign applies only to a sum output' },
      ]);
    }
  });

  it('must be one of the two signs', () => {
    for (const sign of ['positive', '', null, 1]) {
      expect(issuesWith('sign', sign)).toEqual([
        { path: 'output.sign', message: 'output.sign must be one of nonNegative, nonPositive' },
      ]);
    }
  });
});

describe('per: the same refusals as forEach.path', () => {
  const POINTERS: unknown[] = [
    '/foyers',
    '/foyers/*/personnes',
    '/a/0/b',
    '',
    'foyers',
    '/*',
    '/a/*',
    '/a/*/*/b',
    '/$item/x',
    '/a/-/b',
    '/a/@x',
    '/a/!y/b',
    '/a~2',
    7,
    null,
  ];

  it.each(POINTERS)('%j', (per) => {
    const forEach = validateRuleDefinition({ ...BASE_RULE, forEach: { path: per, key: 'id' } });
    const expected = forEach.issues
      .filter((issue) => issue.path === 'forEach.path')
      .map((issue) => ({
        path: 'output.per',
        message: issue.message.replace('forEach.path', 'output.per'),
      }));
    expect(issuesWith('per', per)).toEqual(expected);
  });

  it('refuses a lone surrogate (a rule refuses it before reading forEach.path)', () => {
    expect(issuesWith('per', `/a${LONE}`)).toEqual([
      {
        path: 'output.per',
        message:
          'output.per must be a JSON pointer: ' +
          'invalid JSON pointer "/a\\ud800": contains a lone UTF-16 surrogate',
      },
    ]);
  });

  it('the list holds accepted and refused pointers', () => {
    const accepted = POINTERS.filter(
      (per) => validateOutputDeclaration({ ...SUM, per }).length === 0,
    );
    expect(accepted).toEqual(['/foyers', '/foyers/*/personnes', '/a/0/b']);
  });
});

describe('dimension', () => {
  const level = { type: 'enum', combine: 'max', values: ['low', 'high'] };

  it('is allowed on a string or enum output', () => {
    expect(issuesWith('dimension', 'riskLevel', level)).toEqual([]);
    const string = { type: 'string', combine: 'highestPriority' };
    expect(issuesWith('dimension', 'country', string)).toEqual([]);
  });

  it.each(['number', 'decimal', 'boolean', 'list', 'object', 'date', 'dateTime'] as const)(
    'is refused on a %s output',
    (type) => {
      expect(issuesWith('dimension', 'x', { type, combine: 'highestPriority' })).toEqual([
        {
          path: 'output.dimension',
          message: 'output.dimension applies only to a string or enum output',
        },
      ]);
    },
  );

  it('refuses a name no dimension can have', () => {
    const refused: [unknown, string][] = [
      ['', 'output.dimension must not be empty'],
      ['-', 'output.dimension must not be "-"'],
      [
        '$country',
        'output.dimension must not start with "$": dimension names starting with "$" are reserved',
      ],
      [`c${LONE}`, 'output.dimension contains a lone UTF-16 surrogate'],
      [1, 'output.dimension must be a string: the name of the dimension the output sets'],
    ];
    for (const [dimension, message] of refused) {
      expect(issuesWith('dimension', dimension, level)).toEqual([
        { path: 'output.dimension', message },
      ]);
    }
  });

  it('is exclusive with per (D-19), reported with the other problems of either', () => {
    expect(validateOutputDeclaration({ ...level, per: '/items', dimension: 'risk' })).toEqual([
      { path: 'output', message: 'output: per and dimension are exclusive' },
    ]);
    expect(validateOutputDeclaration({ ...level, per: '/*', dimension: '$risk' })).toEqual([
      { path: 'output.per', message: 'output.per must start with a collection name, not "*"' },
      {
        path: 'output.dimension',
        message:
          'output.dimension must not start with "$": ' +
          'dimension names starting with "$" are reserved',
      },
      { path: 'output', message: 'output: per and dimension are exclusive' },
    ]);
  });
});

describe('normalizeOutputDeclaration: one meaning, one written form', () => {
  const cases: [string, unknown, OutputDeclaration][] = [
    [
      'empty: false is absent',
      { type: 'boolean', combine: 'all', empty: false },
      { type: 'boolean', combine: 'all' },
    ],
    [
      'empty: true is kept',
      { type: 'boolean', combine: 'all', empty: true },
      { type: 'boolean', combine: 'all', empty: true },
    ],
    [
      "at: 'output' is absent (R37)",
      { ...SUM, rounding: { scale: 2, mode: 'up', at: 'output' } },
      { ...SUM, rounding: { scale: 2, mode: 'up' } },
    ],
    [
      'an increment of 0.01 is scale 2',
      { ...SUM, rounding: { increment: '0.01', mode: 'up', at: 'contribution' } },
      { ...SUM, rounding: { scale: 2, mode: 'up', at: 'contribution' } },
    ],
    [
      'an increment of 1 is scale 0',
      { ...SUM, rounding: { increment: '1', mode: 'floor' } },
      { ...SUM, rounding: { scale: 0, mode: 'floor' } },
    ],
    [
      'an increment of 10^-20 is scale 20',
      { ...SUM, rounding: { increment: '0.00000000000000000001', mode: 'floor' } },
      { ...SUM, rounding: { scale: 20, mode: 'floor' } },
    ],
    [
      'any other increment is kept',
      { ...SUM, rounding: { increment: '10', mode: 'halfEven' } },
      { ...SUM, rounding: { increment: '10', mode: 'halfEven' } },
    ],
    [
      'an undefined member is absent, known or not',
      { ...SUM, unit: undefined, sign: undefined, other: undefined },
      SUM,
    ],
    [
      'every other field is kept as written',
      {
        type: 'enum',
        combine: 'max',
        values: ['minimal', 'limited', 'high', 'prohibited'],
        per: '/systems',
      },
      {
        type: 'enum',
        combine: 'max',
        values: ['minimal', 'limited', 'high', 'prohibited'],
        per: '/systems',
      },
    ],
  ];

  it.each(cases)('%s', (_name, declaration, normal) => {
    const normalized = normalizeOutputDeclaration(loose<OutputDeclaration>(declaration));
    expect(normalized).toStrictEqual(normal);
    expect(normalizeOutputDeclaration(normalized)).toStrictEqual(normal);
    expect(validateOutputDeclaration(normalized)).toEqual([]);
  });

  it('refuses what the validator refuses, with its first problem and path', () => {
    const error = specError(() =>
      normalizeOutputDeclaration(loose({ type: 'list', combine: 'sum', unit: '' })),
    );
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe(
      'invalid output declaration: ' +
        'output.combine "sum" cannot combine a list output: it applies to number, decimal',
    );
    expect(error.path).toBe('output.combine');
  });

  it('copies: the caller keeps its declaration, and changing the copy changes nothing', () => {
    const values = ['low', 'high'];
    const declaration: OutputDeclaration = { type: 'enum', combine: 'max', values };
    const normal = normalizeOutputDeclaration(declaration);
    expect(normal.values).not.toBe(values);
    normal.values?.push('x');
    expect(values).toEqual(['low', 'high']);
  });
});

describe('sameDeclaration', () => {
  it('compares the normal forms', () => {
    const all: OutputDeclaration = { type: 'boolean', combine: 'all' };
    expect(sameDeclaration({ ...all, empty: false }, all)).toBe(true);
    expect(sameDeclaration({ ...all, empty: true }, all)).toBe(false);
    expect(
      sameDeclaration(
        { ...SUM, rounding: { increment: '0.1', mode: 'up', at: 'output' } },
        { ...SUM, rounding: { scale: 1, mode: 'up' } },
      ),
    ).toBe(true);
  });

  it('two declarations that differ only by unit are not the same (D-9)', () => {
    expect(sameDeclaration({ ...SUM, unit: 'XOF' }, { ...SUM, unit: 'EUR' })).toBe(false);
    expect(sameDeclaration({ ...SUM, unit: 'XOF' }, SUM)).toBe(false);
    expect(sameDeclaration({ ...SUM, unit: 'XOF' }, { ...SUM, unit: 'XOF' })).toBe(true);
  });

  it('the order of enum values is part of the declaration: it ranks them', () => {
    const levels = (values: string[]): OutputDeclaration => ({
      type: 'enum',
      combine: 'max',
      values,
    });
    expect(sameDeclaration(levels(['low', 'high']), levels(['high', 'low']))).toBe(false);
  });

  it('sign, per and dimension are part of it; an absent sign is no constraint', () => {
    expect(sameDeclaration({ ...SUM, sign: 'nonNegative' }, SUM)).toBe(false);
    expect(sameDeclaration({ ...SUM, per: '/a' }, { ...SUM, per: '/b' })).toBe(false);
    const string: OutputDeclaration = { type: 'string', combine: 'highestPriority' };
    expect(sameDeclaration({ ...string, dimension: 'k' }, string)).toBe(false);
  });

  it('equal declarations have the same checksum (pre-flight M-9)', () => {
    const checksum = (d: OutputDeclaration): string =>
      sha256Hex(canonicalize(normalizeOutputDeclaration(d)));
    const all: OutputDeclaration = { type: 'boolean', combine: 'all' };
    expect(checksum({ ...all, empty: false })).toBe(checksum(all));
    expect(checksum({ ...all, empty: true })).not.toBe(checksum(all));
  });

  it('refuses a declaration the validator refuses, either side', () => {
    const bad = loose<OutputDeclaration>({ type: 'boolean', combine: 'all', empty: 'no' });
    for (const call of [() => sameDeclaration(bad, SUM), () => sameDeclaration(SUM, bad)]) {
      expect(specError(call)).toMatchObject({
        code: 'INVALID_RULE',
        message: 'invalid output declaration: output.empty must be a boolean',
        path: 'output.empty',
      });
    }
  });

  it('the canonical entry exports the same functions', () => {
    expect(canonicalEntry.sameDeclaration).toBe(sameDeclaration);
    expect(canonicalEntry.normalizeOutputDeclaration).toBe(normalizeOutputDeclaration);
  });
});
