/**
 * Task 9K5, the proof side: `verifyProof` says what it did not check (I10), refuses what the rule
 * definitions contradict without any execution (I11), and refuses a broken trust anchor (M1).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  normalizeRuleDefinition,
  sealProof,
  signProof,
  verifyProof,
} from '../src/index.js';
import { definitionFindings } from '../src/proof/definition-checks.js';
import type { RuleDefinitionInput } from '../src/index.js';
import type { ProofView } from '../src/proof/types.js';
import {
  RFC_SECRET,
  ruleA,
  ruleB,
  RULES,
  signed,
  TRUSTED,
  unsalted,
  unsigned,
} from './proof-cases.js';

const RULES_NOT_CHECKED =
  'rules not checked: pass rules to compare checksums, priorities and carriers';
const NOT_REPLAYED = 'conditions and amounts not checked: verifyProof does not replay the decision';

/** A proof of `unsigned()` changed by `change`, sealed and signed again by the trusted key. */
function resigned(change: (content: ProofView) => void): ReturnType<typeof signed> {
  const content = unsigned();
  change(content);
  return signProof(sealProof(unsalted(content)), RFC_SECRET, 'executor-1') as ReturnType<
    typeof signed
  >;
}

/** The proof of `unsigned()` for `rules` instead of `RULES`, checksums included. */
function forRules(
  rules: RuleDefinitionInput[],
  change: (content: ProofView) => void = () => undefined,
): ReturnType<typeof signed> {
  return resigned((content) => {
    rules.forEach((rule, i) => {
      content.rules[i]!.checksum = computeRuleChecksum(rule);
    });
    change(content);
  });
}

const check = (proof: unknown, rules: RuleDefinitionInput[] = RULES): unknown =>
  verifyProof(proof, { trustedKeys: TRUSTED, rules });

describe('I10: the verdict says that the rules were not checked', () => {
  it('without rules: authentic, and a notice says what was skipped', () => {
    expect(verifyProof(signed(), { trustedKeys: TRUSTED })).toEqual({
      status: 'authentic',
      issues: [RULES_NOT_CHECKED, NOT_REPLAYED],
    });
  });

  it('without options at all: the same notice, after unsigned', () => {
    expect(verifyProof(signed())).toEqual({
      status: 'consistent',
      issues: ['untrusted key', RULES_NOT_CHECKED, NOT_REPLAYED],
    });
  });

  it('with rules: no notice about rules, but the replay is still named', () => {
    expect(verifyProof(signed(), { trustedKeys: TRUSTED, rules: RULES })).toEqual({
      status: 'authentic',
      issues: [NOT_REPLAYED],
    });
  });

  it('an empty rules list is a call with rules', () => {
    const proof = forRules([], (c) => {
      c.rules = [];
      c.applied = [];
      c.skipped = [];
      c.outputs[0]!.contributors = [];
      c.outputs[0]!.value = 0;
    });
    expect(verifyProof(proof, { trustedKeys: TRUSTED, rules: [] }).issues).not.toContain(
      RULES_NOT_CHECKED,
    );
  });

  it('an invalid proof says its problem and nothing about what it did not check', () => {
    const proof = signed();
    proof.requestId = 'other';
    expect(verifyProof(proof, { trustedKeys: TRUSTED })).toEqual({
      status: 'invalid',
      issues: ['digest mismatch'],
    });
  });

  it('the README says what each call checks', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain(RULES_NOT_CHECKED);
    expect(readme).toContain(NOT_REPLAYED);
  });
});

