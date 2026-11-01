import { describe, expect, it } from 'vitest';
import { computeRuleChecksum, verifyProof } from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';
import { handSealed } from './helpers.js';
import type { Entry } from './proof-builders.js';
import { ruleA } from './proof-cases.js';
import { traceProof } from './proof-trace.js';
import type { Trace } from './proof-trace.js';

// With `rules`, the definitions say which rules a carrier targets (`matchesSelector`, as core
// resolves targets statically) and which exceptions it carries.

/** A rule `id` of `ruleA`'s model and priority, with `extra`. */
const rule = (id: string, extra: Partial<RuleDefinitionInput> = {}): RuleDefinitionInput => ({
  ...ruleA,
  id,
  ...extra,
});
const inhibits = (ids: string[]): Partial<RuleDefinitionInput> => ({
  exceptions: [{ kind: 'inhibit', targets: { ids } }],
});

/** What `verifyProof` with `definitions` finds in the proof of `trace`, sealed by hand. */
function issues(trace: Trace, definitions: RuleDefinitionInput[]): string[] {
  const rules = trace.rules.map((r) => ({ ...r, priority: r.priority ?? 1 }));
  const content = traceProof({ ...trace, rules });
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const listed = (content.rules as Entry[]).map((ref) => ({
    ...ref,
    checksum: computeRuleChecksum(byId.get(String(ref.id))!),
  }));
  return verifyProof(handSealed({ ...content, rules: listed }), { rules: definitions }).issues;
}

const root = { ruleId: 'X', reason: 'UNDETERMINED', detail: 'missing /a', fired: false };

/** T pending PENDING_CARRIER behind X, pending without firing. */
const held: Trace = {
  output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
  rules: [{ id: 'T' }, { id: 'X' }],
  pending: [
    {
      ruleId: 'T',
      output: 'value',
      reason: 'PENDING_CARRIER',
      detail: 'x',
      carrier: { ruleId: 'X', version: 1 },
    },
    root,
  ],
};

describe('given the rules, a pending carrier selects its pending targets', () => {
  it('accepts a target its carrier selects, by id, tag or substitution', () => {
    expect(issues(held, [rule('T'), rule('X', inhibits(['T']))])).toEqual(['unsigned']);
    const byTag = rule('X', { exceptions: [{ kind: 'inhibit', targets: { tags: ['vat'] } }] });
    expect(issues(held, [rule('T', { tags: ['vat'] }), byTag])).toEqual(['unsigned']);
    const substitutes = rule('X', {
      exceptions: [{ kind: 'substitute', targets: { ids: ['T'] }, params: {} }],
    });
    expect(issues(held, [rule('T'), substitutes])).toEqual(['unsigned']);
  });

  it('refuses a target its carrier does not select', () => {
    const refused = ['unsigned', 'carrier does not select its target: T@1'];
    expect(issues(held, [rule('T'), rule('X', inhibits(['U']))])).toEqual(refused);
    const byTag = rule('X', { exceptions: [{ kind: 'inhibit', targets: { tags: ['vat'] } }] });
    expect(issues(held, [rule('T', { tags: ['b'] }), byTag])).toEqual(refused);
    // A short circuit targets an output, never a rule: it holds nothing pending.
    const shortCircuit = rule('X', {
      exceptions: [{ kind: 'shortCircuit', output: 'value', value: 0 }],
    });
    expect(issues(held, [rule('T'), shortCircuit])).toEqual(refused);
  });
});

