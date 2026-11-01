/**
 * A check computes from more than the entry it names (review of 9K1, round 5): a problem's
 * alternatives are every section whose hidden entry could change the computation behind it, an
 * identity only where that computation fixes it. The ties among exceptions derive from the
 * exclusions `RULE_CONFLICT`, the exceptions before and the standings of their carriers; a
 * problem computed from them is free in those sections while they may be hidden. Where nothing
 * hidden could change it, nothing lifts it.
 */
import { describe, expect, it } from 'vitest';
import { computeRuleChecksum, redactProof, verifyProof } from '../src/index.js';
import type { DecisionProof, ProofSection, RuleDefinitionInput } from '../src/index.js';
import { handSealed } from './helpers.js';
import { everySubset, honestProof, invalidRedactions, placesOf } from './honest-redactions.js';
import type { Content, Entry } from './proof-builders.js';
import { ruleA } from './proof-cases.js';
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

const plainIssues = (content: Content): string[] =>
  verifyProof(handSealed({ ...content, inputSalted: true }) as never).issues;

const liftedOf = (proof: DecisionProof): string[] =>
  (verifyProof(proof).lifted ?? []).map((lift) => lift.check);

/** X and X2 (priority 5) short-circuit `value`: core keeps X, excludes X2 `RULE_CONFLICT`. */
const tie = (status = 'conflict'): Trace => ({
  output: { type: 'number', combine: 'sum', value: 9, contributors: ['X'], status },
  rules: [{ id: 'A' }, { id: 'X', priority: 5 }, { id: 'X2', priority: 5 }],
  steps: [{ ruleId: 'X', contribution: 9 }],
  skipped: [
    { ruleId: 'A', output: 'value', reason: 'SHORT_CIRCUITED' },
    { ruleId: 'X2', reason: 'RULE_CONFLICT', status: 'conflict' },
  ],
  exceptions: [
    { ruleId: 'X', kind: 'shortCircuit', output: 'value', affected: [{ ruleId: 'A' }] },
    { ruleId: 'X2', kind: 'shortCircuit', output: 'value', affected: [], status: 'conflict' },
  ],
});

/** P fired (inhibiting Q); C, after it, would inhibit P and T: discarded (R15). */
const r15 = (status = 'conflict'): Trace => ({
  output: { type: 'number', combine: 'sum', value: 1, contributors: ['T'], status },
  rules: [{ id: 'C', priority: 1 }, { id: 'P', priority: 5 }, { id: 'Q' }, { id: 'T' }],
  steps: [{ ruleId: 'T', contribution: 1 }],
  skipped: [
    { ruleId: 'C', reason: 'RULE_CONFLICT', status: 'conflict' },
    { ruleId: 'Q', output: 'value', reason: 'INHIBITED' },
  ],
  exceptions: [
    { ruleId: 'P', kind: 'inhibit', affected: [{ ruleId: 'Q' }] },
    {
      ruleId: 'C',
      kind: 'inhibit',
      affected: [{ ruleId: 'P' }, { ruleId: 'T' }],
      status: 'conflict',
    },
  ],
});

/** P applied, inhibiting Q. */
const INHIBIT: Trace = {
  output: { type: 'number', combine: 'sum', value: 1, contributors: ['P', 'T'] },
  rules: [{ id: 'P', priority: 5 }, { id: 'Q' }, { id: 'T' }],
  steps: [
    { ruleId: 'P', contribution: 0 },
    { ruleId: 'T', contribution: 1 },
  ],
  skipped: [{ ruleId: 'Q', output: 'value', reason: 'INHIBITED' }],
  exceptions: [{ ruleId: 'P', kind: 'inhibit', affected: [{ ruleId: 'Q' }] }],
};

describe('an honest redaction of ties and exceptions is never refused (round 5, C1)', () => {
  it.each([
    ['a short circuit tie', traceProof(tie()), 9],
    ['an inhibition discarded (R15)', traceProof(r15()), 10],
    ['an inhibition', traceProof(INHIBIT), 8],
  ])('%s: every subset of its entries', (_, content, entries) => {
    const proof = honestProof(content);
    const n = placesOf(proof).length;
    expect(n).toBe(entries);
    expect(invalidRedactions(proof, everySubset(n))).toEqual([]);
  });

  // The smallest redactions the review found refused: what discards X2 is hidden, so the tie
  // cannot be computed, and its missing carrier step is no problem of the proof.
  it.each([[['exceptions:0']], [['rules:1', 'applied:0']], [['applied:0', 'skipped:1']]])(
    'the short circuit tie, %j redacted',
    (places) => {
      const proof = honestProof(traceProof(tie()));
      const redacted = redactProof(proof, (section, i) => places.includes(`${section}:${i}`));
      const result = verifyProof(redacted);
      expect(result.status).toBe('consistent-redacted');
      expect(result.issues).not.toContain('short circuit without its carrier applied: X2@1');
    },
  );
});

