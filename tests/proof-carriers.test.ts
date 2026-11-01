import { describe, expect, it } from 'vitest';
import { computeRuleChecksum, verifyProof } from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';
import { handSealed } from './helpers.js';
import { problems } from './proof-builders.js';
import type { Entry } from './proof-builders.js';
import { ruleA } from './proof-cases.js';
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

  // R18: a carrier whose condition held fires its exceptions, even when its own computation
  // fails; one whose condition did not hold, or is not known to, fires nothing. Neither the
  // reason nor the cause says which (f17): the pending entry records it (`conditionHeld`).
  const CASES: [string, string][] = [
    ['UNDETERMINED', 'missing /$outputs/y'],
    ['ERROR', 'OUTPUT_MISMATCH: value is NaN'],
    ['ERROR', 'MODEL_ERROR: boom'],
    ['AMBIGUOUS_ORDER', 'tie on orderBy'],
    ['ERROR', 'INVALID_ORDER_VALUE: /e/1/n'],
  ];

  it('a pending carrier whose condition held fired: its exceptions stand', () => {
    for (const [reason, detail] of CASES) {
      const pending = [{ ruleId: 'X', reason, detail, conditionHeld: true }];
      expect(problems(traceProof(inhibition({ pending })))).toEqual([]);
    }
  });

  it('refuses an exception of a pending carrier whose condition did not hold', () => {
    for (const [reason, detail] of CASES) {
      const pending = [{ ruleId: 'X', reason, detail, conditionHeld: false }];
      expect(problems(traceProof(inhibition({ pending })))).toEqual([
        'exception of a pending carrier: X@1',
        'inhibited without an exception: T@1',
      ]);
    }
  });

  it('refuses a pending carrier that does not say whether its condition held', () => {
    const pending = [{ ruleId: 'X', reason: 'UNDETERMINED', detail: 'x' }];
    expect(problems(traceProof(inhibition({ pending })))).toEqual([
      'pending carrier without conditionHeld: X@1',
      'inhibited without an exception: T@1',
    ]);
  });

  /** T pending PENDING_CARRIER behind X, pending for `reason` with `conditionHeld`. */
  const held = (reason: string, detail: string, conditionHeld: boolean): Trace => ({
    output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
    rules: [{ id: 'T' }, { id: 'X' }],
    pending: [
      { ruleId: 'T', output: 'value', reason: 'PENDING_CARRIER', detail: 'carrier X@1' },
      { ruleId: 'X', reason, detail, conditionHeld },
    ],
  });

  it('seals conditionHeld: the digest tells true from false', () => {
    const sealed = handSealed(traceProof(held('UNDETERMINED', 'missing /a', false)));
    expect(verifyProof(sealed).issues).toEqual(['unsigned']);
    const flipped = traceProof(held('UNDETERMINED', 'missing /a', true));
    expect(verifyProof({ ...sealed, pending: flipped.pending }).issues).toEqual([
      'digest mismatch',
      'pending carrier without a pending carrier: T@1',
      'unsigned',
    ]);
  });

  it('a pending carrier whose condition did not hold keeps its targets pending', () => {
    for (const [reason, detail] of CASES) {
      expect(problems(traceProof(held(reason, detail, false)))).toEqual([]);
      // Its condition held: it fired, and holds nothing pending.
      expect(problems(traceProof(held(reason, detail, true)))).toEqual([
        'pending carrier without a pending carrier: T@1',
      ]);
    }
  });

  it('the targets of a pending carrier are pending PENDING_CARRIER (D-8)', () => {
    const trace: Trace = {
      output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
      rules: [{ id: 'T' }, { id: 'X' }],
      pending: [
        { ruleId: 'T', output: 'value', reason: 'PENDING_CARRIER', detail: 'carrier X@1' },
        { ruleId: 'X', reason: 'UNDETERMINED', detail: 'missing /a', conditionHeld: false },
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

describe('given the rules, conditionHeld is on the pending entries of carriers only', () => {
  const plain = (id: string): RuleDefinitionInput => ({ ...ruleA, id });
  const carrier: RuleDefinitionInput = {
    ...ruleA,
    id: 'X',
    exceptions: [{ kind: 'inhibit', targets: { ids: ['T'] } }],
  };
  /** T pending behind X, pending with `conditionHeld` (absent when undefined). */
  function sealed(rules: RuleDefinitionInput[], conditionHeld?: boolean) {
    const x: Entry = { ruleId: 'X', reason: 'UNDETERMINED', detail: 'missing /a' };
    if (conditionHeld !== undefined) x.conditionHeld = conditionHeld;
    const content = traceProof({
      output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
      rules: [
        { id: 'T', priority: 1 },
        { id: 'X', priority: 1 },
      ],
      pending: [
        { ruleId: 'T', output: 'value', reason: 'PENDING_CARRIER', detail: 'carrier X@1' },
        x,
      ],
    });
    const listed = (content.rules as Entry[]).map((ref, i) => ({
      ...ref,
      checksum: computeRuleChecksum(rules[i]!),
    }));
    return handSealed({ ...content, rules: listed });
  }

  it('accepts it on a carrier, refuses it on another rule or its absence on a carrier', () => {
    const honest = [plain('T'), carrier];
    expect(verifyProof(sealed(honest, false), { rules: honest }).issues).toEqual(['unsigned']);
    const none = [plain('T'), plain('X')];
    expect(verifyProof(sealed(none, false), { rules: none }).issues).toEqual([
      'unsigned',
      'conditionHeld on a rule without exceptions: X@1',
    ]);
    expect(verifyProof(sealed(honest), { rules: honest }).issues).toEqual([
      'pending carrier without a pending carrier: T@1',
      'unsigned',
      'conditionHeld missing: X@1',
    ]);
  });
});
