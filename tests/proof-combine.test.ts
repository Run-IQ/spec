import { describe, expect, it } from 'vitest';
import { sealProof, validateProof, verifyProof } from '../src/index.js';
import type { JsonValue, UnsignedProof } from '../src/index.js';
import { specError } from './helpers.js';
import { unsaltedSalt } from './proof-cases.js';
import { unsalted } from './proof-cases.js';
import { treeDigestOf } from './helpers.js';

type Entry = Record<string, unknown>;

/** A declaration of output `value` and the contributions of its rules (in rule order). */
interface Case {
  output: Entry;
  /** One contribution per rule `r0`, `r1`…; an array gives `[contribution, unrounded]`. */
  contributions?: (JsonValue | [JsonValue, JsonValue])[];
  /** Rules whose contribution is imposed by their shortCircuit exception. */
  shortCircuit?: boolean;
}

/** A proof of one output `value`, fed in order by `r0`, `r1`… (local rules, one stratum). */
function proofOf({ output, contributions = [], shortCircuit = false }: Case): Entry {
  const ids = contributions.map((_, i) => `r${i}`);
  const sorted = [...ids].sort();
  const step = (id: string): Entry => {
    const given = contributions[ids.indexOf(id)];
    const [contribution, unrounded] =
      Array.isArray(given) && given.length === 2 && isPair(given)
        ? given
        : [given ?? null, undefined];
    const entry: Entry = {
      ruleId: id,
      version: 1,
      model: 'M',
      output: 'value',
      contribution,
      status: 'determined',
      stratum: 0,
    };
    if (unrounded !== undefined) entry.unrounded = unrounded;
    return entry;
  };
  const salted = (section: string, list: Entry[]): Entry[] =>
    list.map((entry, i) => ({ ...entry, salt: unsaltedSalt(section, i) }));
  return {
    format: 'run-iq.proof/1',
    requestId: 'req-1',
    evaluatedAt: null,
    sealedAt: '2026-01-01T00:00:00.000Z',
    inputDigest: 'a'.repeat(64),
    inputSalted: false,
    timeZone: 'UTC',
    ruleSets: [],
    versions: { engine: '1', plugins: {}, dsls: {}, models: { M: '1' }, components: [] },
    strata: [['value']],
    rules: salted(
      'rules',
      sorted.map((id) => ({
        id,
        version: 1,
        checksum: 'b'.repeat(64),
        ruleSet: 'local',
        priority: 0,
      })),
    ),
    outputs: salted('outputs', [
      { name: 'value', status: 'determined', contributors: ids, pending: [], ...output },
    ]),
    items: [],
    applied: salted('applied', sorted.map(step)),
    skipped: [],
    pending: [],
    exceptions: shortCircuit
      ? salted('exceptions', [
          {
            ruleId: 'r0',
            version: 1,
            kind: 'shortCircuit',
            output: 'value',
            affected: [],
            status: 'determined',
            stratum: 0,
          },
        ])
      : [],
    factsRead: [],
    missingFacts: [],
    readsUndeclared: [],
  };
}

/** A contribution given with its value before rounding. */
const PAIRS = new WeakSet<object>();
function rounded(contribution: JsonValue, unrounded: JsonValue): [JsonValue, JsonValue] {
  const pair: [JsonValue, JsonValue] = [contribution, unrounded];
  PAIRS.add(pair);
  return pair;
}
function isPair(value: unknown[]): value is [JsonValue, JsonValue] {
  return PAIRS.has(value);
}

/** What verifyProof finds in the proof of `c`; sealProof refuses with the first, or seals. */
function problems(c: Case): string[] {
  const content = proofOf(c);
  const proof = { ...content, digest: treeDigestOf(content) };
  expect(validateProof(proof).issues).toEqual([]);
  const found = verifyProof(proof).issues.filter((issue) => issue !== 'unsigned');
  const seal = (): unknown => sealProof(unsalted(content as unknown as UnsignedProof));
  const [first] = found;
  if (first === undefined) expect(seal).not.toThrow();
  else expect(specError(seal).message).toBe(`Cannot seal the proof: ${first}`);
  return found;
}