describe('the rule and output of one entry, counted together (round 5, C2)', () => {
  /** `value` waits for X, `zother` for X and Y: three pending entries, none visible. */
  const pairs = (): Content => {
    const one = traceProof({
      output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['X'] },
      rules: [{ id: 'X' }, { id: 'Y' }],
    }) as Record<string, unknown[]>;
    const output = one.outputs![0] as Record<string, unknown>;
    return {
      ...one,
      outputs: [output, { ...output, name: 'zother', pending: ['X', 'Y'] }],
      strata: [['value', 'zother']],
    };
  };

  it('three pairs (X, value), (X, zother), (Y, zother) need three pending entries', () => {
    for (const n of [1, 2]) {
      const sections = Array.from({ length: n }, (): ProofSection => 'pending');
      const result = verifyProof(forged(pairs(), ...sections));
      expect(result.status).toBe('invalid');
      expect(result.issues).toContain('pending differ from pending rules: value');
      expect(result.issues).toContain('pending differ from pending rules: zother');
    }
    const three = verifyProof(forged(pairs(), 'pending', 'pending', 'pending'));
    expect(three.status).toBe('consistent-redacted');
    expect(liftedOf(forged(pairs(), 'pending', 'pending', 'pending'))).toContain(
      'pending rules of an output',
    );
  });
});

describe('a free row has a unit where its derivation fixes one (round 5, I1)', () => {
  /** Two sums whose values do not follow from their steps: A feeds `value`, B `zother`. */
  const twoSums = (): Content => {
    const one = traceProof({
      output: { type: 'number', combine: 'sum', value: 999, contributors: ['A'] },
      rules: [{ id: 'A' }, { id: 'B' }],
      steps: [
        { ruleId: 'A', contribution: 1 },
        { ruleId: 'B', contribution: 1, output: 'zother' },
      ],
    }) as Record<string, unknown[]>;
    const output = one.outputs![0] as Record<string, unknown>;
    return {
      ...one,
      outputs: [output, { ...output, name: 'zother', value: 777, contributors: ['B'] }],
      strata: [['value', 'zother']],
    };
  };
  const VALUE = 'output value does not follow from its contributions: value';
  const ZOTHER = 'output value does not follow from its contributions: zother';

  it.each(['rules', 'exceptions', 'applied'] as const)(
    'two outputs off their contributions, one %s marker: refused',
    (section) => {
      expect(plainIssues(twoSums())).toEqual(expect.arrayContaining([VALUE, ZOTHER]));
      const result = verifyProof(forged(twoSums(), section));
      expect(result.status).toBe('invalid');
      expect(result.issues).toEqual(expect.arrayContaining([VALUE, ZOTHER]));
    },
  );

  it.each(['exceptions', 'applied'] as const)(
    'two outputs off their contributions, two %s markers: lifted',
    (section) => {
      const result = verifyProof(forged(twoSums(), section, section));
      expect(result.issues).not.toContain(VALUE);
      expect(result.issues).not.toContain(ZOTHER);
      expect(liftedOf(forged(twoSums(), section, section))).toContain(
        'output value from its contributions',
      );
    },
  );

  it('a sum reads no standing: a rules entry never lifts its value', () => {
    const content = traceProof({
      output: { type: 'number', combine: 'sum', value: 999, contributors: ['A'] },
      rules: [{ id: 'A' }],
      steps: [{ ruleId: 'A', contribution: 1 }],
    });
    for (const n of [1, 2]) {
      const sections = Array.from({ length: n }, (): ProofSection => 'rules');
      const result = verifyProof(forged(content, ...sections));
      expect(result.status).toBe('invalid');
      expect(result.issues).toContain('output value does not follow from its contributions: value');
    }
  });

  it('a sum with a pending rule is settled by nothing hidden', () => {
    const content = traceProof({
      output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'], pending: ['B'] },
      rules: [{ id: 'A' }, { id: 'B' }],
      steps: [{ ruleId: 'A', contribution: 1 }],
      pending: [{ ruleId: 'B', output: 'value', reason: 'UNDETERMINED', detail: 'x' }],
    });
    for (const section of ['rules', 'applied', 'pending'] as const) {
      const result = verifyProof(forged(content, section));
      expect(result.issues).toContain('settled output with pending rules: value');
      expect(liftedOf(forged(content, section))).not.toContain(
        'settled output without pending rules',
      );
    }
  });
});

