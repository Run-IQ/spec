import { describe, expect, it } from 'vitest';
import { computeRuleChecksum, verifyProof } from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';
import { handSealed } from './helpers.js';
import { problems } from './proof-builders.js';
import type { Entry } from './proof-builders.js';
import { ruleA } from './proof-cases.js';
import { traceProof } from './proof-trace.js';
import type { Trace } from './proof-trace.js';
import { withoutDefinitionChecks, withoutUnchecked } from './notices.js';

/** An output of a later stratum, with nothing in it. */
const LATER: Entry = {
  name: 'later',
  type: 'number',
  combine: 'sum',
  value: 0,
  status: 'determined',
  contributors: [],
  pending: [],
};

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

/** The `carrier` link of a rule pending PENDING_CARRIER behind `id` (version 1). */
const of = (id: string, subject?: string): Entry =>
  subject === undefined ? { ruleId: id, version: 1 } : { ruleId: id, version: 1, subject };

/** X, pending for `reason` and `detail` with `fired`, inhibited T: its exception recorded. */
const carrier = (reason: string, detail: string, fired: boolean, link?: Entry): Trace =>
  inhibition({
    pending: [
      { ruleId: 'X', reason, detail, fired, ...(link === undefined ? {} : { carrier: link }) },
    ],
  });

/** T pending PENDING_CARRIER behind X, pending for `reason` and `detail` with `fired`. */
const holder = (reason: string, detail: string, fired: boolean): Trace => ({
  output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
  rules: [{ id: 'T' }, { id: 'X' }],
  pending: [
    { ruleId: 'T', output: 'value', reason: 'PENDING_CARRIER', detail: 'x', carrier: of('X') },
    { ruleId: 'X', reason, detail, fired },
  ],
});

// R18: a carrier whose condition held fires its exceptions, even when its own computation
// fails. The reason and cause it is pending for say whether it fired for some of them; for the
// others (f17: before or after the condition), and for a cause or reason not known, the
// pending entry says so alone (`fired`). A cause is one of ERROR_CAUSES (the validator).
const FREE: [string, string][] = [
  ['UNDETERMINED', 'missing /$outputs/y'],
  ['ERROR', 'OUTPUT_MISMATCH: value is NaN'],
  ['AMBIGUOUS_ORDER', 'tie on orderBy'],
  ['ERROR', 'INVALID_ORDER_VALUE: /e/1/n'],
  ['ERROR', 'TZDATA_UNKNOWN: Europe/X'],
  ['ERROR', 'FUEL_EXHAUSTED: 1000 steps'],
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
  ['ERROR', 'INVALID_GROUP_VALUE: /g'],
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
        'pending carrier fired without its exceptions: X@1',
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
        'pending carrier fired without its exceptions: X@1',
        'pending carrier without a pending carrier: T@1',
      ]);
    }
  });

  it('refuses a carrier pending PENDING_CARRIER that fired (g1 C3)', () => {
    const trace = carrier('PENDING_CARRIER', 'x', true, of('T'));
    expect(problems(traceProof(trace))).toEqual([
      'fired contradicts its reason: X@1',
      'pending carrier without a pending carrier: X@1',
    ]);
  });

  it('a pending carrier that fired records its exceptions, affected possibly empty', () => {
    const fired = (exceptions: Entry[]): Trace => ({
      output: { type: 'number', combine: 'sum', value: 0 },
      rules: [{ id: 'X' }],
      pending: [{ ruleId: 'X', reason: 'UNDETERMINED', detail: 'missing /a', fired: true }],
      exceptions,
    });
    expect(problems(traceProof(fired([{ ruleId: 'X', kind: 'inhibit', affected: [] }])))).toEqual(
      [],
    );
    expect(problems(traceProof(fired([])))).toEqual([
      'pending carrier fired without its exceptions: X@1',
    ]);
    // Its records are its own instance's: another instance's do not count.
    const elsewhere = fired([{ ruleId: 'X', subject: '/e/1', kind: 'inhibit', affected: [] }]);
    expect(problems(traceProof(elsewhere))).toEqual([
      'pending carrier fired without its exceptions: X@1',
    ]);
  });

  it('refuses a decision of a stratum before the exception that affected it', () => {
    const strata = (carrier: number, target: number): Trace => ({
      ...inhibition({
        pending: [
          { ruleId: 'X', reason: 'UNDETERMINED', detail: 'x', fired: true, stratum: carrier },
        ],
      }),
      skipped: [{ ruleId: 'T', output: 'value', reason: 'INHIBITED', stratum: target }],
      exceptions: [{ ruleId: 'X', kind: 'inhibit', affected: [{ ruleId: 'T' }], stratum: carrier }],
      outputs: [LATER],
      strata: [['value'], ['later']],
    });
    expect(problems(traceProof({ ...strata(0, 0), strata: [['later', 'value']] }))).toEqual([]);
    expect(problems(traceProof({ ...strata(1, 0) }))).toEqual([
      'decision before the exception that affected it: T@1',
    ]);
    // A substitution reaches every later decision of its target, and a pending one too.
    const pendingTarget: Trace = {
      ...strata(1, 0),
      output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
      skipped: [],
      pending: [
        { ruleId: 'T', output: 'value', reason: 'UNDETERMINED', detail: 'x', stratum: 0 },
        { ruleId: 'X', reason: 'UNDETERMINED', detail: 'x', fired: true, stratum: 1 },
      ],
      exceptions: [{ ruleId: 'X', kind: 'substitute', affected: [{ ruleId: 'T' }], stratum: 1 }],
    };
    expect(problems(traceProof(pendingTarget))).toEqual([
      'decision before the exception that affected it: T@1',
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
    expect(withoutUnchecked(verifyProof(sealed).issues)).toEqual(['unsigned']);
    const flipped = traceProof(holder('UNDETERMINED', 'missing /a', true));
    expect(verifyProof({ ...sealed, pending: flipped.pending }).issues).toEqual([
      'digest mismatch',
      'pending carrier fired without its exceptions: X@1',
      'pending carrier without a pending carrier: T@1',
      'unsigned',
    ]);
  });
});

