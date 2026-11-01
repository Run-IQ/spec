import { describe, expect, it } from 'vitest';
import { problems } from './proof-builders.js';
import type { Entry } from './proof-builders.js';
import { traceProof } from './proof-trace.js';
import type { Trace } from './proof-trace.js';

const NOT_FOLLOWING = 'output value does not follow from its contributions: value';
const CONTRIBUTORS = 'contributors differ from applied steps: value';

/** A highestPriority output `value` of numbers. */
const highest = (value: number | undefined, contributors: string[], selected?: Entry): Entry => ({
  type: 'number',
  combine: 'highestPriority',
  ...(value === undefined ? {} : { value }),
  contributors,
  ...(selected === undefined ? {} : { selected }),
});

describe('highestPriority: the rules of the top precedence and priority contribute (I1)', () => {
  const rules = [
    { id: 'A', priority: 10 },
    { id: 'B', priority: 1 },
  ];
  const steps = [
    { ruleId: 'A', contribution: 1 },
    { ruleId: 'B', contribution: 2 },
  ];

  it('takes the highest priority; a lower one is applied but does not contribute', () => {
    expect(
      problems(traceProof({ output: highest(1, ['A'], { ruleId: 'A' }), rules, steps })),
    ).toEqual([]);
  });

  it('refuses a lower priority named as the contributor', () => {
    expect(
      problems(traceProof({ output: highest(2, ['B'], { ruleId: 'B' }), rules, steps })),
    ).toEqual([CONTRIBUTORS, 'selected does not match the value: value', NOT_FOLLOWING]);
  });

  it('refuses contributors beyond the top, or a rule of the top left out', () => {
    expect(
      problems(traceProof({ output: highest(1, ['A', 'B'], { ruleId: 'A' }), rules, steps })),
    ).toEqual([CONTRIBUTORS]);
    const tied = [
      { id: 'A', priority: 5 },
      { id: 'B', priority: 5 },
    ];
    const agree = [
      { ruleId: 'A', contribution: 3 },
      { ruleId: 'B', contribution: 3 },
    ];
    expect(
      problems(
        traceProof({ output: highest(3, ['A'], { ruleId: 'A' }), rules: tied, steps: agree }),
      ),
    ).toEqual([CONTRIBUTORS]);
    expect(
      problems(
        traceProof({ output: highest(3, ['A', 'B'], { ruleId: 'A' }), rules: tied, steps: agree }),
      ),
    ).toEqual([]);
    // D-27: the first of equal values in contribution order is selected.
    expect(
      problems(
        traceProof({ output: highest(3, ['A', 'B'], { ruleId: 'B' }), rules: tied, steps: agree }),
      ),
    ).toEqual(['selected does not match the value: value']);
  });

  it('a tie of different values: the loser excluded RULE_CONFLICT, the output in conflict', () => {
    const tied = [
      { id: 'A', priority: 5 },
      { id: 'B', priority: 5 },
    ];
    const both = [
      { ruleId: 'A', contribution: 3 },
      { ruleId: 'B', contribution: 4 },
    ];
    // Both applied at the top, they disagree: no value follows.
    expect(
      problems(
        traceProof({ output: highest(3, ['A', 'B'], { ruleId: 'A' }), rules: tied, steps: both }),
      ),
    ).toEqual([NOT_FOLLOWING]);
    expect(
      problems(
        traceProof({ output: highest(3, ['A'], { ruleId: 'A' }), rules: tied, steps: both }),
      ),
    ).toEqual([CONTRIBUTORS, NOT_FOLLOWING]);
    const honest: Trace = {
      output: { ...highest(3, ['A'], { ruleId: 'A' }), status: 'conflict' },
      rules: tied,
      steps: [{ ruleId: 'A', contribution: 3, status: 'conflict' }],
      skipped: [{ ruleId: 'B', output: 'value', reason: 'RULE_CONFLICT', status: 'conflict' }],
    };
    expect(problems(traceProof(honest))).toEqual([]);
    const settled = { ...honest, skipped: [{ ...honest.skipped![0], status: 'determined' }] };
    expect(problems(traceProof(settled))).toEqual(['tie loser not in conflict: B@1']);
  });

  it('precedence comes before priority (D-23)', () => {
    const trace: Trace = {
      output: { ...highest(1, ['vat:A'], { ruleId: 'vat:A' }), name: 'social:o' },
      rules: [
        { id: 'social:B', priority: 9 },
        { id: 'vat:A', priority: 1 },
      ],
      steps: [
        { ruleId: 'social:B', contribution: 2, output: 'social:o' },
        { ruleId: 'vat:A', contribution: 1, output: 'social:o' },
      ],
      ruleSets: [
        { kind: 'pack', id: 'vat', version: '1', digest: 'e'.repeat(64), imports: ['social'] },
        { kind: 'pack', id: 'social', version: '1', digest: 'f'.repeat(64) },
      ],
    };
    expect(problems(traceProof(trace))).toEqual([]);
    const byPriority = {
      ...trace,
      output: { ...highest(2, ['social:B'], { ruleId: 'social:B' }), name: 'social:o' },
    };
    expect(problems(traceProof(byPriority))).toEqual([
      'contributors differ from applied steps: social:o',
      'selected does not match the value: social:o',
      'output value does not follow from its contributions: social:o',
    ]);
  });

  it('a settled highestPriority with a pending rule: its winner outranks it by precedence', () => {
    const trace: Trace = {
      output: {
        ...highest(1, ['vat:A'], { ruleId: 'vat:A' }),
        name: 'social:o',
        pending: ['social:P'],
      },
      rules: [
        { id: 'social:P', priority: 9 },
        { id: 'vat:A', priority: 1 },
      ],
      steps: [{ ruleId: 'vat:A', contribution: 1, output: 'social:o' }],
      pending: [{ ruleId: 'social:P', output: 'social:o' }],
      ruleSets: [
        { kind: 'pack', id: 'vat', version: '1', digest: 'e'.repeat(64), imports: ['social'] },
        { kind: 'pack', id: 'social', version: '1', digest: 'f'.repeat(64) },
      ],
    };
    expect(problems(traceProof(trace))).toEqual([]);
  });
});