const NOT_FOLLOWING = 'output value does not follow from its contributions: value';
const VALUE_OFF = 'output value does not match its declaration: value';
const CONTRIBUTION_OFF = 'contribution does not match its output declaration: value';
const SELECTED_OFF = 'selected does not match the value: value';

describe('the review cases of 9I: a value that does not follow from its contributions', () => {
  it('a count of 5 with a single true contribution', () => {
    const output = { type: 'number', combine: 'count', value: 5 };
    expect(problems({ output, contributions: [true] })).toEqual([NOT_FOLLOWING]);
    expect(problems({ output: { ...output, value: 1 }, contributions: [true, false] })).toEqual([]);
  });

  it('a max of 99 with contributions 1 and 2', () => {
    const output = { type: 'number', combine: 'max', value: 99, selected: { ruleId: 'r1' } };
    expect(problems({ output, contributions: [1, 2] })).toEqual([NOT_FOLLOWING]);
    expect(problems({ output: { ...output, value: 2 }, contributions: [1, 2] })).toEqual([]);
  });
});

describe('each strategy, its value computed from its contributions', () => {
  const ok: [string, Case][] = [
    [
      'a number sum',
      { output: { type: 'number', combine: 'sum', value: 6 }, contributions: [1, 2, 3] },
    ],
    [
      'a number sum in Decimal to 20 significant digits: 0.1 + 0.2 is 0.3',
      { output: { type: 'number', combine: 'sum', value: 0.3 }, contributions: [0.1, 0.2] },
    ],
    [
      'a number sum in order: 1e16 + 1 - 1e16 is 1 (G-12)',
      { output: { type: 'number', combine: 'sum', value: 1 }, contributions: [1e16, 1, -1e16] },
    ],
    [
      'a number sum rounded at output',
      {
        output: {
          type: 'number',
          combine: 'sum',
          value: 0.33,
          rounding: { scale: 2, mode: 'halfUp' },
        },
        contributions: [0.111, 0.222],
      },
    ],
    [
      'an exact decimal sum',
      {
        output: { type: 'decimal', combine: 'sum', value: '100000000000000000000.3' },
        contributions: ['100000000000000000000.1', '0.2'],
      },
    ],
    [
      'a decimal sum rounded to an increment',
      {
        output: {
          type: 'decimal',
          combine: 'sum',
          value: '1.05',
          rounding: { increment: '0.05', mode: 'halfUp' },
        },
        contributions: ['1.025'],
      },
    ],
    [
      'a decimal floored to 10, negative',
      {
        output: {
          type: 'decimal',
          combine: 'sum',
          value: '-1240',
          rounding: { increment: '10', mode: 'floor' },
        },
        contributions: ['-1234'],
      },
    ],
    [
      'a sum rounded at each contribution',
      {
        output: {
          type: 'decimal',
          combine: 'sum',
          value: '2.02',
          rounding: { scale: 2, mode: 'halfEven', at: 'contribution' },
        },
        contributions: [rounded('1.01', '1.0149'), rounded('1.01', '1.0051')],
      },
    ],
    [
      'a min of dates',
      {
        output: { type: 'date', combine: 'min', value: '2026-02-28', selected: { ruleId: 'r1' } },
        contributions: ['2026-03-31', '2026-02-28'],
      },
    ],
    [
      'a max of an enum, by rank',
      {
        output: {
          type: 'enum',
          combine: 'max',
          values: ['minimal', 'limited', 'high', 'prohibited'],
          value: 'high',
          selected: { ruleId: 'r0' },
        },
        contributions: ['high', 'limited'],
      },
    ],
    [
      'a max rounded at output',
      {
        output: {
          type: 'decimal',
          combine: 'max',
          value: '2',
          rounding: { scale: 0, mode: 'up' },
          selected: { ruleId: 'r1' },
        },
        contributions: ['1', '1.5'],
      },
    ],
    [
      'all and any',
      { output: { type: 'boolean', combine: 'all', value: false }, contributions: [true, false] },
    ],
    [
      'any',
      { output: { type: 'boolean', combine: 'any', value: true }, contributions: [false, true] },
    ],
    [
      'a union keeps the first of equal items, canonically (X-15)',
      {
        output: { type: 'list', combine: 'union', value: [{ a: 1, b: 2 }, 3] },
        contributions: [[{ a: 1, b: 2 }], [{ b: 2, a: 1 }, 3]],
      },
    ],
    [
      'a highestPriority: its contributors agree with the selection',
      {
        output: {
          type: 'object',
          combine: 'highestPriority',
          value: { x: 1 },
          selected: { ruleId: 'r0' },
        },
        contributions: [{ x: 1 }, { x: 1 }],
      },
    ],
    [
      'a short-circuit imposes its value, even a list with repeated items',
      {
        output: { type: 'list', combine: 'union', value: [1, 1] },
        contributions: [[1, 1]],
        shortCircuit: true,
      },
    ],
    [
      'a short-circuit imposes a count',
      {
        output: { type: 'number', combine: 'count', value: 3 },
        contributions: [3],
        shortCircuit: true,
      },
    ],
    ['an empty sum is 0', { output: { type: 'number', combine: 'sum', value: 0 } }],
    ['an empty decimal sum is "0"', { output: { type: 'decimal', combine: 'sum', value: '0' } }],
    ['an empty union is []', { output: { type: 'list', combine: 'union', value: [] } }],
    ['an empty any is false', { output: { type: 'boolean', combine: 'any', value: false } }],
    ['an empty count is 0', { output: { type: 'number', combine: 'count', value: 0 } }],
    [
      'an empty all with empty: true is true',
      { output: { type: 'boolean', combine: 'all', value: true, empty: true } },
    ],
    [
      'an empty all without empty is undetermined, without value',
      { output: { type: 'boolean', combine: 'all', status: 'undetermined' } },
    ],
  ];

  it.each(ok)('%s', (_label, c) => {
    expect(problems(c)).toEqual([]);
  });

  const off: [string, Case][] = [
    [
      'a number sum',
      { output: { type: 'number', combine: 'sum', value: 7 }, contributions: [1, 2, 3] },
    ],
    [
      'a number sum computed in binary (0.30000000000000004)',
      {
        output: { type: 'number', combine: 'sum', value: 0.30000000000000004 },
        contributions: [0.1, 0.2],
      },
    ],
    [
      'a number sum in another order: 1 + 1e16 - 1e16 is 0',
      { output: { type: 'number', combine: 'sum', value: 0 }, contributions: [1e16, 1, -1e16] },
    ],
    [
      'a decimal sum',
      { output: { type: 'decimal', combine: 'sum', value: '0.4' }, contributions: ['0.1', '0.2'] },
    ],
    [
      'a sum not rounded at output',
      {
        output: {
          type: 'decimal',
          combine: 'sum',
          value: '1.04',
          rounding: { scale: 2, mode: 'down' },
        },
        contributions: ['1.025', '0.01'],
      },
    ],
    [
      'an all',
      { output: { type: 'boolean', combine: 'all', value: true }, contributions: [true, false] },
    ],
    [
      'an any',
      { output: { type: 'boolean', combine: 'any', value: false }, contributions: [true] },
    ],
    [
      'a union in another order',
      { output: { type: 'list', combine: 'union', value: [2, 1] }, contributions: [[1], [2]] },
    ],
    [
      'a union that keeps a repeated item',
      { output: { type: 'list', combine: 'union', value: [1, 1] }, contributions: [[1], [1]] },
    ],
    [
      'a min of dates',
      {
        output: { type: 'date', combine: 'min', value: '2026-03-31', selected: { ruleId: 'r1' } },
        contributions: ['2026-03-31', '2026-02-28'],
      },
    ],
    ['an empty sum that is not 0', { output: { type: 'number', combine: 'sum', value: 1 } }],
    ['an empty union that is not []', { output: { type: 'list', combine: 'union', value: [1] } }],
    [
      'an empty all with empty: true that is false',
      { output: { type: 'boolean', combine: 'all', value: false, empty: true } },
    ],
  ];

  it.each(off)('refuses %s', (_label, c) => {
    expect(problems(c)).toEqual([NOT_FOLLOWING]);
  });

  it('refuses a value on an empty max: no rule reached it', () => {
    const output = { type: 'number', combine: 'max', value: 1, selected: { ruleId: 'r0' } };
    expect(problems({ output })).toEqual([
      'cited rule not listed: r0',
      SELECTED_OFF,
      NOT_FOLLOWING,
    ]);
  });

  it('a highestPriority whose contributors disagree, or whose selection is not the value', () => {
    const output = {
      type: 'number',
      combine: 'highestPriority',
      value: 1,
      selected: { ruleId: 'r1' },
    };
    expect(problems({ output, contributions: [1, 2] })).toEqual([SELECTED_OFF, NOT_FOLLOWING]);
  });

  it('a selection that is not the extreme', () => {
    const output = { type: 'number', combine: 'max', value: 2, selected: { ruleId: 'r0' } };
    expect(problems({ output, contributions: [1, 2] })).toEqual([SELECTED_OFF]);
  });

  it('contributors that are not the rules applied to the output', () => {
    const c = { output: { type: 'number', combine: 'sum', value: 3 }, contributions: [1, 2] };
    const content = proofOf(c);
    const outputs = content.outputs as Entry[];
    outputs[0] = { ...outputs[0], contributors: ['r0'] };
    const proof = { ...content, digest: treeDigestOf(content) };
    expect(verifyProof(proof).issues).toEqual([
      'contributors differ from applied steps: value',
      'unsigned',
    ]);
  });
});

