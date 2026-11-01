import { describe, expect, it } from 'vitest';
import { computeRuleChecksum, sealProof, verifyProof } from '../src/index.js';
import type { JsonValue, RuleDefinitionInput, UnsignedProof } from '../src/index.js';
import { entries, ruleA, unsaltedSalt } from './proof-cases.js';
import { outputProof, problems, withEntry, withSection } from './proof-builders.js';
import type { Content, Entry, OutputPart } from './proof-builders.js';

/**
 * A proof of one output `value` fed by `r0`, `r1`… with `contributions`, and one rule `w@1`
 * pending for it (a missing fact).
 */
function withPending(output: OutputPart, contributions: JsonValue[]): Content {
  const proof: Content = { ...outputProof({ ...output, pending: ['w'] }, contributions) };
  const rules = proof.rules as Entry[];
  const w = { id: 'w', version: 1, checksum: 'b'.repeat(64), ruleSet: 'local' };
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
    const content = withPending(
      { type: 'number', combine: 'highestPriority', value: 1, selected: { ruleId: 'r0' } },
      [1],
    );
    // Without the definitions, the priorities are unknown: sealProof cannot tell.
    expect(problems(content)).toEqual([]);
    const definition = (id: string, priority: number): RuleDefinitionInput => ({
      ...ruleA,
      id,
      priority,
    });
    const proofWith = (winner: number, pending: number) => {
      const rules = [definition('r0', winner), definition('w', pending)];
      const listed = (content.rules as Entry[]).map((ref, i) => ({
        ...ref,
        checksum: computeRuleChecksum(rules[i]!),
      }));
      return { proof: sealProof({ ...content, rules: listed } as unknown as UnsignedProof), rules };
    };
    const above = proofWith(5000, 1000);
    expect(verifyProof(above.proof, { rules: above.rules }).issues).toEqual(['unsigned']);
    for (const pending of [5000, 6000]) {
      const tied = proofWith(5000, pending);
      expect(verifyProof(tied.proof, { rules: tied.rules })).toEqual({
        status: 'invalid',
        issues: ['unsigned', 'settled output with pending rules: value'],
      });
    }
  });
});

describe('exceptions (D-7): the decisions they affect are at least as strong', () => {
  it('refuses a skip weaker than the exception that inhibited it', () => {
    expect(problems(withEntry('exceptions', 0, { status: 'provisional' }))).toEqual([
      'decision weaker than the exception that affected it: r2@2',
    ]);
  });

  it('an exception at a subject affects the decisions under it only', () => {
    const exception = { ...entries('exceptions')[0], status: 'conflict' };
    const at = (subject: string): Content =>
      withSection('exceptions', [{ ...exception, affected: [{ ruleId: 'k', subject }] }]);
    expect(problems(at('/enfants/@a7'))).toEqual([
      'decision weaker than the exception that affected it: k@1 at /enfants/@a7',
    ]);
    expect(problems(at('/enfants'))).toEqual([
      'decision weaker than the exception that affected it: k@1 at /enfants/@a7',
    ]);
    expect(problems(at('/enfants/@b1'))).toEqual([]);
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
    const z = { id: 'z', version: 1, checksum: 'c'.repeat(64), ruleSet: 'local' };
    // After the local rules, before those of the packs.
    const rules = [...listed.slice(0, 4), z, ...listed.slice(4)];
    expect(problems(withSection('rules', rules))).toEqual(['rule not decided: z@1']);
  });

  it('a carrier is decided by its exception', () => {
    expect(entries('exceptions')[0]).toMatchObject({ ruleId: 'x' });
    expect(problems(withSection('exceptions', []))).toContain('rule not decided: x@1');
  });
});
