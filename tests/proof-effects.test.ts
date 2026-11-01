import { describe, expect, it } from 'vitest';
import { validateProof } from '../src/index.js';
import { problems } from './proof-builders.js';
import { traceProof } from './proof-trace.js';
import type { Trace } from './proof-trace.js';

describe('an exception affects the decisions it produced only (I3)', () => {
  it('an inhibition reaches the inhibited version, not one excluded before', () => {
    const trace: Trace = {
      output: { type: 'number', combine: 'sum', status: 'provisional', value: 0 },
      rules: [{ id: 'R', version: 1 }, { id: 'R', version: 2 }, { id: 'X' }],
      skipped: [
        { ruleId: 'R', version: 1, output: 'value', reason: 'INACTIVE_DATE' },
        { ruleId: 'R', version: 2, output: 'value', reason: 'INHIBITED', status: 'provisional' },
      ],
      exceptions: [
        { ruleId: 'X', kind: 'inhibit', affected: [{ ruleId: 'R' }], status: 'provisional' },
      ],
    };
    expect(problems(traceProof(trace))).toEqual([]);
    const weaker = {
      ...trace,
      skipped: [trace.skipped![0]!, { ...trace.skipped![1], status: 'determined' }],
      output: { ...trace.output, status: 'provisional' },
    };
    expect(problems(traceProof(weaker))).toEqual([
      'output status stronger than its causes: value',
      'decision weaker than the exception that affected it: R@2',
    ]);
  });
});

