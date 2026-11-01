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
  const content = traceProof({ ...trace, rules: trace.rules.map((r) => ({ ...r, priority: 1 })) });
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