describe('carried from 9I: each value checked against the whole declaration', () => {
  it.each([
    [
      'an enum value not in its values',
      {
        type: 'enum',
        combine: 'highestPriority',
        values: ['a'],
        value: 'b',
        selected: { ruleId: 'r0' },
      },
      'b',
    ],
    [
      'a sum below 0 under sign nonNegative',
      { type: 'decimal', combine: 'sum', sign: 'nonNegative', value: '-1' },
      '-1',
    ],
    [
      'a string that is not a value of its dimension',
      {
        type: 'string',
        combine: 'highestPriority',
        dimension: 'pays',
        value: ':FR',
        selected: { ruleId: 'r0' },
      },
      ':FR',
    ],
  ])('%s', (_label, output, contribution) => {
    expect(problems({ output, contributions: [contribution] })).toEqual([
      VALUE_OFF,
      CONTRIBUTION_OFF,
    ]);
  });

  it('a value of the right form, with a unit, passes', () => {
    const output = { type: 'decimal', combine: 'sum', unit: 'XOF', value: '12.5' };
    expect(problems({ output, contributions: ['12.5'] })).toEqual([]);
  });

  it('bounds hold values of the declared form, decimals canonical', () => {
    const output = {
      type: 'decimal',
      combine: 'sum',
      status: 'undetermined',
      bounds: { min: '1.0' },
    };
    // Undetermined by no pending rule: without a cause too.
    const NO_CAUSE = 'undetermined output without a cause: value';
    expect(problems({ output })).toEqual(['decimal value not canonical: value', NO_CAUSE]);
    const count = {
      type: 'number',
      combine: 'count',
      status: 'undetermined',
      bounds: { min: 1.5 },
    };
    expect(problems({ output: count })).toEqual([VALUE_OFF, NO_CAUSE]);
  });
});

describe('rounding at each contribution: unrounded', () => {
  const output = {
    type: 'decimal',
    combine: 'sum',
    value: '1.01',
    rounding: { scale: 2, mode: 'halfUp', at: 'contribution' },
  };

  it('is the value its contribution was rounded from', () => {
    expect(problems({ output, contributions: [rounded('1.01', '1.005')] })).toEqual([]);
    expect(problems({ output, contributions: [rounded('1.01', '1.02')] })).toEqual([
      'unrounded value does not round to its contribution: r0@1',
    ]);
  });

  it('is absent when rounding did not change the contribution', () => {
    expect(problems({ output, contributions: [rounded('1.01', '1.01')] })).toEqual([
      'unrounded value does not round to its contribution: r0@1',
    ]);
  });

  it('is absent without rounding at each contribution', () => {
    const plain = { type: 'decimal', combine: 'sum', value: '1.01' };
    expect(problems({ output: plain, contributions: [rounded('1.01', '1.005')] })).toEqual([
      'unrounded value without rounding at contribution: r0@1',
    ]);
  });
});
