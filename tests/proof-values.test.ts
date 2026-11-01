import { describe, expect, it } from 'vitest';
import { sealProof, validateProof, verifyProof } from '../src/index.js';
import type { JsonValue } from '../src/index.js';
import type { ProofView } from '../src/proof/types.js';
import { isOnStep, numberToDecimal } from '../src/decision/decimal.js';
import { specError, withCounts } from './helpers.js';
import { outputProof } from './proof-builders.js';
import type { OutputPart } from './proof-builders.js';
import { unsalted } from './proof-cases.js';
import { handSealed } from './helpers.js';

/** A proof of one output `value`, fed by `r0` with `contribution` (and `unrounded`). */
const proofOf = (output: OutputPart, contribution?: JsonValue, unrounded?: JsonValue) =>
  outputProof(output, contribution === undefined ? [] : [contribution], unrounded);

const VALUE_OFF = 'output value does not match its declaration: value';
const NOT_ROUNDED = 'output value not rounded as declared: value';
const CONTRIBUTION_OFF = 'contribution does not match its output declaration: value';
const CONTRIBUTION_NOT_ROUNDED = 'contribution not rounded as declared: value';
/** The checks of values against their declaration: those this file tests. */
const FORM_ISSUES = new Set([VALUE_OFF, NOT_ROUNDED, CONTRIBUTION_OFF, CONTRIBUTION_NOT_ROUNDED]);

/**
 * What `verifyProof` finds in `p` (sealed by hand when `sealProof` refuses it) about its values
 * against their declaration; whether a value follows from its contributions is tested in
 * tests/proof-combine.test.ts.
 */
function issuesOf(p: ProofView): string[] {
  expect(validateProof({ ...withCounts(p), digest: 'c'.repeat(64) }).issues).toEqual([]);
  return verifyProof(handSealed(p)).issues.filter((issue) => FORM_ISSUES.has(issue));
}

describe('verifyProof: each output value has the form its declaration gives', () => {
  const cases: [string, ProofView, string[]][] = [
    ['a date', proofOf({ type: 'date', combine: 'max', value: '2028-02-29' }, '2028-02-29'), []],
    [
      'an impossible date',
      proofOf({ type: 'date', combine: 'max', value: '2026-02-29' }, '2026-02-29'),
      [VALUE_OFF, CONTRIBUTION_OFF],
    ],
    [
      'an instant not canonical',
      proofOf({ type: 'dateTime', combine: 'min', value: '2026-01-01T00:00:00Z' }),
      [VALUE_OFF],
    ],
    ['a count', proofOf({ type: 'number', combine: 'count', value: 1 }, true), []],
    [
      'a count that is not an integer, fed by a number',
      proofOf({ type: 'number', combine: 'count', value: 1.5 }, 1),
      [VALUE_OFF, CONTRIBUTION_OFF],
    ],
    ['a negative count', proofOf({ type: 'number', combine: 'count', value: -1 }), [VALUE_OFF]],
    [
      'an enum value',
      proofOf({ type: 'enum', combine: 'max', values: ['high'], value: 'high' }, 'high'),
      [],
    ],
    [
      'an enum that is no string',
      proofOf({ type: 'enum', combine: 'max', values: ['high'], value: 2 }),
      [VALUE_OFF],
    ],
    [
      'a number given as text',
      proofOf({ type: 'number', combine: 'sum', value: '1' }),
      [VALUE_OFF],
    ],
    ['a list', proofOf({ type: 'list', combine: 'union', value: {} }), [VALUE_OFF]],
    ['an object', proofOf({ type: 'object', combine: 'highestPriority', value: [] }), [VALUE_OFF]],
    ['a boolean', proofOf({ type: 'boolean', combine: 'any', value: 0 }), [VALUE_OFF]],
    ['no value for a max no rule reached', proofOf({ type: 'number', combine: 'max' }), []],
    ['no value for an all no rule reached', proofOf({ type: 'boolean', combine: 'all' }), []],
    [
      'null for a max no rule reached: null is a value, not none',
      proofOf({ type: 'number', combine: 'max', value: null }),
      [VALUE_OFF],
    ],
    [
      'null for a sum: its empty value is 0',
      proofOf({ type: 'number', combine: 'sum', value: null }),
      [VALUE_OFF],
    ],
    [
      'null for a max a rule reached',
      proofOf({ type: 'number', combine: 'max', value: null }, 1),
      [VALUE_OFF],
    ],
    [
      'a value outside the enum values',
      proofOf({ type: 'enum', combine: 'max', values: ['low', 'high'], value: 'mid' }, 'mid'),
      [VALUE_OFF, CONTRIBUTION_OFF],
    ],
    [
      'a sum of the wrong sign',
      proofOf({ type: 'number', combine: 'sum', sign: 'nonPositive', value: 1 }, 1),
      [VALUE_OFF, CONTRIBUTION_OFF],
    ],
    [
      'a string that is no value of its dimension',
      proofOf({ type: 'string', combine: 'highestPriority', dimension: 'pays', value: 'FR:' }),
      [VALUE_OFF],
    ],
    [
      'a bound of the wrong type',
      proofOf({ type: 'date', combine: 'max', bounds: { max: 3 } }),
      [VALUE_OFF],
    ],
    [
      'an unrounded value of another type',
      proofOf({ type: 'number', combine: 'sum', value: 1 }, 1, '1'),
      [CONTRIBUTION_OFF],
    ],
  ];

  it.each(cases)('%s', (_name, proof, expected) => {
    expect(issuesOf(proof)).toEqual(expected);
  });

  it('sealProof refuses what verifyProof finds', () => {
    const proof = proofOf({ type: 'date', combine: 'max', value: 'tomorrow' });
    expect(specError(() => sealProof(unsalted(proof)))).toMatchObject({
      code: 'INVALID_PROOF',
      message: `Cannot seal the proof: ${VALUE_OFF}`,
    });
  });
});