describe('exceptions and the decisions they produced agree (I6)', () => {
  const inhibition = (kind: string): Trace => ({
    output: { type: 'number', combine: 'sum', value: 0 },
    rules: [{ id: 'A' }, { id: 'X' }],
    skipped: [{ ruleId: 'A', output: 'value', reason: kind }],
    exceptions: [{ ruleId: 'X', kind: 'inhibit', affected: [{ ruleId: 'A' }] }],
  });

  it('an inhibited rule is excluded INHIBITED, by an exception that names it', () => {
    expect(problems(traceProof(inhibition('INHIBITED')))).toEqual([]);
    expect(
      problems(traceProof({ ...inhibition('INHIBITED'), rules: [{ id: 'A' }], exceptions: [] })),
    ).toEqual(['inhibited without an exception: A@1']);
    expect(problems(traceProof(inhibition('CONDITION_FALSE')))).toEqual([
      'affected rule not inhibited by X@1: A',
    ]);
  });

  it('refuses an inhibited rule that was applied', () => {
    const trace: Trace = {
      output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'] },
      rules: [{ id: 'A' }, { id: 'X' }],
      steps: [{ ruleId: 'A', contribution: 1 }],
      exceptions: [{ ruleId: 'X', kind: 'inhibit', affected: [{ ruleId: 'A' }] }],
    };
    expect(problems(traceProof(trace))).toEqual([
      'inhibited rule applied: A@1',
      'affected rule not inhibited by X@1: A',
    ]);
  });

  it('an inhibition at a subject reaches the instances under it', () => {
    const trace = (at: string): Trace => ({
      output: { type: 'decimal', combine: 'sum', value: '1', contributors: ['A'] },
      rules: [{ id: 'A' }, { id: 'X' }],
      steps: [{ ruleId: 'A', subject: '/e/@1', contribution: '1' }],
      skipped: [{ ruleId: 'A', subject: '/e/@2', output: 'value', reason: 'INHIBITED' }],
      exceptions: [{ ruleId: 'X', kind: 'inhibit', affected: [{ ruleId: 'A', subject: at }] }],
    });
    expect(problems(traceProof(trace('/e/@2')))).toEqual([]);
    expect(problems(traceProof(trace('/e')))).toEqual(['inhibited rule applied: A@1 at /e/@1']);
  });

  const shortCircuit = (patch: Partial<Trace> = {}): Trace => ({
    output: { type: 'number', combine: 'sum', value: 9, contributors: ['X'] },
    rules: [{ id: 'A' }, { id: 'X' }],
    steps: [{ ruleId: 'X', contribution: 9 }],
    skipped: [{ ruleId: 'A', output: 'value', reason: 'SHORT_CIRCUITED' }],
    exceptions: [
      { ruleId: 'X', kind: 'shortCircuit', output: 'value', affected: [{ ruleId: 'A' }] },
    ],
    ...patch,
  });

  it('a short circuit imposes its carrier step alone on its output', () => {
    expect(problems(traceProof(shortCircuit()))).toEqual([]);
    const beside = shortCircuit({
      output: { type: 'number', combine: 'sum', value: 9, contributors: ['A', 'X'] },
      steps: [
        { ruleId: 'A', contribution: 1 },
        { ruleId: 'X', contribution: 9 },
      ],
      skipped: [],
      exceptions: [{ ruleId: 'X', kind: 'shortCircuit', output: 'value', affected: [] }],
    });
    expect(problems(traceProof(beside))).toEqual(['steps beside a short circuit: value']);
    expect(
      problems(traceProof(shortCircuit({ rules: [{ id: 'X' }], exceptions: [], skipped: [] }))),
    ).toEqual([]);
  });

  it('refuses a short circuit whose carrier did not apply', () => {
    const skipped = shortCircuit({
      output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'] },
      steps: [{ ruleId: 'A', contribution: 1 }],
      skipped: [{ ruleId: 'X', output: 'value', reason: 'CONDITION_FALSE' }],
      exceptions: [{ ruleId: 'X', kind: 'shortCircuit', output: 'value', affected: [] }],
    });
    expect(problems(traceProof(skipped))).toEqual([
      // An excluded carrier fires nothing.
      'exception of an excluded carrier: X@1',
      'short circuit without its carrier applied: X@1',
    ]);
  });

  it('a short-circuited rule is excluded SHORT_CIRCUITED by an exception naming it', () => {
    expect(problems(traceProof(shortCircuit({ exceptions: [] })))).toEqual([
      'short-circuited without an exception: A@1',
    ]);
  });

  it('only the step on the short-circuited output is imposed', () => {
    // X short-circuits `value` and feeds its own output `own` too: that step is its own.
    const own: Trace = shortCircuit({
      outputs: [
        {
          name: 'own',
          type: 'number',
          combine: 'sum',
          status: 'determined',
          value: 3,
          contributors: ['X'],
          pending: [],
        },
      ],
      steps: [
        { ruleId: 'X', contribution: 9 },
        { ruleId: 'X', contribution: 3, output: 'own' },
      ],
    });
    expect(problems(traceProof(own))).toEqual([]);
    // Its own step on a count is a boolean, counted: not a value imposed.
    const counted = shortCircuit({
      outputs: [
        {
          name: 'own',
          type: 'number',
          combine: 'count',
          status: 'determined',
          value: 1,
          contributors: ['X'],
          pending: [],
        },
      ],
      steps: [
        { ruleId: 'X', contribution: 9 },
        { ruleId: 'X', contribution: true, output: 'own' },
      ],
    });
    expect(problems(traceProof(counted))).toEqual([]);
  });

  it('the output of a short circuit is in its exception, and only there', () => {
    const content = traceProof(shortCircuit());
    const [exception] = content.exceptions as Record<string, unknown>[];
    const without = { ...exception };
    delete without.output;
    const issues = (entry: Record<string, unknown>) =>
      validateProof({ ...content, exceptions: [entry], digest: '0'.repeat(64) }).issues;
    expect(issues(without)).toEqual([
      {
        path: 'exceptions[0].output',
        message: 'exceptions[0].output is required for a shortCircuit',
      },
    ]);
    expect(issues({ ...exception, kind: 'inhibit' })).toEqual([
      {
        path: 'exceptions[0].output',
        message: 'exceptions[0].output applies only to a shortCircuit',
      },
    ]);
  });
});

describe("a rule's entries feed one output (M2, D-21)", () => {
  it('refuses a rule applied to one output and excluded from another', () => {
    const trace: Trace = {
      output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'] },
      outputs: [
        {
          name: 'other',
          type: 'number',
          combine: 'sum',
          status: 'determined',
          value: 0,
          contributors: [],
          pending: [],
        },
      ],
      rules: [{ id: 'A' }],
      steps: [{ ruleId: 'A', subject: '/e/@0', contribution: 1 }],
      skipped: [{ ruleId: 'A', subject: '/e/@1', output: 'other', reason: 'CONDITION_FALSE' }],
    };
    expect(problems(traceProof(trace))).toEqual(['rule feeds two outputs: A@1']);
  });

  it('refuses an exclusion without subject, not grouped, from a per output', () => {
    const trace: Trace = {
      output: { type: 'decimal', combine: 'sum', per: '/e', status: 'determined' },
      rules: [{ id: 'A' }],
      skipped: [{ ruleId: 'A', output: 'value', reason: 'CONDITION_FALSE' }],
    };
    expect(problems(traceProof(trace))).toEqual(['exclusion feeds no item: A@1']);
    const grouped = {
      ...trace,
      skipped: [{ ruleId: 'A', output: 'value', reason: 'INACTIVE_DATE', instances: 2 }],
    };
    expect(problems(traceProof(grouped))).toEqual([]);
  });
});
