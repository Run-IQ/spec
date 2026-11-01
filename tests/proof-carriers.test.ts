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

/** X, pending for `reason` and `detail` with `fired`, inhibited T: its exception recorded. */
const carrier = (reason: string, detail: string, fired: boolean): Trace =>
  inhibition({ pending: [{ ruleId: 'X', reason, detail, fired }] });

/** T pending PENDING_CARRIER behind X, pending for `reason` and `detail` with `fired`. */
const holder = (reason: string, detail: string, fired: boolean): Trace => ({
  output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
  rules: [{ id: 'T' }, { id: 'X' }],
  pending: [
    { ruleId: 'T', output: 'value', reason: 'PENDING_CARRIER', detail: 'carrier X@1 is pending' },
    { ruleId: 'X', reason, detail, fired },
  ],
});

// R18: a carrier whose condition held fires its exceptions, even when its own computation
// fails. The reason and cause it is pending for say whether it fired for some of them; for the
// others (f17: before or after the condition), and for a cause or reason not known, the
// pending entry says so alone (`fired`).
const FREE: [string, string][] = [
  ['UNDETERMINED', 'missing /$outputs/y'],
  ['ERROR', 'OUTPUT_MISMATCH: value is NaN'],
  ['AMBIGUOUS_ORDER', 'tie on orderBy'],
  ['ERROR', 'INVALID_ORDER_VALUE: /e/1/n'],
  ['ERROR', 'LATER_CAUSE: x'],
  ['LATER_REASON', 'x'],
];
const FIRED: [string, string][] = [
  ['PENDING_DOMINANT', 'dominant D@1 is pending'],
  ['ERROR', 'INVALID_PARAMS: rate'],
  ['ERROR', 'MODEL_ERROR: boom'],
];
const UNFIRED: [string, string][] = [
  ['ERROR', 'DSL_ERROR: bad'],
  ['ERROR', 'TIMEOUT: 50ms'],
  ['ERROR', 'DSL_NOT_FOUND: x'],
  ['ERROR', 'CHECKSUM_MISMATCH: x'],
  ['ERROR', 'INVALID_RULE: x'],
  ['ERROR', 'TEMPORAL_OVERLAP: x'],
  ['ERROR', 'NOT_A_COLLECTION: /x'],
];

describe('which carriers fired: core ExceptionResult, R18, D-8', () => {
  it('refuses an exception of a carrier excluded OUTPUT_MISMATCH: it fired nothing', () => {
    const trace = inhibition({ skipped: [{ ruleId: 'X', reason: 'OUTPUT_MISMATCH' }] });
    expect(problems(traceProof(trace))).toEqual([
      'exception of an excluded carrier: X@1',
      'inhibited without an exception: T@1',
    ]);
  });

  it('a pending carrier that fired keeps its exceptions; one that did not, its targets', () => {
    for (const [reason, detail] of [...FREE, ...FIRED]) {
      expect(problems(traceProof(carrier(reason, detail, true)))).toEqual([]);
    }
    for (const [reason, detail] of [...FREE, ...UNFIRED]) {
      expect(problems(traceProof(holder(reason, detail, false)))).toEqual([]);
    }
  });

  it('refuses an exception of a pending carrier that did not fire', () => {
    for (const [reason, detail] of FREE) {
      expect(problems(traceProof(carrier(reason, detail, false)))).toEqual([
        'exception of a pending carrier: X@1',
        'inhibited without an exception: T@1',
      ]);
    }
  });

  it('refuses a target held by a pending carrier that fired', () => {
    for (const [reason, detail] of FREE) {
      expect(problems(traceProof(holder(reason, detail, true)))).toEqual([
        'pending carrier without a pending carrier: T@1',
      ]);
    }
  });

  it('refuses fired against what the reason says (g1 B, C, C2, C4, D, D2)', () => {
    for (const [reason, detail] of FIRED) {
      expect(problems(traceProof(holder(reason, detail, false)))).toEqual([
        'fired contradicts its reason: X@1',
      ]);
      expect(problems(traceProof(carrier(reason, detail, false)))).toEqual([
        'fired contradicts its reason: X@1',
        'exception of a pending carrier: X@1',
        'inhibited without an exception: T@1',
      ]);
    }
    for (const [reason, detail] of UNFIRED) {
      expect(problems(traceProof(carrier(reason, detail, true)))).toEqual([
        'fired contradicts its reason: X@1',
      ]);
      expect(problems(traceProof(holder(reason, detail, true)))).toEqual([
        'fired contradicts its reason: X@1',
        'pending carrier without a pending carrier: T@1',
      ]);
    }
  });

  it('refuses a carrier pending PENDING_CARRIER that fired (g1 C3)', () => {
    const trace = carrier('PENDING_CARRIER', 'carrier T@1 is pending', true);
    expect(problems(traceProof(trace))).toEqual([
      'fired contradicts its reason: X@1',
      'pending carrier without a pending carrier: X@1',
    ]);
  });

  it('refuses a pending carrier that does not say whether it fired', () => {
    const pending = [{ ruleId: 'X', reason: 'UNDETERMINED', detail: 'x' }];
    expect(problems(traceProof(inhibition({ pending })))).toEqual([
      'pending carrier without fired: X@1',
      'inhibited without an exception: T@1',
    ]);
  });

  it('seals fired: the digest tells true from false', () => {
    const sealed = handSealed(traceProof(holder('UNDETERMINED', 'missing /a', false)));
    expect(verifyProof(sealed).issues).toEqual(['unsigned']);
    const flipped = traceProof(holder('UNDETERMINED', 'missing /a', true));
    expect(verifyProof({ ...sealed, pending: flipped.pending }).issues).toEqual([
      'digest mismatch',
      'pending carrier without a pending carrier: T@1',
      'unsigned',
    ]);
  });
});

