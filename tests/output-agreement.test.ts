import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  normalizeOutputDeclaration,
  sameDeclaration,
  validateOutputDeclaration,
  validateProof,
} from '../src/index.js';
import type { OutputDeclaration } from '../src/index.js';
import { proofWith, unsaltedSalt } from './proof-cases.js';
import { generator, jsonCopy, loose, specError, stringsOf } from './helpers.js';

const schema = JSON.parse(
  readFileSync(new URL('../schema/decision-proof.schema.json', import.meta.url), 'utf8'),
) as object;
const schemaAccepts = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const declarationSchema = JSON.parse(
  readFileSync(new URL('../schema/output-declaration.schema.json', import.meta.url), 'utf8'),
) as object;
const declarationSchemaAccepts = new Ajv2020({ strict: true, allErrors: true }).compile(
  declarationSchema,
);

/** A proof whose one output carries `declaration` (its value and the rest left to the checks). */
function proofOutput(declaration: Record<string, unknown>): unknown {
  const output = {
    name: 'value',
    status: 'undetermined',
    contributors: [],
    pending: [],
    salt: unsaltedSalt('outputs', 0),
  };
  // The other sections empty: each draw validates one output, quickly.
  const empty = { rules: [], items: [], applied: [], skipped: [], pending: [], exceptions: [] };
  return proofWith({ ...empty, outputs: [{ ...output, ...declaration }] });
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
  '99999999999999999999.5',
  '100000000000000000000',
  '0.25',
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
  const proofOf = (value: unknown, type = 'decimal'): unknown =>
    proofOutput({ type, combine: 'sum', rounding: value });

  it('on 3 000 drawn roundings, both outcomes reached', () => {
    const pick = generator(9);
    let accepted = 0;
    for (let i = 0; i < 3_000; i++) {
      const value = rounding(pick);
      const type = pick(['decimal', 'number']);
      const declaration = { type, combine: 'sum', rounding: value };
      // A proof takes a valid rounding in its normal form only.
      const declared =
        validateOutputDeclaration(declaration).length === 0 &&
        canonicalize(normalizeOutputDeclaration(loose<OutputDeclaration>(declaration)).rounding) ===
          canonicalize(value);
      const proved = validateProof(proofOf(value, type)).issues.length === 0;
      expect([value, type, proved, schemaAccepts(proofOf(value, type))]).toEqual([
        value,
        type,
        declared,
        declared,
      ]);
      if (declared) accepted += 1;
    }
    expect(accepted).toBeGreaterThan(100);
    expect(accepted).toBeLessThan(2_900);
  });

  it('a proof refuses a rounding not in its normal form, naming the normal writing', () => {
    const value = { increment: '0.01', mode: 'up', at: 'output' };
    expect(validateProof(proofOf(value)).issues).toEqual([
      {
        path: 'outputs[0].rounding.at',
        message: 'outputs[0].rounding.at must be absent: output is the default',
      },
      {
        path: 'outputs[0].rounding.increment',
        message: 'outputs[0].rounding.increment "0.01" must be written as scale 2',
      },
    ]);
    expect(schemaAccepts(proofOf(value))).toBe(false);
    const normal = { scale: 2, mode: 'up' };
    expect(validateProof(proofOf(normal)).issues).toEqual([]);
    expect(schemaAccepts(proofOf(normal))).toBe(true);
  });

  it('a proof refuses a combination its declaration could not have, and a rounded count', () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [
        { type: 'string', combine: 'sum' },
        'outputs[0].combine',
        'outputs[0].combine "sum" cannot combine a string output: it applies to number, decimal',
      ],
      [
        { type: 'number', combine: 'count', rounding: { scale: 0, mode: 'up' } },
        'outputs[0].rounding',
        'outputs[0].rounding does not apply to a count: its value is an integer',
      ],
    ];
    for (const [output, path, message] of cases) {
      const proof = proofOutput(output);
      expect(validateProof(proof).issues).toEqual([{ path, message }]);
      expect(schemaAccepts(proof)).toBe(false);
    }
  });
});

