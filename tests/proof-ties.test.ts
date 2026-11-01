import { describe, expect, it } from 'vitest';
import { problems } from './proof-builders.js';
import { traceProof } from './proof-trace.js';
import type { Trace } from './proof-trace.js';

describe('a substitution produced every later decision of its rules (D-8, D-22)', () => {
  const substitution = (status = 'determined') => ({
    ruleId: 'X',
    kind: 'substitute',
    affected: [{ ruleId: 'R' }],
    status,
  });
  const rules = [{ id: 'R' }, { id: 'X' }];
  const pendingTrace = (reason: string, detail: string): Trace => ({
    output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['R'] },
    rules,
    pending: [{ ruleId: 'R', output: 'value', reason, detail }],
    exceptions: [substitution()],
  });

  it('applied, pending UNDETERMINED or ERROR INVALID_PARAMS, or excluded after', () => {
    const applied: Trace = {
      output: { type: 'number', combine: 'sum', value: 1, contributors: ['R'] },
      rules,
      steps: [{ ruleId: 'R', contribution: 1 }],
      exceptions: [substitution()],
    };
    expect(problems(traceProof(applied))).toEqual([]);
    expect(problems(traceProof(pendingTrace('UNDETERMINED', 'missing /a')))).toEqual([]);
    expect(problems(traceProof(pendingTrace('ERROR', 'INVALID_PARAMS: bad')))).toEqual([]);
    const dominated: Trace = {
      output: { type: 'number', combine: 'sum', value: 0 },
      rules,
      skipped: [{ ruleId: 'R', output: 'value', reason: 'DOMINATED' }],
      exceptions: [substitution()],
      provisional: true,
    };
    expect(problems(traceProof(dominated))).toEqual([]);
    // The status check holds for each of them.
    const weaker = { ...dominated, exceptions: [substitution('provisional')] };
    expect(problems(traceProof(weaker))).toEqual([
      'decision weaker than the exception that affected it: R@1',
    ]);
  });

  it('not a version excluded before the exceptions ran', () => {
    const trace: Trace = {
      output: { type: 'number', combine: 'sum', value: 1, contributors: ['R'] },
      rules: [{ id: 'R' }, { id: 'R', version: 2 }, { id: 'X' }],
      steps: [{ ruleId: 'R', version: 2, contribution: 1, status: 'provisional' }],
      skipped: [{ ruleId: 'R', output: 'value', reason: 'INACTIVE_DATE' }],
      exceptions: [substitution('provisional')],
      provisional: true,
    };
    trace.output = { ...trace.output, status: 'provisional' };
    expect(problems(traceProof(trace))).toEqual([]);
  });

  it("nor an instance core's filter excluded before (CONDITION_FALSE, …)", () => {
    for (const reason of ['CONDITION_FALSE', 'DSL_ERROR', 'CONDITION_TIMEOUT', 'DSL_NOT_FOUND']) {
      const trace: Trace = {
        output: {
          type: 'number',
          combine: 'sum',
          status: 'provisional',
          value: 1,
          contributors: ['R'],
        },
        rules,
        steps: [{ ruleId: 'R', subject: '/e/@b', contribution: 1, status: 'provisional' }],
        skipped: [{ ruleId: 'R', subject: '/e/@a', output: 'value', reason }],
        exceptions: [substitution('provisional')],
        provisional: true,
      };
      expect(problems(traceProof(trace))).toEqual([]);
    }
  });

  it('a reason D-8 left to plugins, or unknown, is an exclusion of its own evaluation', () => {
    for (const reason of ['INVALID_PARAMS', 'OUTPUT_MISMATCH', 'CHECKSUM_MISMATCH', 'FUTURE']) {
      const trace: Trace = {
        output: { type: 'number', combine: 'sum', value: 0 },
        rules,
        skipped: [{ ruleId: 'R', output: 'value', reason }],
        exceptions: [substitution()],
      };
      expect(problems(traceProof(trace))).toEqual([]);
      const alone = { ...trace, rules: [{ id: 'R' }], exceptions: [] };
      expect(problems(traceProof(alone))).toEqual([]);
    }
  });
});