describe('a check computed from the ties is free while they may be hidden (round 5, C1)', () => {
  const TIE = 'output status weaker than its tie: value';

  it('a tie the visible entries make: lifted by what may undo it, not by the rest', () => {
    for (const content of [traceProof(tie('determined')), traceProof(r15('determined'))]) {
      expect(plainIssues(content)).toContain(TIE);
      expect(verifyProof(forged(content, 'factsRead')).issues).toContain(TIE);
      for (const section of ['skipped', 'exceptions'] as const) {
        expect(verifyProof(forged(content, section)).issues).not.toContain(TIE);
        expect(liftedOf(forged(content, section))).toContain(
          'output status no weaker than its tie',
        );
      }
    }
  });

  it('the standings tie short circuits only', () => {
    const shortCircuits = traceProof(tie('determined'));
    expect(verifyProof(forged(shortCircuits, 'rules')).issues).not.toContain(TIE);
    // Inhibitions are discarded by what fired before, not by standings.
    const inhibitions = traceProof(r15('determined'));
    expect(verifyProof(forged(inhibitions, 'rules')).issues).toContain(TIE);
  });

  it('no exclusion RULE_CONFLICT, none hidden: the ties are known, an exception lifts no cause', () => {
    const content = traceProof({
      output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'], status: 'conflict' },
      rules: [{ id: 'A' }],
      steps: [{ ruleId: 'A', contribution: 1 }],
    });
    const message = 'output status stronger than its causes: value';
    expect(plainIssues(content)).toContain(message);
    const result = verifyProof(forged(content, 'exceptions'));
    expect(result.status).toBe('invalid');
    expect(result.issues).toContain(message);
    // An exclusion of the output may be the cause: one skipped marker lifts it.
    expect(verifyProof(forged(content, 'skipped')).issues).not.toContain(message);
  });

  it('a tie loser recording more than its tie record: lifted by what made it a loser', () => {
    const content = traceProof({
      ...tie(),
      exceptions: [
        ...(tie().exceptions ?? []),
        { ruleId: 'X2', kind: 'inhibit', affected: [], status: 'conflict' },
      ],
    });
    const message = 'tie loser recorded other exceptions: X2@1';
    expect(plainIssues(content)).toContain(message);
    expect(verifyProof(forged(content, 'factsRead')).issues).toContain(message);
    for (const section of ['rules', 'skipped', 'exceptions'] as const) {
      expect(verifyProof(forged(content, section)).issues).not.toContain(message);
      expect(liftedOf(forged(content, section))).toContain('tie records against their carriers');
    }
  });
});

