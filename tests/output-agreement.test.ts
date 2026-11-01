import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  normalizeOutputDeclaration,
  sameDeclaration,
  validateOutputDeclaration,
  validateProof,
} from '../src/index.js';
import type { OutputDeclaration } from '../src/index.js';
import { proofWith } from './proof-cases.js';
import { loose, specError } from './helpers.js';

const schema = JSON.parse(
  readFileSync(new URL('../schema/decision-proof.schema.json', import.meta.url), 'utf8'),
) as object;
const schemaAccepts = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** A deterministic generator (mulberry32): the same cases on every run. */
function generator(seed: number): <T>(choices: readonly T[]) => T {
  let state = seed;
  return <T>(choices: readonly T[]): T => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    const index = Math.floor(unit * choices.length);
    if (index >= choices.length) throw new Error('no choices');
    // An index below the length: the choice itself, `undefined` included.
    return choices[index] as T;
  };
}

const INCREMENTS: unknown[] = [
  undefined,
  '0.05',
  '0.01',
  '1',
  '10',
  '0',
  '-1',
  '0.050',
  '05',
  '1e2',
  '',
  '.5',
  '0.00000000000000000001',
  '0.000000000000000000001',
  '12345678901234567890123',
  0.05,
];
const SCALES: unknown[] = [undefined, 0, 2, 20, 21, -1, 1.5, '2'];
const MODES: unknown[] = [undefined, 'halfUp', 'floor', 'halfEven', 'bankers'];
const TARGETS: unknown[] = [undefined, 'output', 'contribution', 'line'];

/**
 * A rounding drawn from the lists above: mostly one of `scale` and `increment` (both, or
 * neither, now and then); `undefined` members are left out.
 */
function rounding(pick: <T>(choices: readonly T[]) => T): Record<string, unknown> {
  const step = pick(['scale', 'increment', 'scale', 'increment', 'both', 'neither']);
  const drawn: Record<string, unknown> = {
    scale: step === 'scale' || step === 'both' ? pick(SCALES) : undefined,
    increment: step === 'increment' || step === 'both' ? pick(INCREMENTS) : undefined,
    mode: pick(MODES),
    at: pick(TARGETS),
  };
  return Object.fromEntries(Object.entries(drawn).filter(([, value]) => value !== undefined));
}

describe('a rounding: the declaration validator, the proof validator and the schema agree', () => {
  const proofOf = (value: unknown): unknown =>
    proofWith({
      outputs: {
        value: { type: 'decimal', combine: 'sum', value: '1', contributors: [], rounding: value },
      },
    });

  it('on 3 000 drawn roundings, both outcomes reached', () => {
    const pick = generator(9);
    let accepted = 0;
    for (let i = 0; i < 3_000; i++) {
      const value = rounding(pick);
      const declared =
        validateOutputDeclaration({ type: 'decimal', combine: 'sum', rounding: value }).length ===
        0;
      const proved = validateProof(proofOf(value)).issues.length === 0;
      expect([value, proved, schemaAccepts(proofOf(value))]).toEqual([value, declared, declared]);
      if (declared) accepted += 1;
    }
    expect(accepted).toBeGreaterThan(100);
    expect(accepted).toBeLessThan(2_900);
  });

  it('a proof keeps its rounding as written: an increment of 0.01 stays one', () => {
    const value = { increment: '0.01', mode: 'up', at: 'output' };
    expect(validateProof(proofOf(value)).issues).toEqual([]);
    expect(schemaAccepts(proofOf(value))).toBe(true);
  });
});