describe('the contribution order is checked (I2, D-5): one decision, one proof', () => {
  const rules = [
    { id: 'r0', priority: 3 },
    { id: 'r1', priority: 2 },
    { id: 'r2', priority: 1 },
  ];

  it('a number sum: precedence, priority descending, identity', () => {
    const steps = [
      { ruleId: 'r0', contribution: 1e20 },
      { ruleId: 'r1', contribution: 5 },
      { ruleId: 'r2', contribution: -1e20 },
    ];
    const sum = (contributors: string[], value: number): Trace => ({
      output: { type: 'number', combine: 'sum', value, contributors },
      rules,
      steps,
    });
    expect(problems(traceProof(sum(['r0', 'r1', 'r2'], 10)))).toEqual([]);
    expect(problems(traceProof(sum(['r0', 'r2', 'r1'], 5)))).toEqual([
      'contributors not in contribution order: value',
    ]);
  });

  it('a decimal sum, whose value does not depend on it, has one order too', () => {
    const steps = ['1', '2', '3'].map((contribution, i) => ({ ruleId: `r${i}`, contribution }));
    const sum = (contributors: string[]): Trace => ({
      output: { type: 'decimal', combine: 'sum', value: '6', contributors },
      rules,
      steps,
    });
    expect(problems(traceProof(sum(['r0', 'r1', 'r2'])))).toEqual([]);
    expect(problems(traceProof(sum(['r2', 'r1', 'r0'])))).toEqual([
      'contributors not in contribution order: value',
    ]);
  });

  it('equal priorities: by identity, rule set first', () => {
    const steps = [
      { ruleId: 'b', contribution: '1' },
      { ruleId: 'a', contribution: '2' },
    ];
    const sum = (contributors: string[]): Trace => ({
      output: { type: 'decimal', combine: 'sum', value: '3', contributors },
      rules: [{ id: 'a' }, { id: 'b' }],
      steps,
    });
    expect(problems(traceProof(sum(['a', 'b'])))).toEqual([]);
    expect(problems(traceProof(sum(['b', 'a'])))).toEqual([
      'contributors not in contribution order: value',
    ]);
  });

  it('the pending rules of an output', () => {
    const pending = (names: string[]): Trace => ({
      output: { type: 'number', combine: 'sum', status: 'undetermined', pending: names },
      rules: [{ id: 'p1' }, { id: 'p2', priority: 4 }],
      pending: [
        { ruleId: 'p1', output: 'value' },
        { ruleId: 'p2', output: 'value' },
      ],
    });
    expect(problems(traceProof(pending(['p2', 'p1'])))).toEqual([]);
    expect(problems(traceProof(pending(['p1', 'p2'])))).toEqual([
      'pending not in contribution order: value',
    ]);
  });

  it('the exceptions: in the order their carriers were processed', () => {
    const trace = (carriers: string[]): Trace => ({
      output: { type: 'number', combine: 'sum', value: 0 },
      rules: [{ id: 'A' }, { id: 'B' }, { id: 'X', priority: 1 }, { id: 'Y', priority: 5 }],
      skipped: [
        { ruleId: 'A', output: 'value', reason: 'INHIBITED' },
        { ruleId: 'B', output: 'value', reason: 'INHIBITED' },
      ],
      exceptions: carriers.map((id) => ({
        ruleId: id,
        kind: 'inhibit',
        affected: [{ ruleId: id === 'X' ? 'A' : 'B' }],
      })),
    });
    expect(problems(traceProof(trace(['Y', 'X'])))).toEqual([]);
    expect(problems(traceProof(trace(['X', 'Y'])))).toEqual(['exceptions not sorted at 1']);
  });
});