describe('I11: what the definitions decide without execution', () => {
  it('a rule applied outside its window at evaluatedAt', () => {
    const proof = resigned((c) => {
      c.evaluatedAt = '2024-06-01';
    });
    expect(check(proof)).toEqual({
      status: 'invalid',
      issues: ['rule applied outside its window: r1@1'],
    });
  });

  it('the window is half-open: effectiveUntil is outside, the day before is inside', () => {
    const closed = { ...ruleA, effectiveUntil: '2025-06-01' };
    const at = (day: string) => forRules([closed, ruleB], (c) => (c.evaluatedAt = day));
    expect(check(at('2025-06-01'), [closed, ruleB])).toEqual({
      status: 'invalid',
      issues: ['rule applied outside its window: r1@1'],
    });
    expect(check(at('2025-05-31'), [closed, ruleB])).toEqual({
      status: 'authentic',
      issues: [NOT_REPLAYED],
    });
  });

  it('the first day is inside: effectiveFrom is included', () => {
    const proof = resigned((c) => {
      c.evaluatedAt = '2025-01-01';
    });
    expect(check(proof)).toEqual({ status: 'authentic', issues: [NOT_REPLAYED] });
    const before = resigned((c) => {
      c.evaluatedAt = '2024-12-31';
    });
    expect(check(before)).toEqual({
      status: 'invalid',
      issues: ['rule applied outside its window: r1@1'],
    });
  });

  it('an instant evaluatedAt against civil bounds is read in the rule time zone', () => {
    const paris = { ...ruleA, timeZone: '+02:00' };
    // 2024-12-31T23:30Z is 2025-01-01 01:30 at +02:00: inside.
    const inside = forRules([paris, ruleB], (c) => (c.evaluatedAt = '2024-12-31T23:30:00.000Z'));
    expect(check(inside, [paris, ruleB])).toEqual({ status: 'authentic', issues: [NOT_REPLAYED] });
    // The same instant is outside in UTC.
    const outside = forRules([ruleA, ruleB], (c) => (c.evaluatedAt = '2024-12-31T23:30:00.000Z'));
    expect(check(outside)).toEqual({
      status: 'invalid',
      issues: ['rule applied outside its window: r1@1'],
    });
  });

  it('the time zone of the rule set, then the one of the decision, apply when the rule has none', () => {
    // The local rule set is at +02:00 in the proof: inside.
    const local = forRules([ruleA, ruleB], (c) => {
      c.evaluatedAt = '2024-12-31T23:30:00.000Z';
      c.ruleSets = [{ kind: 'local', timeZone: '+02:00' }];
    });
    expect(check(local)).toEqual({ status: 'authentic', issues: [NOT_REPLAYED] });
    // The decision's own zone, with no rule set zone: inside as well.
    const decision = forRules([ruleA, ruleB], (c) => {
      c.evaluatedAt = '2024-12-31T23:30:00.000Z';
      c.timeZone = '+02:00';
    });
    expect(check(decision)).toEqual({ status: 'authentic', issues: [NOT_REPLAYED] });
  });

  it('a pack rule is read in the zone of its pack', () => {
    const first = { ...ruleA, ruleSet: 'vat' };
    const second = { ...ruleB, ruleSet: 'vat' };
    const proof = forRules([first, second], (c) => {
      c.evaluatedAt = '2024-12-31T23:30:00.000Z';
      c.rules.forEach((rule) => (rule.ruleSet = 'vat'));
      c.ruleSets = [
        { kind: 'pack', id: 'vat', version: '1', digest: 'a'.repeat(64), timeZone: '+02:00' },
      ];
      c.applied[0]!.ruleId = 'vat:r1';
      c.applied[0]!.output = 'vat:value';
      c.skipped[0]!.ruleId = 'vat:r2';
      c.skipped[0]!.output = 'vat:value';
      c.strata = [['vat:value']];
      c.outputs[0]!.name = 'vat:value';
      c.outputs[0]!.contributors = ['vat:r1'];
    });
    // Inside at +02:00 (2025-01-01 01:30), outside in UTC: only the zone of the pack says so.
    const out = verifyProof(proof, { trustedKeys: TRUSTED, rules: [first, second] });
    expect(out).toEqual({ status: 'authentic', issues: [NOT_REPLAYED] });
  });

  it('INACTIVE_DATE while the window contains evaluatedAt', () => {
    const proof = resigned((c) => {
      c.skipped[0]!.reason = 'INACTIVE_DATE';
    });
    expect(check(proof)).toEqual({
      status: 'invalid',
      issues: ['rule skipped as INACTIVE_DATE but its window contains evaluatedAt: r2@2'],
    });
  });

  it('INACTIVE_DATE outside the window is consistent', () => {
    const proof = resigned((c) => {
      c.evaluatedAt = '2024-06-01';
      c.skipped[0]!.reason = 'INACTIVE_DATE';
      c.applied = [];
      c.outputs[0]!.contributors = [];
      c.outputs[0]!.value = 0;
      c.skipped.push({
        ...c.skipped[0]!,
        ruleId: 'r1',
        version: 1,
      });
      c.skipped.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
    });
    expect(check(proof)).toEqual({ status: 'authentic', issues: [NOT_REPLAYED] });
  });

  it('a model different from the definition', () => {
    const proof = resigned((c) => {
      c.applied[0]!.model = 'PERCENTAGE';
    });
    expect(check(proof)).toEqual({
      status: 'invalid',
      issues: ['applied model differs from its rule: r1@1'],
    });
  });

  it('an output different from the definition, applied or skipped', () => {
    const feeding = { ...ruleA, output: 'extra' };
    const applied = forRules([feeding, ruleB]);
    expect(check(applied, [feeding, ruleB])).toEqual({
      status: 'invalid',
      issues: ['applied output differs from its rule: r1@1'],
    });
    const other = { ...ruleB, output: 'extra' };
    const skipped = forRules([ruleA, other]);
    expect(check(skipped, [ruleA, other])).toEqual({
      status: 'invalid',
      issues: ['skipped output differs from its rule: r2@2'],
    });
  });

  it('an output equal to the definition once qualified is fine', () => {
    const own = { ...ruleA, output: 'value' };
    expect(check(forRules([own, ruleB]), [own, ruleB])).toEqual({
      status: 'authentic',
      issues: [NOT_REPLAYED],
    });
  });

  it('CONDITION_FALSE for a rule without a condition', () => {
    const plain = {
      id: 'r2',
      version: 2,
      model: 'PERCENTAGE',
      params: {},
      priority: 2,
      effectiveFrom: '2025-01-01',
    };
    const proof = forRules([ruleA, plain]);
    expect(check(proof, [ruleA, plain])).toEqual({
      status: 'invalid',
      issues: ['CONDITION_FALSE on a rule without a condition: r2@2'],
    });
  });

  it('DIMENSION_MISMATCH for a rule without dimensions', () => {
    const proof = resigned((c) => {
      c.skipped[0]!.reason = 'DIMENSION_MISMATCH';
    });
    expect(check(proof)).toEqual({
      status: 'invalid',
      issues: ['DIMENSION_MISMATCH on a rule without dimensions: r2@2'],
    });
  });

  it('DIMENSION_MISMATCH for a rule with dimensions is consistent', () => {
    const constrained = { ...ruleB, dimensions: { country: 'FR' } };
    const proof = forRules([ruleA, constrained], (c) => {
      c.skipped[0]!.reason = 'DIMENSION_MISMATCH';
    });
    expect(check(proof, [ruleA, constrained])).toEqual({
      status: 'authentic',
      issues: [NOT_REPLAYED],
    });
  });

  it('a made-up reason is not refused (reasons are open) but is named', () => {
    const proof = resigned((c) => {
      c.skipped[0]!.reason = 'MADE_UP';
    });
    expect(check(proof)).toEqual({
      status: 'authentic',
      issues: ['reason not checked: MADE_UP', NOT_REPLAYED],
    });
  });

  it('a reason this version cannot decide is named once, however many entries carry it', () => {
    const third = { ...ruleA, id: 'r3' };
    const proof = forRules([ruleA, ruleB], (c) => {
      c.rules.push({ ...c.rules[0]!, id: 'r3', checksum: computeRuleChecksum(third) });
      c.skipped[0]!.reason = 'TAG_MISMATCH';
      c.skipped.push({ ...c.skipped[0]!, ruleId: 'r3', version: 1 });
    });
    const out = verifyProof(proof, { trustedKeys: TRUSTED, rules: [ruleA, ruleB, third] });
    expect(out).toEqual({
      status: 'authentic',
      issues: ['reason not checked: TAG_MISMATCH', NOT_REPLAYED],
    });
  });

  it.each([
    [
      'an effectiveOn other than the decision date',
      { effectiveOn: '/$dates/birth' },
      'effectiveOn is /$dates/birth',
    ],
  ])('a window not decidable is named: %s', (_name, patch, why) => {
    const rule = { ...ruleA, ...patch };
    const proof = forRules([rule, ruleB], (c) => {
      c.evaluatedAt = '2024-06-01';
    });
    expect(check(proof, [rule, ruleB])).toEqual({
      status: 'authentic',
      issues: [`window not checked: r1@1 (${why})`, NOT_REPLAYED],
    });
  });

  it('no evaluatedAt: no window can be decided, and it is said', () => {
    const proof = resigned((c) => {
      c.evaluatedAt = null;
    });
    expect(check(proof)).toEqual({
      status: 'authentic',
      issues: ['window not checked: r1@1 (no evaluatedAt)', NOT_REPLAYED],
    });
  });

  it('an INACTIVE_DATE skip with no evaluatedAt is named too', () => {
    const proof = resigned((c) => {
      c.evaluatedAt = null;
      c.skipped[0]!.reason = 'INACTIVE_DATE';
    });
    expect(check(proof)).toEqual({
      status: 'authentic',
      issues: [
        'window not checked: r1@1 (no evaluatedAt)',
        'window not checked: r2@2 (no evaluatedAt)',
        NOT_REPLAYED,
      ],
    });
  });

  it('an IANA zone the verifier cannot cross is named, not guessed', () => {
    const paris = { ...ruleA, timeZone: 'Europe/Paris' };
    const proof = forRules([paris, ruleB], (c) => {
      c.evaluatedAt = '2024-06-01T00:00:00.000Z';
    });
    const out = verifyProof(proof, { trustedKeys: TRUSTED, rules: [paris, ruleB] });
    expect(out.status).toBe('authentic');
    expect(out.issues).toEqual([
      'window not checked: r1@1 (time zone Europe/Paris needs a calendar)',
      NOT_REPLAYED,
    ]);
  });

  it('a day cut by an instant bound is undecidable, and it is said', () => {
    const cut = {
      ...ruleA,
      effectiveFrom: '2025-06-01T12:00:00.000Z',
      effectiveUntil: '2025-12-01T00:00:00.000Z',
    };
    const proof = forRules([cut, ruleB], (c) => {
      c.evaluatedAt = '2025-06-01';
    });
    const out = verifyProof(proof, { trustedKeys: TRUSTED, rules: [cut, ruleB] });
    expect(out.issues).toEqual([
      'window not checked: r1@1 (the day holds the bound of the window)',
      NOT_REPLAYED,
    ]);
  });

  it('the checks are made on rules whose checksum matches only', () => {
    const changed = { ...ruleA, model: 'PERCENTAGE' };
    const out = verifyProof(signed(), { trustedKeys: TRUSTED, rules: [changed, ruleB] });
    expect(out).toEqual({ status: 'invalid', issues: ['rule checksum mismatch: r1@1'] });
  });

  it('every contradiction is listed, in the order of the sections', () => {
    const proof = resigned((c) => {
      c.evaluatedAt = '2024-06-01';
      c.applied[0]!.model = 'PERCENTAGE';
      c.skipped[0]!.reason = 'DIMENSION_MISMATCH';
    });
    expect(check(proof)).toEqual({
      status: 'invalid',
      issues: [
        'rule applied outside its window: r1@1',
        'applied model differs from its rule: r1@1',
        'DIMENSION_MISMATCH on a rule without dimensions: r2@2',
      ],
    });
  });
});

