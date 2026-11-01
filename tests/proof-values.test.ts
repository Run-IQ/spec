import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  PROOF_FORMAT,
  sealProof,
  sha256Hex,
  validateProof,
  verifyProof,
} from '../src/index.js';
import type { JsonValue, ProofOutput, ProofStep, UnsignedProof } from '../src/index.js';
import { isOnStep, numberToDecimal } from '../src/decision/decimal.js';
import { specError } from './helpers.js';

/** A proof of one output `value`, fed by `r1` with `contribution` (and `unrounded`). */
function proofOf(
  output: Omit<ProofOutput, 'contributors'> & { contributors?: string[] },
  contribution?: JsonValue,
  unrounded?: JsonValue,
): UnsignedProof {
  const step: ProofStep = {
    ruleId: 'r1',
    version: 1,
    model: 'M',
    output: 'value',
    contribution: contribution ?? null,
    stratum: 0,
  };
  if (unrounded !== undefined) step.unrounded = unrounded;
  return {
    format: PROOF_FORMAT,
    requestId: 'req-1',
    evaluatedAt: null,
    sealedAt: '2026-01-01T00:00:00.000Z',
    inputDigest: 'a'.repeat(64),
    rules: [{ id: 'r1', version: 1, checksum: 'b'.repeat(64) }],
    versions: { engine: '1', plugins: {}, dsls: {} },
    strata: [['value']],
    outputs: { value: { contributors: contribution === undefined ? [] : ['r1'], ...output } },
    applied: contribution === undefined ? [] : [step],
    skipped: [],
    exceptions: [],
  };
}

/** What `verifyProof` finds in `p`, sealed by hand when `sealProof` refuses it. */
function issuesOf(p: UnsignedProof): string[] {
  expect(validateProof({ ...p, digest: 'c'.repeat(64) }).issues).toEqual([]);
  return verifyProof({ ...p, digest: sha256Hex(canonicalize(p)) }).issues.filter(
    (issue) => issue !== 'unsigned' && issue !== 'digest mismatch',
  );
}

const VALUE_OFF = 'output value does not match its declaration: value';
const NOT_ROUNDED = 'output value not rounded as declared: value';
const CONTRIBUTION_OFF = 'contribution does not match its output declaration: value';
const CONTRIBUTION_NOT_ROUNDED = 'contribution not rounded as declared: value';

describe('verifyProof: each output value has the form its declaration gives', () => {
  const cases: [string, UnsignedProof, string[]][] = [
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
    ['an enum value', proofOf({ type: 'enum', combine: 'max', value: 'high' }, 'high'), []],
    ['an enum that is no string', proofOf({ type: 'enum', combine: 'max', value: 2 }), [VALUE_OFF]],
    [
      'a number given as text',
      proofOf({ type: 'number', combine: 'sum', value: '1' }),
      [VALUE_OFF],
    ],
    ['a list', proofOf({ type: 'list', combine: 'union', value: {} }), [VALUE_OFF]],
    ['an object', proofOf({ type: 'object', combine: 'highestPriority', value: [] }), [VALUE_OFF]],
    ['a boolean', proofOf({ type: 'boolean', combine: 'any', value: 0 }), [VALUE_OFF]],
    [
      'no value (null) for a max no rule reached',
      proofOf({ type: 'number', combine: 'max', value: null }),
      [],
    ],
    [
      'no value (null) for an all no rule reached',
      proofOf({ type: 'boolean', combine: 'all', value: null }),
      [],
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
    expect(specError(() => sealProof(proof))).toMatchObject({
      code: 'INVALID_PROOF',
      message: `Cannot seal the proof: ${VALUE_OFF}`,
    });
  });
});

describe('verifyProof: rounded values are on the step of their rounding', () => {
  const scale2 = { scale: 2, mode: 'halfUp' as const };
  const cash = { increment: '0.05', mode: 'halfUp' as const };
  const cases: [string, UnsignedProof, string[]][] = [
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
