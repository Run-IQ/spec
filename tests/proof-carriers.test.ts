import { describe, expect, it } from 'vitest';
import { problems } from './proof-builders.js';
import { traceProof } from './proof-trace.js';
import type { Trace } from './proof-trace.js';

/** X inhibits T; X is decided by `decision` (a skip or a pending entry of X). */
function inhibition(decision: { skipped?: Trace['skipped']; pending?: Trace['pending'] }): Trace {
  return {
    output: { type: 'number', combine: 'sum', value: 0 },
    rules: [{ id: 'T' }, { id: 'X' }],
    skipped: [{ ruleId: 'T', output: 'value', reason: 'INHIBITED' }, ...(decision.skipped ?? [])],
    pending: decision.pending ?? [],
    exceptions: [{ ruleId: 'X', kind: 'inhibit', affected: [{ ruleId: 'T' }] }],
  };
}

describe('which carriers fired: core ExceptionResult, R18, D-8', () => {
  it('refuses an exception of a carrier excluded OUTPUT_MISMATCH: it fired nothing', () => {
    const trace = inhibition({ skipped: [{ ruleId: 'X', reason: 'OUTPUT_MISMATCH' }] });
    expect(problems(traceProof(trace))).toEqual([
      'exception of an excluded carrier: X@1',
      'inhibited without an exception: T@1',
    ]);
  });

  it('a carrier pending ERROR on its own parameters fired (R18)', () => {
    const pending = [{ ruleId: 'X', reason: 'ERROR', detail: 'INVALID_PARAMS: rate' }];
    expect(problems(traceProof(inhibition({ pending })))).toEqual([]);
  });

  it('refuses an exception of a carrier pending otherwise: it fired nothing', () => {
    const cases: [string, string][] = [
      ['ERROR', 'OUTPUT_MISMATCH: two declarations'],
      ['ERROR', 'DSL_ERROR: boom'],
      ['UNDETERMINED', 'missing /a'],
    ];
    for (const [reason, detail] of cases) {
      const pending = [{ ruleId: 'X', reason, detail }];
      expect(problems(traceProof(inhibition({ pending })))).toEqual([
        'exception of a pending carrier: X@1',
        'inhibited without an exception: T@1',
      ]);
    }
  });

  it('the targets of a pending carrier are pending PENDING_CARRIER (D-8)', () => {
    const trace: Trace = {
      output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
      rules: [{ id: 'T' }, { id: 'X' }],
      pending: [
        { ruleId: 'T', output: 'value', reason: 'PENDING_CARRIER', detail: 'carrier X@1' },
        { ruleId: 'X', reason: 'UNDETERMINED', detail: 'missing /a' },
      ],
    };
    expect(problems(traceProof(trace))).toEqual([]);
    // No carrier is pending: nothing kept T pending so.
    const alone: Trace = {
      ...trace,
      rules: [{ id: 'T' }],
      pending: [{ ruleId: 'T', output: 'value', reason: 'PENDING_CARRIER', detail: 'x' }],
    };
    expect(problems(traceProof(alone))).toEqual(['pending carrier without a pending carrier: T@1']);
    // A carrier pending on its own parameters fired: it keeps nothing pending.
    const fired: Trace = {
      ...trace,
      pending: [
        { ruleId: 'T', output: 'value', reason: 'PENDING_CARRIER', detail: 'carrier X@1' },
        { ruleId: 'X', reason: 'ERROR', detail: 'INVALID_PARAMS: rate' },
      ],
    };
    expect(problems(traceProof(fired))).toEqual(['pending carrier without a pending carrier: T@1']);
  });
});