describe('a carrier and its short circuits (round 5, C1)', () => {
  /** X short-circuits `value`, affecting A, without a step: its carrier is missing. */
  const missing = (affected: { ruleId: string }[]): Content =>
    traceProof({
      output: { type: 'number', combine: 'sum', value: 0 },
      rules: [{ id: 'A' }, { id: 'X' }],
      skipped: affected.map(({ ruleId }) => ({
        ruleId,
        output: 'value',
        reason: 'SHORT_CIRCUITED',
      })),
      exceptions: [{ ruleId: 'X', kind: 'shortCircuit', output: 'value', affected }],
    });
  const MISSING = 'short circuit without its carrier applied: X@1';

  it('it affected rules: only its own step explains it, never another short circuit', () => {
    const content = missing([{ ruleId: 'A' }]);
    expect(plainIssues(content)).toContain(MISSING);
    expect(verifyProof(forged(content, 'exceptions')).issues).toContain(MISSING);
    expect(verifyProof(forged(content, 'applied')).issues).not.toContain(MISSING);
  });

  it('it affected nothing: another short circuit of the output, hidden, may have won', () => {
    const content = missing([]);
    expect(plainIssues(content)).toContain(MISSING);
    expect(verifyProof(forged(content, 'exceptions')).issues).not.toContain(MISSING);
    expect(verifyProof(forged(content, 'applied')).issues).not.toContain(MISSING);
  });

  it('the status of an exception against its carrier: one hidden short circuit per carrier', () => {
    // P and P2 applied determined, their inhibitions recorded provisional.
    const content = traceProof({
      output: { type: 'number', combine: 'sum', value: 1, contributors: ['P', 'P2', 'T'] },
      rules: [{ id: 'P' }, { id: 'P2' }, { id: 'Q' }, { id: 'T' }],
      steps: [
        { ruleId: 'P', contribution: 0 },
        { ruleId: 'P2', contribution: 0 },
        { ruleId: 'T', contribution: 1 },
      ],
      skipped: [{ ruleId: 'Q', output: 'value', reason: 'INHIBITED', status: 'provisional' }],
      exceptions: [
        { ruleId: 'P', kind: 'inhibit', affected: [{ ruleId: 'Q' }], status: 'provisional' },
        { ruleId: 'P2', kind: 'inhibit', affected: [{ ruleId: 'Q' }], status: 'provisional' },
      ],
      readsUndeclared: [{ ruleId: 'T' }],
    } as Trace);
    const messages = [
      "exception status differs from its carrier's decision: P@1",
      "exception status differs from its carrier's decision: P2@1",
    ];
    expect(plainIssues(content)).toEqual(expect.arrayContaining(messages));
    const one = verifyProof(forged(content, 'exceptions'));
    expect(one.status).toBe('invalid');
    expect(one.issues).toEqual(expect.arrayContaining(messages));
    const two = verifyProof(forged(content, 'exceptions', 'exceptions'));
    for (const message of messages) expect(two.issues).not.toContain(message);
    expect(liftedOf(forged(content, 'exceptions', 'exceptions'))).toContain(
      'exception status as its carrier decided',
    );
  });
});

describe('each site computed from the ties, in its sections (round 5, mutants)', () => {
  /** A message of `content` reported, then lifted by `lifting` only (`check`), not by factsRead. */
  const liftedBy = (
    content: Content,
    message: string,
    check: string,
    lifting: ProofSection[],
    options: object = {},
  ): void => {
    expect(verifyProof(forged(content), options).issues).toContain(message);
    expect(verifyProof(forged(content, 'factsRead'), options).issues).toContain(message);
    const lifted = verifyProof(forged(content, ...lifting), options);
    expect(lifted.issues).not.toContain(message);
    expect(lifted.lifted?.map((lift) => lift.check)).toContain(check);
  };

  it('a record of a loser whose status differs from its exclusion', () => {
    const trace = tie();
    trace.exceptions = trace.exceptions!.map((e) =>
      e.ruleId === 'X2' ? { ...e, status: 'determined' } : e,
    );
    liftedBy(
      traceProof(trace),
      "exception status differs from its carrier's decision: X2@1",
      'tie records against their carriers',
      ['skipped'],
    );
  });

  it('a discarded short circuit that affected rules', () => {
    const trace = tie();
    trace.exceptions = trace.exceptions!.map((e) =>
      e.ruleId === 'X2' ? { ...e, affected: [{ ruleId: 'A' }] } : e,
    );
    liftedBy(
      traceProof(trace),
      'discarded short circuit affected rules: X2@1',
      'tie records against their carriers',
      ['skipped'],
    );
  });

  it('an exclusion only a discarded inhibition reaches', () => {
    const trace = r15();
    trace.rules = [...trace.rules, { id: 'U' }];
    trace.skipped = [
      ...(trace.skipped ?? []),
      { ruleId: 'U', output: 'value', reason: 'INHIBITED' },
    ];
    trace.exceptions = trace.exceptions!.map((e) =>
      e.ruleId === 'C'
        ? { ...e, affected: [{ ruleId: 'P' }, { ruleId: 'T' }, { ruleId: 'U' }] }
        : e,
    );
    liftedBy(
      traceProof(trace),
      'inhibited without an exception: U@1',
      'exclusion with its exception',
      ['skipped'],
    );
  });

  it('a rule a short circuit affected, decided nowhere: the standings of the tie', () => {
    const trace = tie();
    trace.skipped = trace.skipped!.filter((skip) => skip.ruleId !== 'A');
    liftedBy(
      traceProof(trace),
      'affected rule not short-circuited by X@1: A',
      'rules an exception affected',
      ['rules'],
    );
  });

  it('a short circuit that affected nothing, its carrier missing, the ties maybe hidden', () => {
    const content = traceProof({
      output: { type: 'number', combine: 'sum', value: 0 },
      rules: [{ id: 'B' }, { id: 'X' }],
      skipped: [{ ruleId: 'B', reason: 'RULE_CONFLICT', status: 'conflict' }],
      exceptions: [{ ruleId: 'X', kind: 'shortCircuit', output: 'value', affected: [] }],
    });
    liftedBy(
      content,
      'short circuit without its carrier applied: X@1',
      'short circuit with its carrier applied',
      ['skipped'],
    );
  });

  it('the carrier records against definitions: who lost depends on the standings', () => {
    const definitions = [
      { ...ruleA, id: 'A' },
      {
        ...ruleA,
        id: 'X',
        exceptions: [
          { kind: 'shortCircuit', output: 'value', value: 9 },
          { kind: 'inhibit', targets: { ids: ['Z'] } },
        ],
      },
      { ...ruleA, id: 'X2', exceptions: [{ kind: 'shortCircuit', output: 'value', value: 9 }] },
    ] as RuleDefinitionInput[];
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    const content = traceProof(tie());
    const rules = (content.rules as Entry[]).map((ref) => ({
      ...ref,
      checksum: computeRuleChecksum(byId.get(String(ref.id))!),
    }));
    liftedBy(
      { ...content, rules },
      'carrier exceptions differ from its definition: X@1',
      'carrier exception records against definitions',
      ['rules'],
      { rules: definitions },
    );
  });

  it('the sections that lifted a tie: a hidden exception may be a short circuit, with standings', () => {
    const result = verifyProof(forged(traceProof(r15('determined')), 'rules', 'exceptions'));
    expect(result.lifted).toEqual([
      { check: 'output status no weaker than its tie', redacted: ['rules', 'exceptions'] },
    ]);
  });
});

