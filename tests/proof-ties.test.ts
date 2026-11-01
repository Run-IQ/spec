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
    };
    trace.output = { ...trace.output, status: 'provisional' };
    expect(problems(traceProof(trace))).toEqual([]);
  });

  it('refuses the exclusions core no longer emits: they are pending ERROR (D-8)', () => {
    const old: Trace = {
      output: { type: 'number', combine: 'sum', value: 0 },
      rules,
      skipped: [{ ruleId: 'R', output: 'value', reason: 'INVALID_PARAMS' }],
      exceptions: [substitution()],
    };
    expect(problems(traceProof(old))).toEqual(['exclusion core no longer emits: R@1']);
    for (const reason of ['DSL_ERROR', 'CONDITION_TIMEOUT', 'OUTPUT_MISMATCH', 'INVALID_RULE']) {
      const skipped = [{ ruleId: 'R', output: 'value', reason }];
      expect(
        problems(traceProof({ ...old, rules: [{ id: 'R' }], skipped, exceptions: [] })),
      ).toEqual(['exclusion core no longer emits: R@1']);
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

  /** X and X2 short-circuit `value`; X wins, X2 at `priority`. */
  const shortCircuits = (status: string, priority = 0): Trace => ({
    output: { type: 'number', combine: 'sum', value: 9, contributors: ['X'], status },
    rules: [{ id: 'X' }, { id: 'X2', priority }],
    steps: [{ ruleId: 'X', contribution: 9 }],
    exceptions: [
      { ruleId: 'X', kind: 'shortCircuit', output: 'value', affected: [] },
      { ruleId: 'X2', kind: 'shortCircuit', output: 'value', affected: [] },
    ],
  });

  it('two short circuits of an output at the top: the output, not the step, in conflict', () => {
    expect(problems(traceProof(shortCircuits('conflict')))).toEqual([]);
    expect(problems(traceProof(shortCircuits('determined')))).toEqual([TIE]);
  });

  it('refuses a conflict no tie causes', () => {
    const below = shortCircuits('conflict', -1);
    expect(problems(traceProof(below))).toEqual([STRONGER]);
    expect(problems(traceProof(shortCircuits('determined', -1)))).toEqual([]);
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

  it('refuses a discarded carrier without a precedent it would have inhibited', () => {
    expect(problems(traceProof(discarded('conflict', [{ ruleId: 'T' }])))).toEqual([
      STRONGER,
      'discarded carrier without a precedent: C@1',
    ]);
    const trace = discarded('conflict');
    trace.exceptions = (trace.exceptions ?? []).map((e) =>
      e.ruleId === 'C' ? { ...e, status: 'determined' } : e,
    );
    expect(problems(traceProof(trace))).toEqual([
      "exception status differs from its carrier's decision: C@1",
    ]);
  });

  it('refuses an exception of a carrier excluded otherwise', () => {
    const trace: Trace = {
      output: { type: 'number', combine: 'sum', value: 0 },
      rules: [{ id: 'X' }],
      skipped: [{ ruleId: 'X', reason: 'CONDITION_FALSE' }],
      exceptions: [{ ruleId: 'X', kind: 'inhibit', affected: [] }],
    };
    expect(problems(traceProof(trace))).toEqual(['exception of an excluded carrier: X@1']);
  });
});