describe('a carrier excluded after it fired keeps its exceptions (core ExceptionResult)', () => {
  /** Y short-circuits `value`; X, its rule short-circuited there, still inhibits T. */
  const carrier = (reason: string): Trace => ({
    output: { type: 'number', combine: 'sum', value: 9, contributors: ['Y'] },
    rules: [{ id: 'T' }, { id: 'X', priority: 1 }, { id: 'Y', priority: 9 }],
    steps: [{ ruleId: 'Y', contribution: 9 }],
    skipped: [
      { ruleId: 'T', output: 'value', reason: 'INHIBITED' },
      { ruleId: 'X', output: 'value', reason },
    ],
    exceptions: [
      { ruleId: 'Y', kind: 'shortCircuit', output: 'value', affected: [{ ruleId: 'X' }] },
      { ruleId: 'X', kind: 'inhibit', affected: [{ ruleId: 'T' }] },
    ],
  });

  it('SHORT_CIRCUITED, INVALID_PARAMS, DOMINATED: it had fired', () => {
    expect(problems(traceProof(carrier('SHORT_CIRCUITED')))).toEqual([]);
    const own = carrier('INVALID_PARAMS');
    own.exceptions = [{ ruleId: 'X', kind: 'inhibit', affected: [{ ruleId: 'T' }] }];
    own.steps = [];
    own.output = { type: 'number', combine: 'sum', value: 0 };
    own.rules = [{ id: 'T' }, { id: 'X' }];
    expect(problems(traceProof(own))).toEqual([]);
    expect(problems(traceProof({ ...own, skipped: dominated(own) }))).toEqual([]);
  });

  /** The skips of `trace`, X now `DOMINATED`. */
  function dominated(trace: Trace): NonNullable<Trace['skipped']> {
    return (trace.skipped ?? []).map((skip) =>
      skip.ruleId === 'X' ? { ...skip, reason: 'DOMINATED' } : skip,
    );
  }

  it('refuses one excluded before the exceptions ran, or inhibited: it fired nothing', () => {
    for (const reason of ['INHIBITED', 'CONDITION_FALSE', 'INACTIVE_DATE']) {
      const trace: Trace = {
        output: { type: 'number', combine: 'sum', value: 0 },
        rules: [{ id: 'T' }, { id: 'X' }],
        skipped: [
          { ruleId: 'T', output: 'value', reason: 'INHIBITED' },
          { ruleId: 'X', output: 'value', reason },
        ],
        exceptions: [{ ruleId: 'X', kind: 'inhibit', affected: [{ ruleId: 'T' }] }],
      };
      const expected = ['exception of an excluded carrier: X@1'];
      // Its inhibition is then not counted.
      expected.push('inhibited without an exception: T@1');
      if (reason === 'INHIBITED') expected.push('inhibited without an exception: X@1');
      expect(problems(traceProof(trace))).toEqual(expected);
    }
  });
});

describe('exceptions in the order their carriers were processed: stratum first', () => {
  const ordered = (order: string[]): Trace => ({
    output: { type: 'number', combine: 'sum', value: 0 },
    outputs: [{ name: 'b', type: 'number', combine: 'sum', status: 'determined', value: 0 }].map(
      (o) => ({ ...o, contributors: [], pending: [] }),
    ),
    strata: [['value'], ['b']],
    rules: [{ id: 'A', priority: 1 }, { id: 'B', priority: 5 }, { id: 'T0' }, { id: 'T1' }],
    skipped: [
      { ruleId: 'T0', output: 'value', reason: 'INHIBITED' },
      { ruleId: 'T1', output: 'b', reason: 'INHIBITED', stratum: 1 },
    ],
    exceptions: order.map((id) =>
      id === 'A'
        ? { ruleId: 'A', kind: 'inhibit', affected: [{ ruleId: 'T0' }] }
        : { ruleId: 'B', kind: 'inhibit', affected: [{ ruleId: 'T1' }], stratum: 1 },
    ),
  });

  it('a carrier of stratum 0 before one of stratum 1, whatever their priorities', () => {
    expect(problems(traceProof(ordered(['A', 'B'])))).toEqual([]);
    expect(problems(traceProof(ordered(['B', 'A'])))).toEqual(['exceptions not sorted at 1']);
  });
});