/**
 * `entries`, pending on the output `value` unless `output: undefined` (PENDING_CARRIER unless
 * they say otherwise).
 */
function chain(entries: Entry[]): Trace {
  const ids = [...new Set(entries.map((entry) => String(entry.ruleId)))].sort();
  const pending = entries.map((entry) => {
    const full: Entry = { output: 'value', reason: 'PENDING_CARRIER', detail: 'x', ...entry };
    // `output: undefined` leaves the entry without an output.
    if (full.output === undefined) delete full.output;
    return full;
  });
  const feeding = ids.filter((id) => pending.some((e) => e.ruleId === id && 'output' in e));
  return {
    output: { type: 'number', combine: 'sum', status: 'undetermined', pending: feeding },
    rules: ids.map((id) => ({ id })),
    pending,
  };
}
const root = { reason: 'UNDETERMINED', detail: 'missing /p', fired: false };

describe('PENDING_CARRIER: a chain of pending carriers down to one that did not fire (D-8)', () => {
  it('accepts a target held through a chain of pending carriers (X-12, AI Act 6(3))', () => {
    const trace = chain([
      { ruleId: 'T', carrier: of('X') },
      { ruleId: 'X', carrier: of('Y'), fired: false },
      { ruleId: 'Y', ...root },
    ]);
    expect(problems(traceProof(trace))).toEqual([]);
  });

  it('follows carrier, not detail, which stays free text', () => {
    const trace = chain([
      { ruleId: 'T', carrier: of('X'), detail: 'carrier Z@1 is pending' },
      { ruleId: 'X', ...root },
    ]);
    expect(problems(traceProof(trace))).toEqual([]);
  });

  it('reads the carrier named whatever its subject holds', () => {
    const subjects = ['/e/1', '/e/a is pending', '/e/carrier X@1', '/e/ at /e/1', '/e/~1@:'];
    for (const subject of subjects) {
      const trace: Trace = {
        output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
        rules: [{ id: 'T' }, { id: 'X' }],
        pending: [
          { ruleId: 'T', output: 'value', reason: 'PENDING_CARRIER', detail: 'x' },
          { ruleId: 'X', subject, ...root },
        ],
      };
      trace.pending![0]!.carrier = of('X', subject);
      expect(problems(traceProof(trace))).toEqual([]);
      for (const other of [undefined, `${subject} `, `${subject}/0`]) {
        trace.pending![0]!.carrier = of('X', other);
        expect(problems(traceProof(trace))).toEqual([
          'pending carrier without a pending carrier: T@1',
        ]);
      }
    }
  });

  it('refuses a target whose carrier is no pending carrier that did not fire', () => {
    const named = (link: Entry, x?: Entry): string[] =>
      problems(
        traceProof(
          chain([
            { ruleId: 'T', carrier: link },
            ...(x === undefined ? [] : [{ ruleId: 'X', ...x }]),
          ]),
        ),
      );
    const refused = ['pending carrier without a pending carrier: T@1'];
    expect(named(of('Z'), root)).toEqual(refused);
    expect(named({ ruleId: 'X', version: 2 }, root)).toEqual(refused);
    // X says nothing of its exceptions: not a carrier of the proof.
    expect(named(of('X'), { reason: 'UNDETERMINED', detail: 'x' })).toEqual(refused);
    expect(named(of('X'), { ...root, fired: true })).toEqual([
      'pending carrier fired without its exceptions: X@1',
      ...refused,
    ]);
    expect(named(of('X'), root)).toEqual([]);
  });

  it('refuses a pending carrier of a stratum after its target (carrierAfterTarget)', () => {
    const placed = (target: number, carrier: number): Trace => ({
      ...chain([
        { ruleId: 'T', carrier: of('X'), stratum: target },
        { ruleId: 'X', ...root, output: undefined, stratum: carrier },
      ]),
      outputs: [LATER],
      // T's output `value` sits in T's stratum.
      strata: target === 0 ? [['value'], ['later']] : [['later'], ['value']],
    });
    expect(problems(traceProof(placed(1, 0)))).toEqual([]);
    expect(problems(traceProof(placed(0, 1)))).toEqual(['pending carrier after its target: T@1']);
  });

  it("refuses a pending carrier out of its target's scope (D-21)", () => {
    const scoped = (target: string | undefined, carrier: string | undefined): string[] => {
      const t: Entry = { ruleId: 'T', carrier: of('X', carrier) };
      const x: Entry = { ruleId: 'X', ...root, output: undefined };
      if (target !== undefined) t.subject = target;
      if (carrier !== undefined) x.subject = carrier;
      return problems(traceProof(chain([t, x])));
    };
    expect(scoped(undefined, '/e/1')).toEqual([]);
    expect(scoped('/e/1', undefined)).toEqual([]);
    expect(scoped('/e/1', '/e/1')).toEqual([]);
    expect(scoped('/e/1/k/2', '/e/1')).toEqual([]);
    expect(scoped('/e/1', '/e/1/k/2')).toEqual([]);
    expect(scoped('/e/1', '/e/2')).toEqual(['pending carrier out of scope: T@1 at /e/1']);
    expect(scoped('/e/1', '/e/10')).toEqual(['pending carrier out of scope: T@1 at /e/1']);
  });

  it('refuses a pending carrier as its own source, or in a cycle (g1 A, A0, A2, A3)', () => {
    // A: T holds itself.
    const self = chain([{ ruleId: 'T', carrier: of('T'), fired: false }]);
    expect(problems(traceProof(self))).toEqual(['pending carrier without a root: T@1']);
    // A0: T holds itself, saying nothing of its exceptions.
    const unsaid = chain([{ ruleId: 'T', carrier: of('T') }]);
    expect(problems(traceProof(unsaid))).toEqual([
      'pending carrier without a pending carrier: T@1',
    ]);
    // A2: T and X hold each other.
    const mutual = chain([
      { ruleId: 'T', carrier: of('X'), fired: false },
      { ruleId: 'X', carrier: of('T'), fired: false },
    ]);
    expect(problems(traceProof(mutual))).toEqual([
      'pending carrier without a root: T@1',
      'pending carrier without a root: X@1',
    ]);
    // A3: X, pending PENDING_CARRIER behind T, holds T.
    const loop = chain([
      { ruleId: 'T', carrier: of('X') },
      { ruleId: 'X', carrier: of('T'), fired: false },
    ]);
    expect(problems(traceProof(loop))).toEqual([
      'pending carrier without a root: T@1',
      'pending carrier without a pending carrier: X@1',
    ]);
    // A chain into a cycle has no root either.
    const into = chain([
      { ruleId: 'T', carrier: of('X') },
      { ruleId: 'X', carrier: of('Y'), fired: false },
      { ruleId: 'Y', carrier: of('X'), fired: false },
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
      pending: [
        { ruleId: 'T', output: 'value', reason: 'PENDING_CARRIER', detail: 'x', carrier: of('X') },
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
    const honest = [plain('T'), definition];
    expect(
      withoutDefinitionChecks(verifyProof(sealed(honest, false), { rules: honest }).issues),
    ).toEqual(['unsigned']);
    const none = [plain('T'), plain('X')];
    expect(
      withoutDefinitionChecks(verifyProof(sealed(none, false), { rules: none }).issues),
    ).toEqual([
      'unsigned',
      'fired on a rule without exceptions: X@1',
      // X carries no exception: it selects nothing.
      'carrier does not select its target: T@1',
    ]);
    expect(verifyProof(sealed(honest), { rules: honest }).issues).toEqual([
      'pending carrier without a pending carrier: T@1',
      'unsigned',
      'fired missing: X@1',
    ]);
  });
});