describe('verifyProof: rounded values are on the step of their rounding', () => {
  const scale2 = { scale: 2, mode: 'halfUp' as const };
  const cash = { increment: '0.05', mode: 'halfUp' as const };
  const cases: [string, ProofView, string[]][] = [
    [
      'a decimal on scale 2',
      proofOf({ type: 'decimal', combine: 'sum', value: '1.25', rounding: scale2 }),
      [],
    ],
    [
      'a decimal off scale 2',
      proofOf({ type: 'decimal', combine: 'sum', value: '1.255', rounding: scale2 }),
      [NOT_ROUNDED],
    ],
    [
      'a number on scale 2',
      proofOf({ type: 'number', combine: 'sum', value: 0.3, rounding: scale2 }),
      [],
    ],
    [
      'a binary sum off scale 2',
      proofOf({ type: 'number', combine: 'sum', value: 0.1 + 0.2, rounding: scale2 }),
      [NOT_ROUNDED],
    ],
    [
      'a multiple of 0.05',
      proofOf({ type: 'decimal', combine: 'sum', value: '-10.05', rounding: cash }),
      [],
    ],
    [
      'not a multiple of 0.05',
      proofOf({ type: 'decimal', combine: 'sum', value: '10.03', rounding: cash }),
      [NOT_ROUNDED],
    ],
    [
      'a multiple of 1000 of 22 digits',
      proofOf({
        type: 'decimal',
        combine: 'max',
        value: '2000000000000000000000',
        rounding: { increment: '1000', mode: 'down' },
      }),
      [],
    ],
    [
      'contributions rounded at contribution, on the step',
      proofOf(
        {
          type: 'decimal',
          combine: 'sum',
          value: '0.1',
          rounding: { ...cash, at: 'contribution' },
        },
        '0.1',
        '0.12',
      ),
      [],
    ],
    [
      'a contribution off the step',
      proofOf(
        {
          type: 'decimal',
          combine: 'sum',
          value: '0.1',
          rounding: { ...cash, at: 'contribution' },
        },
        '0.12',
      ),
      [CONTRIBUTION_NOT_ROUNDED],
    ],
    [
      'a number rounded at contribution: its binary sum is not checked, its contributions are',
      proofOf(
        {
          type: 'number',
          combine: 'sum',
          value: 0.1 + 0.2,
          rounding: { ...scale2, at: 'contribution' },
        },
        0.1,
      ),
      [],
    ],
  ];

  it.each(cases)('%s', (_name, proof, expected) => {
    expect(issuesOf(proof)).toEqual(expected);
  });
});

describe('the decimal helpers', () => {
  it('numberToDecimal writes the shortest decimal without exponent', () => {
    const cases: [number, string][] = [
      [0, '0'],
      [-0, '0'],
      [0.3, '0.3'],
      [1e-7, '0.0000001'],
      [-1.5e-7, '-0.00000015'],
      [1e21, '1000000000000000000000'],
      [1.25e22, '12500000000000000000000'],
      [123.456, '123.456'],
    ];
    expect(cases.map(([n]) => numberToDecimal(n))).toEqual(cases.map(([, text]) => text));
  });

  it('isOnStep is exact for any length, and linear', () => {
    const long = `${'9'.repeat(100_000)}5`;
    expect(isOnStep(long, { increment: '5' })).toBe(true);
    expect(isOnStep(long, { increment: '10' })).toBe(false);
    expect(isOnStep(`${long}.5`, { increment: '0.5' })).toBe(true);
    expect(isOnStep('12', { increment: '100000000000000000000000000000' })).toBe(false);
    expect(
      isOnStep('300000000000000000000000000000', { increment: '100000000000000000000000000000' }),
    ).toBe(true);
    expect(isOnStep('1.5', { scale: 0 })).toBe(false);
    expect(isOnStep('1.5', { scale: 1 })).toBe(true);
  });
});