/** `entries`, pending on the output `value` (PENDING_CARRIER unless they say otherwise). */
function chain(entries: Entry[]): Trace {
  const ids = [...new Set(entries.map((entry) => String(entry.ruleId)))].sort();
  return {
    output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ids },
    rules: ids.map((id) => ({ id })),
    pending: entries.map((entry) => ({ output: 'value', reason: 'PENDING_CARRIER', ...entry })),
  };
}
const by = (id: string): string => `carrier ${id} is pending`;

describe('PENDING_CARRIER: a chain of pending carriers down to one that did not fire (D-8)', () => {
  it('accepts a target held through a chain of pending carriers (X-12, AI Act 6(3))', () => {
    const trace = chain([
      { ruleId: 'T', detail: by('X@1') },
      { ruleId: 'X', detail: by('Y@1'), fired: false },
      { ruleId: 'Y', reason: 'UNDETERMINED', detail: 'missing /p', fired: false },
    ]);
    expect(problems(traceProof(trace))).toEqual([]);
  });

  it('accepts a carrier named with its subject', () => {
    const trace: Trace = {
      output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
      rules: [{ id: 'T' }, { id: 'X' }],
      pending: [
        { ruleId: 'T', output: 'value', reason: 'PENDING_CARRIER', detail: by('X@1 at /e/1') },
        { ruleId: 'X', subject: '/e/1', reason: 'UNDETERMINED', detail: 'x', fired: false },
      ],
    };
    expect(problems(traceProof(trace))).toEqual([]);
    trace.pending![0]!.detail = by('X@1');
    expect(problems(traceProof(trace))).toEqual(['pending carrier without a pending carrier: T@1']);
  });

  it('reads the carrier named whatever its subject holds', () => {
    for (const subject of ['/e/a is pending', '/e/carrier X@1', '/e/ at /e/1', '/e/~1@:']) {
      const trace: Trace = {
        output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
        rules: [{ id: 'T' }, { id: 'X' }],
        pending: [
          {
            ruleId: 'T',
            output: 'value',
            reason: 'PENDING_CARRIER',
            detail: by(`X@1 at ${subject}`),
          },
          { ruleId: 'X', subject, reason: 'UNDETERMINED', detail: 'x', fired: false },
        ],
      };
      expect(problems(traceProof(trace))).toEqual([]);
      trace.pending![0]!.detail = by(`X@1 at ${subject} `);
      expect(problems(traceProof(trace))).toEqual([
        'pending carrier without a pending carrier: T@1',
      ]);
    }
  });

  it('refuses a target whose detail names no pending carrier that did not fire', () => {
    const named = (detail: string, x?: Entry): string[] =>
      problems(
        traceProof(
          chain([{ ruleId: 'T', detail }, ...(x === undefined ? [] : [{ ruleId: 'X', ...x }])]),
        ),
      );
    const root = { reason: 'UNDETERMINED', detail: 'x', fired: false };
    const refused = ['pending carrier without a pending carrier: T@1'];
    expect(named('x')).toEqual(refused);
    expect(named(by('Z@1'), root)).toEqual(refused);
    expect(named('carrier X@1', root)).toEqual(refused);
    expect(named(by('X@2'), root)).toEqual(refused);
    // X says nothing of its exceptions: not a carrier of the proof.
    expect(named(by('X@1'), { reason: 'UNDETERMINED', detail: 'x' })).toEqual(refused);
    expect(named(by('X@1'), root)).toEqual([]);
  });

  it('refuses a pending carrier as its own source, or in a cycle (g1 A, A0, A2, A3)', () => {
    // A: T holds itself.
    const self = chain([{ ruleId: 'T', detail: by('T@1'), fired: false }]);
    expect(problems(traceProof(self))).toEqual(['pending carrier without a root: T@1']);
    // A0: T holds itself, saying nothing of its exceptions.
    const unsaid = chain([{ ruleId: 'T', detail: by('T@1') }]);
    expect(problems(traceProof(unsaid))).toEqual([
      'pending carrier without a pending carrier: T@1',
    ]);
    // A2: T and X hold each other.
    const mutual = chain([
      { ruleId: 'T', detail: by('X@1'), fired: false },
      { ruleId: 'X', detail: by('T@1'), fired: false },
    ]);
    expect(problems(traceProof(mutual))).toEqual([
      'pending carrier without a root: T@1',
      'pending carrier without a root: X@1',
    ]);
    // A3: X, pending PENDING_CARRIER behind T, holds T.
    const loop = chain([
      { ruleId: 'T', detail: by('X@1') },
      { ruleId: 'X', detail: by('T@1'), fired: false },
    ]);
    expect(problems(traceProof(loop))).toEqual([
      'pending carrier without a root: T@1',
      'pending carrier without a pending carrier: X@1',
    ]);
    // A chain into a cycle has no root either.
    const into = chain([
      { ruleId: 'T', detail: by('X@1') },
      { ruleId: 'X', detail: by('Y@1'), fired: false },
      { ruleId: 'Y', detail: by('X@1'), fired: false },
    ]);
    expect(problems(traceProof(into))).toEqual([
      'pending carrier without a root: T@1',
      'pending carrier without a root: X@1',
      'pending carrier without a root: Y@1',
    ]);
  });
});