describe('given the rules, the targets of a carrier that did not fire wait for it', () => {
  const definitions = [rule('T'), rule('X', inhibits(['T']))];
  /** X pending without firing; T decided by `decision`. */
  const decided = (decision: Partial<Trace>): Trace => ({
    output: { type: 'number', combine: 'sum', value: 0 },
    rules: [{ id: 'T' }, { id: 'X' }],
    pending: [root],
    ...decision,
  });
  const refused = ['unsigned', 'target decided as if its carrier were not pending: T@1'];

  it('refuses a target applied, or excluded after the exceptions', () => {
    const applied = decided({
      output: { type: 'number', combine: 'sum', value: 1, contributors: ['T'] },
      steps: [{ ruleId: 'T', contribution: 1 }],
    });
    expect(issues(applied, definitions)).toEqual(refused);
    const invalid = decided({
      skipped: [{ ruleId: 'T', output: 'value', reason: 'INVALID_PARAMS' }],
    });
    expect(issues(invalid, definitions)).toEqual(refused);
  });

  it('accepts a target excluded before the exceptions, pending, or reached by another', () => {
    const before = decided({
      skipped: [{ ruleId: 'T', output: 'value', reason: 'CONDITION_FALSE' }],
    });
    expect(issues(before, definitions)).toEqual(['unsigned']);
    const pending = decided({
      output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
      pending: [{ ruleId: 'T', output: 'value', reason: 'UNDETERMINED', detail: 'x' }, root],
    });
    expect(issues(pending, definitions)).toEqual(['unsigned']);
    // Y, applied, inhibited T: X waiting changes nothing.
    const inhibited = decided({
      output: { type: 'number', combine: 'sum', value: 0, contributors: ['Y'] },
      rules: [{ id: 'T' }, { id: 'X' }, { id: 'Y' }],
      steps: [{ ruleId: 'Y', contribution: 0 }],
      skipped: [{ ruleId: 'T', output: 'value', reason: 'INHIBITED' }],
      exceptions: [{ ruleId: 'Y', kind: 'inhibit', affected: [{ ruleId: 'T' }] }],
    });
    expect(issues(inhibited, [...definitions, rule('Y', inhibits(['T']))])).toEqual(['unsigned']);
  });

  it('finds the target through each field a selector names, confirmed on every field', () => {
    const target = rule('T', { tags: ['vat'], dimensions: { country: 'TG' } });
    const applied = decided({
      output: { type: 'number', combine: 'sum', value: 1, contributors: ['T'] },
      steps: [{ ruleId: 'T', contribution: 1 }],
    });
    const selecting = [
      { ids: ['T'] },
      { tags: ['b', 'vat'] },
      { outputs: ['value'] },
      { models: [ruleA.model] },
      { dimensions: { country: 'TG' } },
      { ids: ['U', 'T'], tags: ['vat'], models: [ruleA.model] },
    ];
    for (const targets of selecting) {
      const carrier = rule('X', { exceptions: [{ kind: 'inhibit', targets }] });
      expect(issues(applied, [target, carrier])).toEqual(refused);
    }
    const missing = [
      { ids: ['U'] },
      { tags: ['vat'], models: ['OTHER'] },
      { outputs: ['other'] },
      { dimensions: { country: 'FR' } },
      { dimensions: { country: 'TG', regime: 'A' } },
      { tags: ['vat'], ruleSets: ['pack'] },
    ];
    for (const targets of missing) {
      const carrier = rule('X', { exceptions: [{ kind: 'inhibit', targets }] });
      expect(issues(applied, [target, carrier])).toEqual(['unsigned']);
    }
  });

  /** Y, applied, substituted T at `/e/2`, then T applied there; X pending at `subject`. */
  const substituted = (subject: string): Trace =>
    decided({
      output: { type: 'number', combine: 'sum', value: 2, contributors: ['T', 'Y'] },
      rules: [{ id: 'T' }, { id: 'X' }, { id: 'Y' }],
      steps: [
        { ruleId: 'T', subject: '/e/2', contribution: 1 },
        { ruleId: 'Y', contribution: 1 },
      ],
      pending: [{ ...root, subject }],
      exceptions: [
        { ruleId: 'Y', kind: 'substitute', affected: [{ ruleId: 'T', subject: '/e/2' }] },
      ],
    });
  const substitutes = rule('Y', {
    exceptions: [{ kind: 'substitute', targets: { ids: ['T'] }, params: {} }],
  });

  it('refuses a target substituted by another: a substitution does not decide it', () => {
    expect(issues(substituted('/e/2'), [...definitions, substitutes])).toEqual([
      'unsigned',
      'target decided as if its carrier were not pending: T@1 at /e/2',
    ]);
  });

  it('accepts a target substituted by another outside the waiting scope', () => {
    expect(issues(substituted('/e/1'), [...definitions, substitutes])).toEqual(['unsigned']);
  });

  it("judges only the target instances in the carrier's scope (D-21)", () => {
    const scoped = (subject: string): Trace =>
      decided({
        output: { type: 'number', combine: 'sum', value: 1, contributors: ['T'] },
        steps: [{ ruleId: 'T', subject: '/e/2', contribution: 1 }],
        pending: [{ ...root, subject }],
      });
    expect(issues(scoped('/e/1'), definitions)).toEqual(['unsigned']);
    const atTwo = ['unsigned', 'target decided as if its carrier were not pending: T@1 at /e/2'];
    expect(issues(scoped('/e/2'), definitions)).toEqual(atTwo);
    expect(issues(scoped('/e'), definitions)).toEqual(atTwo);
  });
});

describe('given the rules, a carrier that fired records exactly its exceptions', () => {
  it('an applied carrier records each exception it carries', () => {
    const applied = (exceptions: Entry[]): Trace => ({
      output: { type: 'number', combine: 'sum', value: 0, contributors: ['Y'] },
      rules: [{ id: 'Y' }],
      steps: [{ ruleId: 'Y', contribution: 0 }],
      exceptions,
    });
    const definitions = [rule('Y', inhibits(['Z']))];
    const inhibit = { ruleId: 'Y', kind: 'inhibit', affected: [] };
    expect(issues(applied([inhibit]), definitions)).toEqual(['unsigned']);
    const refused = ['unsigned', 'carrier exceptions differ from its definition: Y@1'];
    expect(issues(applied([]), definitions)).toEqual(refused);
    expect(issues(applied([inhibit, inhibit]), definitions)).toEqual(refused);
    // A rule without exceptions records none.
    expect(issues(applied([inhibit]), [rule('Y')])).toEqual(refused);
  });

  it('a pending carrier that fired records each exception it carries', () => {
    const fired = (kinds: string[]): Trace => ({
      output: { type: 'number', combine: 'sum', value: 0 },
      rules: [{ id: 'X' }],
      pending: [{ ...root, fired: true }],
      exceptions: kinds.map((kind) => ({ ruleId: 'X', kind, affected: [] })),
    });
    const both = rule('X', {
      exceptions: [
        { kind: 'inhibit', targets: { ids: ['Z'] } },
        { kind: 'substitute', targets: { ids: ['Z'] }, params: {} },
      ],
    });
    expect(issues(fired(['inhibit', 'substitute']), [both])).toEqual(['unsigned']);
    expect(issues(fired(['substitute', 'inhibit']), [both])).toEqual(['unsigned']);
    expect(issues(fired(['inhibit']), [both])).toEqual([
      'unsigned',
      'carrier exceptions differ from its definition: X@1',
    ]);
    expect(issues(fired(['inhibit', 'inhibit']), [both])).toEqual([
      'unsigned',
      'carrier exceptions differ from its definition: X@1',
    ]);
  });
});