describe('the new types and strategy in a proof', () => {
  const outputs = {
    due: { type: 'date', combine: 'max', value: '2026-01-31', contributors: ['r1'] },
    at: { type: 'dateTime', combine: 'min', value: '2026-01-01T00:00:00.000Z', contributors: [] },
    criteria: { type: 'number', combine: 'count', value: 2, contributors: ['r1'] },
    cash: {
      type: 'decimal',
      combine: 'sum',
      value: '10.05',
      contributors: [],
      rounding: { increment: '0.05', mode: 'halfUp' },
    },
  };

  it('are accepted by the validator and the schema', () => {
    const proof = proofWith({ outputs, strata: [['at', 'cash', 'criteria', 'due', 'value']] });
    expect(validateProof(proof).issues).toEqual([]);
    expect(schemaAccepts(proof)).toBe(true);
  });

  it.each(['date', 'dateTime'])('a rounding on a %s output is refused by both', (type) => {
    const proof = proofWith({
      outputs: {
        value: { type, combine: 'max', value: null, contributors: [], rounding: { scale: 0 } },
      },
    });
    expect(validateProof(proof).issues).toEqual([
      {
        path: 'outputs.value.rounding',
        message: 'outputs.value.rounding applies only to a number or decimal output',
      },
    ]);
    expect(schemaAccepts(proof)).toBe(false);
  });
});

const VALUES: Record<string, unknown[]> = {
  type: ['number', 'decimal', 'boolean', 'string', 'enum', 'list', 'date', 'dateTime', 'x'],
  combine: ['sum', 'max', 'min', 'count', 'all', 'any', 'union', 'highestPriority', 'avg'],
  values: [undefined, undefined, ['low', 'high'], ['a', 'a'], [], 'low'],
  rounding: [undefined, undefined, { scale: 2, mode: 'up' }, { increment: '0.1', mode: 'up' }],
  unit: [undefined, undefined, 'XOF', '', ' XOF', 1],
  empty: [undefined, undefined, true, false, 'yes'],
  per: [undefined, undefined, '/items', '/items/*/lines', '/$item', 'x'],
  dimension: [undefined, undefined, 'country', '$k', '', '-'],
  sign: [undefined, undefined, 'nonNegative', 'nonPositive', 'positive'],
  other: [undefined, undefined, undefined, 'x'],
};

/** Valid declarations the draws start from. */
const BASES: Record<string, unknown>[] = [
  { type: 'number', combine: 'sum' },
  { type: 'decimal', combine: 'sum' },
  { type: 'enum', combine: 'max', values: ['low', 'high'] },
  { type: 'boolean', combine: 'all' },
  { type: 'string', combine: 'highestPriority' },
  { type: 'number', combine: 'count' },
  { type: 'date', combine: 'min' },
  { type: 'list', combine: 'union' },
];

/**
 * A declaration drawn from a valid base, each member of `VALUES` replaced one time in four by a
 * draw (an `undefined` draw sets the member to `undefined`: absent).
 */
function declaration(pick: <T>(choices: readonly T[]) => T): Record<string, unknown> {
  const drawn: Record<string, unknown> = { ...pick(BASES) };
  for (const [key, choices] of Object.entries(VALUES)) {
    if (pick([true, false, false, false])) drawn[key] = pick(choices);
  }
  return drawn;
}

describe('validateOutputDeclaration and normalizeOutputDeclaration agree', () => {
  it('on 20 000 drawn declarations: same verdict, same first problem, a stable normal form', () => {
    const pick = generator(42);
    let accepted = 0;
    for (let i = 0; i < 20_000; i++) {
      const value = declaration(pick);
      const issues = validateOutputDeclaration(value);
      const first = issues[0];
      if (first === undefined) {
        accepted += 1;
        const normal = normalizeOutputDeclaration(loose<OutputDeclaration>(value));
        expect(validateOutputDeclaration(normal)).toEqual([]);
        expect(normalizeOutputDeclaration(normal)).toStrictEqual(normal);
        expect(sameDeclaration(loose<OutputDeclaration>(value), normal)).toBe(true);
      } else {
        const error = specError(() => normalizeOutputDeclaration(loose<OutputDeclaration>(value)));
        expect([value, error.code, error.message, error.path]).toEqual([
          value,
          'INVALID_RULE',
          `invalid output declaration: ${first.message}`,
          first.path,
        ]);
      }
    }
    expect(accepted).toBeGreaterThan(2_000);
    expect(accepted).toBeLessThan(18_000);
  });
});