describe('given the rules, fired is on the pending entries of carriers only', () => {
  const plain = (id: string): RuleDefinitionInput => ({ ...ruleA, id });
  const definition: RuleDefinitionInput = {
    ...ruleA,
    id: 'X',
    exceptions: [{ kind: 'inhibit', targets: { ids: ['T'] } }],
  };
  /** T pending behind X, pending with `fired` (absent when undefined). */
  function sealed(rules: RuleDefinitionInput[], fired?: boolean) {
    const x: Entry = { ruleId: 'X', reason: 'UNDETERMINED', detail: 'missing /a' };
    if (fired !== undefined) x.fired = fired;
    const content = traceProof({
      output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
      rules: [
        { id: 'T', priority: 1 },
        { id: 'X', priority: 1 },
      ],
      pending: [{ ruleId: 'T', output: 'value', reason: 'PENDING_CARRIER', detail: by('X@1') }, x],
    });
    const listed = (content.rules as Entry[]).map((ref, i) => ({
      ...ref,
      checksum: computeRuleChecksum(rules[i]!),
    }));
    return handSealed({ ...content, rules: listed });
  }

  it('accepts it on a carrier, refuses it on another rule or its absence on a carrier', () => {
    const honest = [plain('T'), definition];
    expect(verifyProof(sealed(honest, false), { rules: honest }).issues).toEqual(['unsigned']);
    const none = [plain('T'), plain('X')];
    expect(verifyProof(sealed(none, false), { rules: none }).issues).toEqual([
      'unsigned',
      'fired on a rule without exceptions: X@1',
    ]);
    expect(verifyProof(sealed(honest), { rules: honest }).issues).toEqual([
      'pending carrier without a pending carrier: T@1',
      'unsigned',
      'fired missing: X@1',
    ]);
  });
});