describe('given the rules, a carrier imposing its own step records exactly its exceptions', () => {
  /** Y short-circuits `value` with its own step (imposed) and records `records`. */
  const imposing = (records: Entry[]): Trace => ({
    output: { type: 'number', combine: 'sum', value: 9, contributors: ['Y'] },
    rules: [{ id: 'Y', priority: 9 }],
    steps: [{ ruleId: 'Y', contribution: 9 }],
    exceptions: records,
  });
  const definitions = [
    rule('Y', {
      priority: 9,
      exceptions: [
        { kind: 'shortCircuit', output: 'value', value: 9 },
        { kind: 'inhibit', targets: { ids: ['Z'] } },
      ],
    }),
  ];
  const shortCircuit = { ruleId: 'Y', kind: 'shortCircuit', output: 'value', affected: [] };
  const inhibit = { ruleId: 'Y', kind: 'inhibit', affected: [] };
  const refused = ['unsigned', 'carrier exceptions differ from its definition: Y@1'];

  it('accepts each exception recorded once', () => {
    expect(issues(imposing([shortCircuit, inhibit]), definitions)).toEqual(['unsigned']);
  });

  it('refuses a missing or an extra record', () => {
    expect(issues(imposing([shortCircuit]), definitions)).toEqual(refused);
    const extra = { ruleId: 'Y', kind: 'substitute', affected: [] };
    expect(issues(imposing([shortCircuit, inhibit, extra]), definitions)).toEqual(refused);
  });
});

describe('given the rules, an excluded carrier that fired records exactly its exceptions', () => {
  const definitions = [rule('Y', inhibits(['Z']))];
  /** Y excluded for `reason`, recording `records` inhibitions affecting nothing. */
  const excluded = (reason: string, records: number): Trace => ({
    output: { type: 'number', combine: 'sum', value: 0 },
    rules: [{ id: 'Y' }],
    skipped: [{ ruleId: 'Y', output: 'value', reason }],
    exceptions: Array.from({ length: records }, () => ({
      ruleId: 'Y',
      kind: 'inhibit',
      affected: [],
    })),
  });
  const refused = ['unsigned', 'carrier exceptions differ from its definition: Y@1'];

  it('one excluded after its exceptions ran fired them all', () => {
    for (const reason of ['INVALID_PARAMS', 'DOMINATED', 'LATER_REASON']) {
      expect(issues(excluded(reason, 1), definitions)).toEqual(['unsigned']);
      expect(issues(excluded(reason, 0), definitions)).toEqual(refused);
      expect(issues(excluded(reason, 2), definitions)).toEqual(refused);
    }
  });

  it('one excluded before them fired nothing: it records nothing', () => {
    expect(issues(excluded('CONDITION_FALSE', 0), definitions)).toEqual(['unsigned']);
  });

  /** P (priority 5) inhibited Q; C, after it, would inhibit P and T: discarded (R15). */
  const tie: Trace = {
    output: { type: 'number', combine: 'sum', value: 1, contributors: ['T'], status: 'conflict' },
    rules: [{ id: 'C', priority: 1 }, { id: 'P', priority: 5 }, { id: 'Q' }, { id: 'T' }],
    steps: [{ ruleId: 'T', contribution: 1, status: 'conflict' }],
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
  };
  const others = [rule('P', { priority: 5, ...inhibits(['Q']) }), rule('Q'), rule('T')];

  it('a tie loser records its tie record only, of a kind it carries', () => {
    const carries = rule('C', {
      exceptions: [
        { kind: 'inhibit', targets: { ids: ['P', 'T'] } },
        { kind: 'substitute', targets: { ids: ['T'] }, params: {} },
      ],
    });
    expect(issues(tie, [carries, ...others])).toEqual(['unsigned']);
    const substitutes = rule('C', {
      exceptions: [{ kind: 'substitute', targets: { ids: ['P', 'T'] }, params: {} }],
    });
    expect(issues(tie, [substitutes, ...others])).toEqual([
      'unsigned',
      'carrier exceptions differ from its definition: C@1',
    ]);
  });
});