describe('carriers and settled outputs, their identities (round 5, mutants)', () => {
  it('a carrier that affected rules is missing even when another short circuit won', () => {
    const content = traceProof({
      output: { type: 'number', combine: 'sum', value: 5, contributors: ['W'] },
      rules: [{ id: 'A' }, { id: 'W', priority: 9 }, { id: 'X' }],
      steps: [{ ruleId: 'W', contribution: 5 }],
      skipped: [{ ruleId: 'A', output: 'value', reason: 'SHORT_CIRCUITED' }],
      exceptions: [
        { ruleId: 'W', kind: 'shortCircuit', output: 'value', affected: [] },
        { ruleId: 'X', kind: 'shortCircuit', output: 'value', affected: [{ ruleId: 'A' }] },
      ],
    });
    expect(plainIssues(content)).toContain('short circuit without its carrier applied: X@1');
  });

  it('two instances of a carrier need two steps', () => {
    const at = (subject: string) => ({
      ruleId: 'X',
      subject,
      kind: 'shortCircuit',
      output: 'value',
      affected: [{ ruleId: 'A' }],
    });
    const content = traceProof({
      output: { type: 'number', combine: 'sum', value: 0 },
      rules: [{ id: 'A' }, { id: 'X' }],
      skipped: [{ ruleId: 'A', output: 'value', reason: 'SHORT_CIRCUITED' }],
      exceptions: [at('/e/@1'), at('/e/@2')],
    } as Trace);
    const messages = [
      'short circuit without its carrier applied: X@1 at /e/@1',
      'short circuit without its carrier applied: X@1 at /e/@2',
    ];
    const one = verifyProof(forged(content, 'applied'));
    expect(one.issues).toEqual(expect.arrayContaining(messages));
    const two = verifyProof(forged(content, 'applied', 'applied'));
    for (const message of messages) expect(two.issues).not.toContain(message);
  });

  it('an all without a false, pending: a hidden false step settles it', () => {
    const content = traceProof({
      output: {
        type: 'boolean',
        combine: 'all',
        value: true,
        contributors: ['A'],
        pending: ['B'],
      },
      rules: [{ id: 'A' }, { id: 'B' }],
      steps: [{ ruleId: 'A', contribution: true }],
      pending: [{ ruleId: 'B', output: 'value', reason: 'UNDETERMINED', detail: 'x' }],
    });
    expect(plainIssues(content)).toContain('settled output with pending rules: value');
    expect(verifyProof(forged(content, 'applied')).status).toBe('consistent-redacted');
  });
});
