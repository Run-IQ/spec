/**
 * What the redacted entries of a proof can explain, for the whole proof (review of 9K1, round
 * 4): each problem lifted needs a hidden entry carrying what would explain it, distinct entries
 * where one could not carry both, matched to the redacted entries of their sections (Hall's
 * condition). k made-up markers never excuse more than k entries' worth of problems, and an
 * honest redaction is never refused.
 */
import { describe, expect, it } from 'vitest';
import { verifyProof } from '../src/index.js';
import type { DecisionProof, ProofSection } from '../src/index.js';
import { handSealed } from './helpers.js';
import { everySubset, honestProof, invalidRedactions, placesOf } from './honest-redactions.js';
import type { Content } from './proof-builders.js';
import { unsigned } from './proof-cases.js';
import { traceProof } from './proof-trace.js';
import type { Trace } from './proof-trace.js';

const FAKE = (n: number): { redacted: string } => ({ redacted: n.toString(16).padStart(64, 'e') });

/** `content` with a made-up marker in each of `sections`, sealed by hand as salted. */
function forged(content: Content, ...sections: ProofSection[]): DecisionProof {
  const record: Record<string, unknown> = { ...content, inputSalted: true };
  sections.forEach((section, n) => {
    record[section] = [...(record[section] as unknown[]), FAKE(n + 1)];
  });
  return handSealed(record) as unknown as DecisionProof;
}

const ONE: Trace = {
  output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'] },
  rules: [{ id: 'A' }],
  steps: [{ ruleId: 'A', contribution: 1 }],
};

/** A per output `value` over `/e`, with steps of A and B under `subjects`, and no item. */
const perSteps = (...subjects: string[]): Content =>
  traceProof({
    output: { type: 'decimal', combine: 'sum', per: '/e', status: 'determined' },
    rules: [{ id: 'A' }, { id: 'B' }],
    steps: subjects.map((subject, i) => ({
      ruleId: i === 0 ? 'A' : 'B',
      contribution: '1',
      subject,
    })),
  });

/** Two undetermined outputs, `value` and `zother`, without a cause. */
function twoUndetermined(): Content {
  const one = traceProof({
    output: { type: 'number', combine: 'sum', status: 'undetermined' },
    rules: [],
  }) as Record<string, unknown[]>;
  const output = one.outputs![0] as Record<string, unknown>;
  return {
    ...one,
    outputs: [output, { ...output, name: 'zother' }],
    strata: [['value', 'zother']],
  };
}

const REFUSED: {
  name: string;
  content: () => Content;
  sections: ProofSection[];
  issues: string[];
}[] = [
  {
    name: 'two versions of one rule cited, one rules marker',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 2, contributors: ['Z'] },
        rules: [],
        steps: [
          { ruleId: 'Z', contribution: 1 },
          { ruleId: 'Z', version: 2, contribution: 1 },
        ],
      }),
    sections: ['rules'],
    issues: [
      'cited rule not listed: Z@1',
      'cited rule not listed: Z@2',
      'cited rule not listed: Z',
    ],
  },
  {
    name: 'two rules cited, one rules marker',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 2, contributors: ['Z', 'Y'] },
        rules: [],
        steps: [
          { ruleId: 'Z', contribution: 1 },
          { ruleId: 'Y', contribution: 1 },
        ],
      }),
    sections: ['rules'],
    issues: ['cited rule not listed: Y@1', 'cited rule not listed: Z@1'],
  },
  {
    name: 'a requested output and a stratum output, two checks, one outputs marker',
    content: () => {
      const base = traceProof(ONE) as Record<string, unknown>;
      return { ...base, requested: ['Y'], strata: [...(base.strata as string[][]), ['Z']] };
    },
    sections: ['outputs'],
    issues: ['requested output absent: Y', 'stratum output unknown: Z'],
  },
  {
    name: 'two steps under two elements, no item, one items marker',
    content: () => perSteps('/e/@0', '/e/@1'),
    sections: ['items'],
    issues: ['step feeds no item: A@1 at /e/@0', 'step feeds no item: B@1 at /e/@1'],
  },
  {
    name: 'steps under no element of the collection: no item could feed them',
    content: () => perSteps('/e/0', '/e/1'),
    sections: ['items', 'items'],
    issues: ['step feeds no item: A@1 at /e/0', 'step feeds no item: B@1 at /e/1'],
  },
  {
    name: 'a grouped exclusion: no item could feed it',
    content: () =>
      traceProof({
        output: { type: 'decimal', combine: 'sum', per: '/e', status: 'determined' },
        rules: [{ id: 'A' }],
        skipped: [{ ruleId: 'A', output: 'value', reason: 'CONDITION_FALSE' }],
      }),
    sections: ['items', 'items'],
    issues: ['exclusion feeds no item: A@1'],
  },
  {
    name: 'two undetermined outputs without a cause, one pending marker',
    content: twoUndetermined,
    sections: ['pending'],
    issues: [
      'undetermined output without a cause: value',
      'undetermined output without a cause: zother',
    ],
  },
  {
    // Per section the counts pass (one problem, one marker each); matched, they do not: both
    // problems need an outputs entry.
    name: 'Hall: two problems confined to outputs, one outputs and one applied marker',
    content: () => {
      const base = traceProof({
        output: { type: 'number', combine: 'sum', value: 0 },
        rules: [],
      }) as Record<string, unknown>;
      return {
        ...base,
        requested: ['Y', 'value'],
        strata: [...(base.strata as string[][]), ['Z']],
      };
    },
    sections: ['outputs', 'applied'],
    issues: ['requested output absent: Y', 'stratum output unknown: Z'],
  },
];

