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

  // R18: a carrier whose condition is true fires its exceptions, even when its own
  // computation fails; one whose condition is not known to be true fires nothing.
  const FIRED: [string, string][] = [
    ['ERROR', 'INVALID_PARAMS: rate'],
    ['ERROR', 'MODEL_ERROR: division by zero'],
    ['ERROR', 'INVALID_ORDER_VALUE: /e/@a'],
    ['AMBIGUOUS_ORDER', 'rank 0 tied'],
    ['PENDING_DOMINANT', 'dominant A@1 is pending'],
  ];
  const UNFIRED: [string, string][] = [
    ['UNDETERMINED', 'missing /a'],
    ['PENDING_CARRIER', 'carrier Y@1 is pending'],
    ['ERROR', 'DSL_ERROR: boom'],
    ['ERROR', 'TIMEOUT: 50 ms'],
    ['ERROR', 'DSL_NOT_FOUND: jsonlogic'],
    ['ERROR', 'CHECKSUM_MISMATCH: x'],
    ['ERROR', 'INVALID_RULE: x'],
    ['ERROR', 'NOT_A_COLLECTION: /e'],
    ['ERROR', 'TEMPORAL_OVERLAP: R@1, R@2'],
    ['ERROR', 'OUTPUT_MISMATCH: two declarations'],
    ['ERROR', 'FUTURE_CAUSE: x'],
    ['FUTURE_REASON', 'x'],
  ];

  it('a carrier pending after its condition held, in its own computation, fired (R18)', () => {
    for (const [reason, detail] of FIRED) {
      const pending = [{ ruleId: 'X', reason, detail }];
      expect(problems(traceProof(inhibition({ pending })))).toEqual([]);
    }
  });

  it('refuses an exception of a carrier pending before its condition held, or stopped', () => {
    for (const [reason, detail] of UNFIRED) {
      const pending = [{ ruleId: 'X', reason, detail }];
      // A carrier kept pending by another needs that one in the proof.
      const held =
        reason === 'PENDING_CARRIER' ? ['pending carrier without a pending carrier: X@1'] : [];
      expect(problems(traceProof(inhibition({ pending })))).toEqual([
        'exception of a pending carrier: X@1',
        ...held,
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