describe('a conflict on an output from a tie the proof shows (D-7)', () => {
  const STRONGER = 'output status stronger than its causes: value';
  const TIE = 'output status weaker than its tie: value';

  /** X and X2 (priority 5) short-circuit `value`: core keeps X, excludes X2 RULE_CONFLICT. */
  const shortCircuits = (status: string, recorded = true, priority = 5): Trace => ({
    output: { type: 'number', combine: 'sum', value: 9, contributors: ['X'], status },
    rules: [{ id: 'A' }, { id: 'X', priority: 5 }, { id: 'X2', priority }],
    steps: [{ ruleId: 'X', contribution: 9 }],
    skipped: [
      { ruleId: 'A', output: 'value', reason: 'SHORT_CIRCUITED' },
      { ruleId: 'X2', reason: 'RULE_CONFLICT', status: 'conflict' },
    ],
    exceptions: [
      { ruleId: 'X', kind: 'shortCircuit', output: 'value', affected: [{ ruleId: 'A' }] },
      ...(recorded
        ? [
            {
              ruleId: 'X2',
              kind: 'shortCircuit',
              output: 'value',
              affected: [],
              status: 'conflict',
            },
          ]
        : []),
    ],
  });

  it('a short circuit tie: the loser excluded and recorded, the output in conflict', () => {
    expect(problems(traceProof(shortCircuits('conflict')))).toEqual([]);
    expect(problems(traceProof(shortCircuits('determined')))).toEqual([TIE]);
    // The tie must be shown: the loser's short circuit recorded.
    expect(problems(traceProof(shortCircuits('conflict', false)))).toEqual([STRONGER]);
  });

  it('refuses a short circuit tie without its loser excluded', () => {
    const fired: Trace = {
      ...shortCircuits('conflict'),
      skipped: [{ ruleId: 'A', output: 'value', reason: 'SHORT_CIRCUITED' }],
    };
    fired.exceptions = (fired.exceptions ?? []).map((e) =>
      e.ruleId === 'X2' ? { ...e, status: 'determined' } : e,
    );
    expect(problems(traceProof(fired))).toEqual([
      STRONGER,
      'short circuits tied without a loser excluded: X2@1',
      'conflict status without a tie in the proof',
    ]);
  });

  it('refuses a conflict no tie causes: a loser of lower priority is no tie', () => {
    // X2 fired, its claim not taken, and lost a later tie of its own: no tie on `value`.
    expect(problems(traceProof(shortCircuits('conflict', true, 4)))).toEqual([STRONGER]);
  });

  /** P fired (inhibiting Q); C, processed after it, would inhibit P and T: it is discarded. */
  const discarded = (status: string, affected = [{ ruleId: 'P' }, { ruleId: 'T' }]): Trace => ({
    output: { type: 'number', combine: 'sum', value: 1, contributors: ['T'], status },
    rules: [{ id: 'C', priority: 1 }, { id: 'P', priority: 5 }, { id: 'Q' }, { id: 'T' }],
    steps: [{ ruleId: 'T', contribution: 1 }],
    skipped: [
      { ruleId: 'C', reason: 'RULE_CONFLICT', status: 'conflict' },
      { ruleId: 'Q', output: 'value', reason: 'INHIBITED' },
    ],
    exceptions: [
      { ruleId: 'P', kind: 'inhibit', affected: [{ ruleId: 'Q' }] },
      { ruleId: 'C', kind: 'inhibit', affected, status: 'conflict' },
    ],
  });

  it('an exception precedence tie (R15): the outputs its targets feed, in conflict', () => {
    expect(problems(traceProof(discarded('conflict')))).toEqual([]);
    expect(problems(traceProof(discarded('determined')))).toEqual([TIE]);
  });

  it('without a precedent, a carrier excluded RULE_CONFLICT had fired: checked so', () => {
    expect(problems(traceProof(discarded('conflict', [{ ruleId: 'T' }])))).toEqual([
      STRONGER,
      'inhibited rule applied: T@1',
      'affected rule not inhibited by C@1: T',
    ]);
    const trace = discarded('conflict');
    trace.exceptions = (trace.exceptions ?? []).map((e) =>
      e.ruleId === 'C' ? { ...e, status: 'determined' } : e,
    );
    expect(problems(traceProof(trace))).toEqual([
      "exception status differs from its carrier's decision: C@1",
    ]);
  });
});

describe('a status needs a source somewhere in the proof (D-7)', () => {
  const sum = (status: string): Trace => ({
    output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'], status },
    rules: [{ id: 'A' }],
    steps: [{ ruleId: 'A', contribution: 1, status }],
  });

  it('provisional: a provisional assertion or undeclared reads', () => {
    expect(problems(traceProof(sum('provisional')))).toEqual([
      'provisional status without a source in the proof',
    ]);
    expect(problems(traceProof({ ...sum('provisional'), provisional: true }))).toEqual([]);
    const undeclared = traceProof(sum('provisional'));
    undeclared.readsUndeclared = [{ ruleId: 'A', version: 1, salt: 'a'.repeat(32) }];
    expect(problems(undeclared)).toEqual([]);
    // An unsettled output read before passes on a status; it starts none.
    const earlier: Trace = {
      ...sum('provisional'),
      outputs: [{ name: 'u', type: 'number', combine: 'sum', status: 'undetermined' }].map((o) => ({
        ...o,
        contributors: [],
        pending: ['B'],
      })),
      rules: [{ id: 'A' }, { id: 'B' }],
      steps: [{ ruleId: 'A', contribution: 1, status: 'provisional', stratum: 1 }],
      pending: [{ ruleId: 'B', output: 'u' }],
      strata: [['u'], ['value']],
    };
    expect(problems(traceProof(earlier))).toEqual([
      'provisional status without a source in the proof',
    ]);
  });

  it('conflict: a tie settled somewhere', () => {
    expect(problems(traceProof(sum('conflict')))).toEqual([
      'conflict status without a tie in the proof',
    ]);
  });
});