describe('k markers never excuse more than k entries can explain (review of 9K1, round 4)', () => {
  for (const { name, content, sections, issues } of REFUSED) {
    it(name, () => {
      const result = verifyProof(forged(content(), ...sections));
      expect(result.status).toBe('invalid');
      for (const issue of issues) expect(result.issues).toContain(issue);
      expect(result.lifted).toEqual([]);
    });
  }

  it('Hall: with two outputs markers, both are lifted', () => {
    const { content } = REFUSED[7]!;
    const result = verifyProof(forged(content(), 'outputs', 'outputs'));
    expect(result.status).toBe('consistent-redacted');
    expect(result.lifted?.map((lift) => lift.check)).toEqual([
      'requested outputs listed',
      'stratum outputs listed',
    ]);
  });

  it('one step may decide a rule and feed a target: one applied marker lifts both', () => {
    const content = traceProof({
      ...ONE,
      output: { ...ONE.output, value: 999 },
      rules: [{ id: 'A' }, { id: 'B' }],
    });
    const plain = verifyProof(handSealed({ ...content, inputSalted: true }) as never).issues;
    expect(plain).toContain('rule not decided: B@1');
    expect(plain).toContain('output value does not follow from its contributions: value');
    const result = verifyProof(forged(content, 'applied'));
    expect(result.status).toBe('consistent-redacted');
    expect(result.lifted?.map((lift) => lift.check)).toEqual([
      'output value from its contributions',
      'every listed rule decided',
    ]);
  });

  it('one undetermined output without a cause, one pending marker: lifted', () => {
    const one = twoUndetermined() as Record<string, unknown[]>;
    const content = { ...one, outputs: [one.outputs![0]], strata: [['value']] };
    const result = verifyProof(forged(content, 'pending'));
    expect(result.status).toBe('consistent-redacted');
    expect(result.lifted?.map((lift) => lift.check)).toEqual(['undetermined output has a cause']);
  });

  it('two steps under two elements, two items markers: lifted', () => {
    const result = verifyProof(forged(perSteps('/e/@0', '/e/@1'), 'items', 'items'));
    expect(result.issues.filter((issue) => issue.startsWith('step feeds no item'))).toEqual([]);
    expect(result.lifted?.map((lift) => lift.check)).toContain('items of their collection');
  });

  it('two steps under one element: one items marker lifts both', () => {
    const result = verifyProof(forged(perSteps('/e/@0/a', '/e/@0/b'), 'items'));
    expect(result.issues.filter((issue) => issue.startsWith('step feeds no item'))).toEqual([]);
    expect(result.lifted?.map((lift) => lift.check)).toContain('items of their collection');
  });
});