describe('M1: a malformed trusted key is invalid', () => {
  it.each([
    ['too short', 'zz'],
    ['not hex', 'g'.repeat(64)],
    ['not a curve point', 'f'.repeat(64)],
    ['a small-order point', `01${'0'.repeat(62)}`],
  ])('%s', (_name, key) => {
    expect(verifyProof(signed(), { trustedKeys: { 'executor-1': key } })).toEqual({
      status: 'invalid',
      issues: ['trustedKeys.executor-1 is malformed'],
    });
  });

  it('only the key of the signer is read', () => {
    expect(
      verifyProof(signed(), { trustedKeys: { ...TRUSTED, other: 'zz' }, rules: RULES }),
    ).toEqual({ status: 'authentic', issues: [NOT_REPLAYED] });
  });

  it('a key id that is not plain text is cited safely', () => {
    const proof = signProof(sealProof(unsalted(unsigned())), RFC_SECRET, 'a"b');
    expect(verifyProof(proof, { trustedKeys: { 'a"b': 'zz' } })).toEqual({
      status: 'invalid',
      issues: ['trustedKeys.a\\"b is malformed'],
    });
  });
});

describe('the outputs a rule may feed: its own, and the targets of its short circuits', () => {
  const carrier = normalizeRuleDefinition({
    id: 'X',
    version: 1,
    model: 'FLAT',
    params: {},
    priority: 1,
    effectiveFrom: '2025-01-01',
    exceptions: [{ kind: 'shortCircuit', output: 'other', value: 1 }],
  });
  const view = (output: string): ProofView =>
    ({
      evaluatedAt: '2025-06-01',
      timeZone: 'UTC',
      ruleSets: [],
      applied: [{ ruleId: 'X', version: 1, model: 'FLAT', output }],
      skipped: [],
    }) as unknown as ProofView;
  const found = (output: string): string[] => {
    const invalid: string[] = [];
    definitionFindings(view(output), new Map([['X@1', carrier]]), {
      invalid: (message) => invalid.push(message),
      unchecked: () => undefined,
    });
    return invalid;
  };

  it('a step on the own output, and one on the output a short circuit imposes', () => {
    expect(found('value')).toEqual([]);
    expect(found('other')).toEqual([]);
  });

  it('a step on any other output is refused', () => {
    expect(found('elsewhere')).toEqual(['applied output differs from its rule: X@1']);
  });
});
