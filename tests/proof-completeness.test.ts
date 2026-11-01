import { describe, expect, it } from 'vitest';
import { computeRuleChecksum, sealProof, validateProof, verifyProof } from '../src/index.js';
import type { JsonValue, RuleDefinitionInput, UnsignedProof } from '../src/index.js';
import { entries, ruleA, unsaltedSalt } from './proof-cases.js';
import { outputProof, problems, withEntry, withSection } from './proof-builders.js';
import { traceProof } from './proof-trace.js';
import type { Content, Entry, OutputPart } from './proof-builders.js';

/**
 * A proof of one output `value` fed by `r0`, `r1`… with `contributions` (priority `winner` for
 * `r0`, 0 for the others), and one rule `w@1` of priority `waiting` pending for it (a missing
 * fact).
 */
function withPending(
  output: OutputPart,
  contributions: JsonValue[],
  winner = 0,
  waiting = 0,
): Content {
  const proof: Content = { ...outputProof({ ...output, pending: ['w'] }, contributions) };
  const rules = (proof.rules as Entry[]).map((rule, i) =>
    i === 0 ? { ...rule, priority: winner } : rule,
  );
  const w = { id: 'w', version: 1, checksum: 'b'.repeat(64), ruleSet: 'local', priority: waiting };
  proof.rules = [...rules, w].map((rule, i) => ({ ...rule, salt: unsaltedSalt('rules', i) }));
  proof.pending = [
    {
      ruleId: 'w',
      version: 1,
      output: 'value',
      reason: 'UNDETERMINED',
      detail: 'missing /x',
      missing: ['/x'],
      stratum: 0,
      salt: unsaltedSalt('pending', 0),
    },
  ];
  return proof;
}