/** A check of one fixture: what one marker refuses, what as many as its entries lift. */
const PAIRS: { name: string; content: () => Content; section: ProofSection; issues: string[] }[] = [
  {
    name: 'ranks of two rules out of range: one hidden instance each',
    content: () =>
      traceProof({
        output: {
          type: 'number',
          combine: 'highestPriority',
          value: 1,
          contributors: ['A', 'B'],
          selected: { ruleId: 'A', subject: '/e/@1' },
        },
        rules: [{ id: 'A' }, { id: 'B' }],
        steps: [
          { ruleId: 'A', subject: '/e/@1', contribution: 1, rank: 1 },
          { ruleId: 'B', subject: '/e/@2', contribution: 1, rank: 1 },
        ],
      }),
    section: 'applied',
    issues: ['rank out of range: A@1 at /e/@1', 'rank out of range: B@1 at /e/@2'],
  },
  {
    // B and C are decided (excluded): only their pending entries on `value` are missing.
    name: 'two pending rules of an output missing: one pending entry each',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['B', 'C'] },
        rules: [{ id: 'B' }, { id: 'C' }],
        skipped: [
          { ruleId: 'B', reason: 'CONDITION_FALSE' },
          { ruleId: 'C', reason: 'CONDITION_FALSE' },
        ],
      }),
    section: 'pending',
    issues: ['pending differ from pending rules: value'],
  },
];

describe('one hidden entry per rule (review of 9K1, round 4)', () => {
  for (const { name, content, section, issues } of PAIRS) {
    it(name, () => {
      const plain = verifyProof(handSealed({ ...content(), inputSalted: true }) as never).issues;
      for (const issue of issues) expect(plain).toContain(issue);
      const one = verifyProof(forged(content(), section));
      expect(one.status).toBe('invalid');
      for (const issue of issues) expect(one.issues).toContain(issue);
      const two = verifyProof(forged(content(), section, section));
      expect(two.status).toBe('consistent-redacted');
    });
  }

  it('a pending rule listed twice is not a hidden entry', () => {
    const content = traceProof({
      output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['B', 'B'] },
      rules: [{ id: 'B' }],
      pending: [{ ruleId: 'B', output: 'value', reason: 'UNDETERMINED', detail: 'x' }],
    });
    const result = verifyProof(forged(content, 'pending', 'pending'));
    expect(result.issues).toContain('pending differ from pending rules: value');
    expect(result.lifted).toEqual([]);
  });

  it('a decision twice without the steps is not lifted by a hidden exception', () => {
    const content = traceProof({
      output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['A'] },
      rules: [{ id: 'A' }],
      skipped: [{ ruleId: 'A', output: 'value', reason: 'CONDITION_FALSE' }],
      pending: [{ ruleId: 'A', output: 'value', reason: 'UNDETERMINED', detail: 'x' }],
    });
    const result = verifyProof(forged(content, 'exceptions'));
    expect(result.issues).toContain('rule decided twice: A@1');
    expect(result.lifted?.map((lift) => lift.check)).not.toContain(
      'decisions against the exceptions',
    );
  });
});

describe('an honest redaction is never refused (review of 9K1, round 4)', () => {
  const of = (id: string): { ruleId: string; version: number } => ({ ruleId: id, version: 1 });
  const CHAIN = traceProof({
    output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T', 'X', 'Y'] },
    rules: [{ id: 'T' }, { id: 'X' }, { id: 'Y' }],
    pending: [
      { ruleId: 'T', output: 'value', reason: 'PENDING_CARRIER', detail: 'x', carrier: of('X') },
      {
        ruleId: 'X',
        output: 'value',
        reason: 'PENDING_CARRIER',
        detail: 'x',
        carrier: of('Y'),
        fired: false,
      },
      { ruleId: 'Y', output: 'value', reason: 'UNDETERMINED', detail: 'missing /p', fired: false },
    ],
  });

  it.each([
    ['the plan proof', unsigned(), 64],
    ['a pending carrier chain', CHAIN, 128],
  ])('%s: every subset of its entries', (_, content, subsets) => {
    const proof = honestProof(content);
    const n = placesOf(proof).length;
    expect(2 ** n).toBe(subsets);
    expect(invalidRedactions(proof, everySubset(n))).toEqual([]);
  });
});