describe('a forEach rule feeding a highestPriority output: rank 0 wins (I4, D-21)', () => {
  const ranked = (ranks: (number | undefined)[], selected: string, value: number): Trace => ({
    output: highest(value, ['R'], { ruleId: 'R', subject: selected }),
    rules: [{ id: 'R' }],
    steps: ranks.map((rank, i) => ({
      ruleId: 'R',
      subject: `/e/@${'ab'[i]}`,
      contribution: [5, 7][i],
      ...(rank === undefined ? {} : { rank }),
    })),
  });

  it('the instance of rank 0 is selected', () => {
    expect(problems(traceProof(ranked([1, 0], '/e/@b', 7)))).toEqual([]);
    expect(problems(traceProof(ranked([1, 0], '/e/@a', 5)))).toEqual([
      'selected does not match the value: value',
      NOT_FOLLOWING,
    ]);
  });

  it('refuses a rank missing, two instances at rank 0, or none', () => {
    expect(problems(traceProof(ranked([undefined, 0], '/e/@b', 7)))).toEqual([
      'rank missing: R@1 at /e/@a',
    ]);
    expect(problems(traceProof(ranked([0, 0], '/e/@b', 7)))).toEqual([
      'instances tied at rank 0: R@1',
    ]);
    expect(problems(traceProof(ranked([1, 1], '/e/@b', 7)))).toEqual([
      'no instance at rank 0: R@1',
    ]);
  });

  it('refuses a rank where nothing competes', () => {
    const sum: Trace = {
      output: { type: 'number', combine: 'sum', value: 5, contributors: ['R'] },
      rules: [{ id: 'R' }],
      steps: [{ ruleId: 'R', subject: '/e/@a', contribution: 5, rank: 0 }],
    };
    expect(problems(traceProof(sum))).toEqual([
      'rank on a step that does not compete: R@1 at /e/@a',
    ]);
  });
});

describe('a status is the strongest of its causes, never stronger (M1, D-7)', () => {
  const sum = (status: string, stepStatus: string): Trace => ({
    output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'], status },
    rules: [{ id: 'A' }],
    steps: [{ ruleId: 'A', contribution: 1, status: stepStatus }],
  });

  it('refuses an output stronger than its contributions and candidates', () => {
    expect(problems(traceProof(sum('provisional', 'provisional')))).toEqual([]);
    for (const status of ['provisional', 'conflict']) {
      expect(problems(traceProof(sum(status, 'determined')))).toEqual([
        'output status stronger than its causes: value',
      ]);
    }
    expect(problems(traceProof(sum('conflict', 'provisional')))).toEqual([
      'output status stronger than its causes: value',
    ]);
  });

  it('an exclusion is a cause', () => {
    const trace: Trace = {
      ...sum('provisional', 'determined'),
      rules: [{ id: 'A' }, { id: 'B' }],
      skipped: [{ ruleId: 'B', output: 'value', reason: 'CONDITION_FALSE', status: 'provisional' }],
    };
    expect(problems(traceProof(trace))).toEqual([]);
  });
});