describe('completeness (D-7, table of 9M2): a pending rule makes its output undetermined', () => {
  it('refuses an undetermined output without a cause: no pending rule, not an empty all', () => {
    const content = withEntry('outputs', 2, { status: 'undetermined', value: undefined });
    expect(problems(content)).toEqual(['undetermined output without a cause: value']);
  });

  it('refuses an undetermined item without a cause', () => {
    const content = { ...withEntry('items', 1, { pending: [] }), pending: [] };
    expect(problems(content)).toEqual([
      'undetermined output without a cause: kids at /enfants/@c9',
    ]);
  });

  it('an all no rule reached, without empty, is undetermined by itself', () => {
    const all = outputProof({ type: 'boolean', combine: 'all', status: 'undetermined' });
    expect(problems({ ...all })).toEqual([]);
  });

  it('refuses a settled output or item that a pending rule feeds', () => {
    const sum = withPending({ type: 'number', combine: 'sum', value: 1 }, [1]);
    expect(problems(sum)).toEqual(['settled output with pending rules: value']);
    const undetermined = withPending(
      { type: 'number', combine: 'sum', status: 'undetermined' },
      [1],
    );
    expect(problems(undetermined)).toEqual([]);
    const items = withEntry('items', 1, { status: 'determined', value: '0', bounds: undefined });
    const content = {
      ...items,
      outputs: entries('outputs').map((o, i) => (i === 0 ? { ...o, status: 'determined' } : o)),
    };
    expect(problems(content)).toEqual(['settled output with pending rules: kids at /enfants/@c9']);
  });

  it('except an any with a true contribution and an all with a false one', () => {
    const any = (value: boolean, contributions: boolean[]) =>
      withPending({ type: 'boolean', combine: 'any', value }, contributions);
    expect(problems(any(true, [false, true]))).toEqual([]);
    expect(problems(any(false, [false]))).toEqual(['settled output with pending rules: value']);
    const all = (value: boolean, contributions: boolean[]) =>
      withPending({ type: 'boolean', combine: 'all', value }, contributions);
    expect(problems(all(false, [true, false]))).toEqual([]);
    expect(problems(all(true, [true]))).toEqual(['settled output with pending rules: value']);
  });

  it('a highestPriority is settled only when its winner outranks every pending rule', () => {
    const highest: OutputPart = {
      type: 'number',
      combine: 'highestPriority',
      value: 1,
      selected: { ruleId: 'r0' },
    };
    // The priorities are in the proof: sealProof and verifyProof decide without the rules.
    expect(problems(withPending(highest, [1], 5000, 1000))).toEqual([]);
    expect(problems(withPending(highest, [1], -1, -2.5))).toEqual([]);
    for (const [winner, waiting] of [
      [5000, 5000],
      [5000, 6000],
      [0, 0.5],
    ] as const) {
      expect(problems(withPending(highest, [1], winner, waiting))).toEqual([
        'settled output with pending rules: value',
      ]);
    }
    const undetermined = { ...highest, status: 'undetermined' as const };
    delete undetermined.value;
    delete undetermined.selected;
    expect(problems(withPending(undetermined, [1], 5000, 6000))).toEqual([]);
  });

  it('given the rules, each recorded priority is that of its definition', () => {
    const definition = (id: string, priority: number): RuleDefinitionInput => ({
      ...ruleA,
      id,
      priority,
    });
    const highest: OutputPart = {
      type: 'number',
      combine: 'highestPriority',
      value: 1,
      selected: { ruleId: 'r0' },
    };
    const content = withPending(highest, [1], 5000, 1000);
    const proofWith = (rules: RuleDefinitionInput[]) => {
      const listed = (content.rules as Entry[]).map((ref, i) => ({
        ...ref,
        checksum: computeRuleChecksum(rules[i]!),
      }));
      return sealProof({ ...content, rules: listed } as unknown as UnsignedProof);
    };
    const honest = [definition('r0', 5000), definition('w', 1000)];
    expect(verifyProof(proofWith(honest), { rules: honest }).issues).toEqual(['unsigned']);
    // The definition of w says 6000: the proof recorded 1000, which hid its precedence.
    const hidden = [definition('r0', 5000), definition('w', 6000)];
    expect(verifyProof(proofWith(hidden), { rules: hidden })).toEqual({
      status: 'invalid',
      issues: ['unsigned', 'rule priority mismatch: w@1'],
    });
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a text', '1'],
    ['null', null],
  ])('refuses a recorded priority that is %s', (_name, priority) => {
    const content = withEntry('rules', 0, { priority });
    expect(validateProof({ ...content, digest: '0'.repeat(64) }).issues).toEqual([
      { path: 'rules[0].priority', message: 'rules[0].priority must be a finite number' },
    ]);
  });

  it('the priorities enter the digest (vector frozen with an RFC 8785 implementation)', () => {
    // A proof core can produce: r0 (priority 7) wins; r1 (priority -3) applied below it.
    const highest: OutputPart = {
      type: 'number',
      combine: 'highestPriority',
      value: 2,
      contributors: ['r0'],
      selected: { ruleId: 'r0' },
    };
    const content = outputProof(highest, [2, 2]);
    content.rules[0]!.priority = 7;
    content.rules[1]!.priority = -3;
    // sha256 of the RFC 8785 text of the content, by an independent Python implementation of
    // JCS (refrozen in Task 9J round 4: round 3 named the lower rule a contributor).
    const FROZEN = '3770246076f87e5ccc00a90381a7d7f4193d9cd4121f42ab861057d9aadb6d42';
    expect(sealProof(content).digest).toBe(FROZEN);
    content.rules[1]!.priority = -4;
    expect(sealProof(content).digest).not.toBe(FROZEN);
  });

  it('given the rules, a recorded -0 is the priority 0 of a definition', () => {
    const content = outputProof({ type: 'number', combine: 'sum', value: 1 }, [1]);
    const rule: RuleDefinitionInput = { ...ruleA, id: 'r0', priority: 0 };
    content.rules[0] = { ...content.rules[0]!, checksum: computeRuleChecksum(rule), priority: -0 };
    expect(verifyProof(sealProof(content), { rules: [rule] }).issues).toEqual(['unsigned']);
  });

  it('refuses a rule without its priority', () => {
    const content = withEntry('rules', 0, { priority: undefined });
    expect(validateProof({ ...content, digest: '0'.repeat(64) }).issues).toEqual([
      { path: 'rules[0].priority', message: 'rules[0].priority is required' },
    ]);
  });
});