describe('the new types and strategy in a proof', () => {
  it.each([
    { type: 'date', combine: 'max' },
    { type: 'dateTime', combine: 'min' },
    { type: 'number', combine: 'count' },
    { type: 'decimal', combine: 'sum', rounding: { increment: '0.05', mode: 'halfUp' } },
  ])('accepts %j: the validator and the schema', (declaration) => {
    const proof = proofOutput(declaration);
    expect(validateProof(proof).issues).toEqual([]);
    expect(schemaAccepts(proof)).toBe(true);
  });

  it.each(['date', 'dateTime'])('a rounding on a %s output is refused by both', (type) => {
    const proof = proofOutput({ type, combine: 'max', rounding: { scale: 0, mode: 'up' } });
    expect(validateProof(proof).issues).toEqual([
      {
        path: 'outputs[0].rounding',
        message: 'outputs[0].rounding applies only to a number or decimal output',
      },
    ]);
    expect(schemaAccepts(proof)).toBe(false);
  });
});

const VALUES: Record<string, unknown[]> = {
  type: ['number', 'decimal', 'boolean', 'string', 'enum', 'list', 'date', 'dateTime', 'x'],
  combine: ['sum', 'max', 'min', 'count', 'all', 'any', 'union', 'highestPriority', 'avg'],
  values: [
    undefined,
    undefined,
    ['low', 'high'],
    ['a', 'a'],
    [],
    'low',
    ['iso:TG', 'b'],
    [':x'],
    ['y:'],
    [':'],
    ['a:b:'],
    ['a::', 'b'],
    ['a:b:c'],
    [':a', 'b:'],
  ],
  rounding: [
    undefined,
    undefined,
    { scale: 2, mode: 'up' },
    { increment: '0.1', mode: 'up' },
    { increment: '0.05', mode: 'up' },
    { increment: '1000', mode: 'up' },
    { increment: '100000000000000000000', mode: 'up' },
  ],
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
  { type: 'enum', combine: 'max', values: ['iso:TG', 'b'], dimension: 'country' },
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

describe('validateOutputDeclaration, normalizeOutputDeclaration and the JSON schema agree', () => {
  it('on 20 000 drawn declarations: same verdict, same first problem, a stable normal form', () => {
    const pick = generator(42);
    let accepted = 0;
    for (let i = 0; i < 20_000; i++) {
      const value = declaration(pick);
      const issues = validateOutputDeclaration(value);
      // The schema reads the JSON text: an `undefined` member has none, as it is absent.
      expect([value, declarationSchemaAccepts(jsonCopy(value))]).toEqual([
        value,
        issues.length === 0,
      ]);
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

describe('a declaration in a proof: the proof validator, schema and normal form agree', () => {
  it('on 10 000 drawn declarations: a proof takes the valid ones in normal form', () => {
    const pick = generator(7);
    let accepted = 0;
    for (let i = 0; i < 10_000; i++) {
      const value = declaration(pick);
      const valid = validateOutputDeclaration(value).length === 0;
      // The JSON text of the declaration: an `undefined` member has none, as it is absent.
      const written = jsonCopy(value);
      const normal =
        valid &&
        canonicalize(normalizeOutputDeclaration(loose<OutputDeclaration>(value))) ===
          canonicalize(written);
      const proof = proofOutput(written);
      expect([value, validateProof(proof).issues.length === 0, schemaAccepts(proof)]).toEqual([
        value,
        normal,
        normal,
      ]);
      if (normal) accepted += 1;
    }
    // Both verdicts reached, seeded: the same draws on every run.
    expect(accepted).toBe(2_024);
  }, 60_000);
});

describe('the output declaration schema: what only the validator checks', () => {
  const LONE = String.fromCharCode(0xd800);
  const cases: [string, Record<string, unknown>][] = [
    ['a lone surrogate in unit', { type: 'number', combine: 'sum', unit: `X${LONE}` }],
    [
      'a lone surrogate in an enum value',
      { type: 'enum', combine: 'max', values: ['a', `b${LONE}`] },
    ],
    [
      'a lone surrogate in dimension',
      { type: 'string', combine: 'highestPriority', dimension: `d${LONE}` },
    ],
  ];

  it.each(cases)('%s: accepted by the schema, refused by the validator', (_name, value) => {
    expect(declarationSchemaAccepts(value)).toBe(true);
    expect(validateOutputDeclaration(value)).not.toEqual([]);
  });

  it('the schema documents them', () => {
    expect(JSON.stringify(declarationSchema)).toMatch(
      /made only by validateOutputDeclaration: no text .* may hold a lone UTF-16 surrogate/,
    );
  });

  it('agrees on the cases of the other tests: units, signs, per and dimension', () => {
    const cases: Record<string, unknown>[] = [
      { type: 'decimal', combine: 'sum', unit: ' XOF' },
      { type: 'decimal', combine: 'sum', unit: 'XOF\n' },
      { type: 'decimal', combine: 'sum', unit: 'X O F' },
      { type: 'enum', combine: 'max', values: ['a'], dimension: '-' },
      { type: 'enum', combine: 'max', values: ['a'], dimension: '$d' },
      { type: 'enum', combine: 'max', values: ['a'], dimension: '-d' },
      { type: 'enum', combine: 'max', values: ['a', 'a'] },
      { type: 'number', combine: 'sum', per: '/a/*/b' },
      { type: 'number', combine: 'sum', per: '/a/@x' },
      { type: 'number', combine: 'sum', per: '/a/0/b' },
      { type: 'number', combine: 'count', unit: 'persons' },
      { type: 'boolean', combine: 'all', empty: false },
      {
        type: 'decimal',
        combine: 'sum',
        rounding: { increment: '0.01', mode: 'up', at: 'output' },
      },
    ];
    for (const value of cases) {
      expect([value, declarationSchemaAccepts(value)]).toEqual([
        value,
        validateOutputDeclaration(value).length === 0,
      ]);
    }
  });
});

describe('each text pattern of the declaration schema matches its validator exactly', () => {
  /** Asserts the schema and the validator agree on `declare(text)` for every `text`. */
  function agree(texts: readonly string[], declare: (text: string) => object): void {
    for (const text of texts) {
      const value = declare(text);
      expect([text, declarationSchemaAccepts(value)]).toEqual([
        text,
        validateOutputDeclaration(value).length === 0,
      ]);
    }
  }

  it.each(['a:b:', 'a::', ':', 'a:', ':a', 'a:b:c', ''])(
    'an enum value of a dimension: %j',
    (text) => {
      agree([text], (v) => ({ type: 'enum', combine: 'max', values: [v], dimension: 'd' }));
    },
  );

  it('an enum value of a dimension: every string of up to 6 of a, :, space', () => {
    const texts = stringsOf(['a', ':', ' '], 6);
    agree(texts, (v) => ({ type: 'enum', combine: 'max', values: [v], dimension: 'd' }));
    agree(texts, (v) => ({ type: 'enum', combine: 'max', values: [v] }));
  });

  it('a unit: every string of up to 4 of a, white spaces and look-alikes', () => {
    const texts = stringsOf(['a', ' ', '\n', '\u00a0', '\u2028', '\ufeff', '\u0085', '\u200b'], 4);
    agree(texts, (v) => ({ type: 'decimal', combine: 'sum', unit: v }));
  });

  it('a dimension name: every string of up to 4 of a, $, -, space', () => {
    const texts = stringsOf(['a', '$', '-', ' '], 4);
    agree(texts, (v) => ({ type: 'string', combine: 'highestPriority', dimension: v }));
  });

  it('per: every string of up to 5 of /, a, *, -, @, ~, 0, $', () => {
    const texts = stringsOf(['/', 'a', '*', '-', '@', '~', '0', '$'], 5);
    agree(texts, (v) => ({ type: 'number', combine: 'sum', per: v }));
  });

  it('an increment, on a decimal and on a number: every string of up to 5 of 0, 1, 5, ., -', () => {
    const texts = [
      ...stringsOf(['0', '1', '5', '.', '-'], 5),
      `0.${'0'.repeat(19)}1`,
      `0.${'0'.repeat(20)}1`,
      `1${'0'.repeat(19)}`,
      `1${'0'.repeat(20)}`,
      `${'9'.repeat(20)}.${'9'.repeat(20)}`,
      `${'9'.repeat(20)}.${'9'.repeat(21)}`,
    ];
    for (const type of ['decimal', 'number']) {
      agree(texts, (v) => ({ type, combine: 'sum', rounding: { increment: v, mode: 'up' } }));
      // The proof schema and validateProof agree on the same texts, in the normal form.
      for (const text of texts) {
        const proof = proofOutput({
          type,
          combine: 'max',
          rounding: { increment: text, mode: 'up' },
        });
        expect([type, text, schemaAccepts(proof)]).toEqual([
          type,
          text,
          validateProof(proof).issues.length === 0,
        ]);
      }
    }
  });
});