describe('exceptions (D-7): the decisions they affect are at least as strong', () => {
  it('refuses a skip weaker than the exception that inhibited it', () => {
    expect(problems(withEntry('exceptions', 0, { status: 'provisional' }))).toEqual([
      'decision weaker than the exception that affected it: r2@2',
    ]);
  });

  it('an exception at a subject affects the decisions under it only', () => {
    const at = (subject: string, status = 'conflict'): Content =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 0, status: 'conflict' },
        rules: [{ id: 'A' }, { id: 'X' }],
        skipped: [{ ruleId: 'A', subject: '/e/@1', output: 'value', reason: 'INHIBITED', status }],
        exceptions: [
          {
            ruleId: 'X',
            kind: 'inhibit',
            affected: [{ ruleId: 'A', subject }],
            status: 'conflict',
          },
        ],
      });
    expect(problems(at('/e/@1'))).toEqual([]);
    expect(problems(at('/e'))).toEqual([]);
    expect(problems(at('/e/@2'))).toEqual([
      'affected rule not inhibited by X@1: A at /e/@2',
      'inhibited without an exception: A@1 at /e/@1',
    ]);
    expect(problems(at('/e', 'provisional'))).toEqual([
      'output status stronger than its causes: value',
      'decision weaker than the exception that affected it: A@1 at /e/@1',
    ]);
  });

  it('refuses an exception whose status is not that of its carrier applied', () => {
    const carried = {
      ruleId: 'r1',
      version: 1,
      kind: 'inhibit',
      affected: [],
      status: 'provisional',
      stratum: 0,
    };
    const list = [carried, entries('exceptions')[0]!];
    expect(problems(withSection('exceptions', list))).toEqual([
      "exception status differs from its carrier's decision: r1@1",
    ]);
    expect(
      problems(withSection('exceptions', [{ ...carried, status: 'determined' }, list[1]!])),
    ).toEqual([]);
  });
});

describe('items of a per output are the elements of its collection', () => {
  const per = (pattern: string, subject: string): Content => {
    const proof: Content = {
      ...outputProof({ type: 'decimal', combine: 'sum', per: pattern }),
    };
    proof.items = [
      {
        output: 'value',
        subject,
        status: 'determined',
        value: '0',
        contributors: [],
        pending: [],
        salt: unsaltedSalt('items', 0),
      },
    ];
    return proof;
  };

  it.each([
    ['/e', '/e/@1'],
    ['/e', '/e/@~1x'],
    ['/f/*/e', '/f/@a/e/@1'],
  ])('per %s takes %s', (pattern, subject) => {
    expect(problems(per(pattern, subject))).toEqual([]);
  });

  it.each([
    ['/e', '/f/@1'],
    ['/e', '/e'],
    ['/e', '/e/1'],
    ['/e', '/e/@1/x'],
    ['/e', '/e/@1/@2'],
    ['/e', '/e/!group=a'],
    ['/f/*/e', '/f/@a/e'],
    ['/f/*/e', '/f/a/e/@1'],
    ['/f/*/e', '/f/@a/g/@1'],
  ])('per %s refuses %s', (pattern, subject) => {
    expect(problems(per(pattern, subject))).toEqual([
      `item outside its per collection: value at ${subject}`,
    ]);
  });
});

describe('every listed rule is decided (D-8)', () => {
  it('refuses a rule neither applied, skipped, pending nor the carrier of an exception', () => {
    const listed = entries('rules');
    const z = { id: 'z', version: 1, checksum: 'c'.repeat(64), ruleSet: 'local', priority: 0 };
    // After the local rules, before those of the packs.
    const rules = [...listed.slice(0, 4), z, ...listed.slice(4)];
    expect(problems(withSection('rules', rules))).toEqual(['rule not decided: z@1']);
  });

  it('a carrier is decided by its exception', () => {
    expect(entries('exceptions')[0]).toMatchObject({ ruleId: 'x' });
    expect(problems(withSection('exceptions', []))).toContain('rule not decided: x@1');
  });
});
