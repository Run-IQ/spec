/**
 * The accounting of what redacted entries can explain (`src/proof/lifts.ts`, review of 9K1,
 * round 4), on hand-made rows and problems: identities, domination, merges, Hall's condition.
 */
import { describe, expect, it } from 'vitest';
import { hiddenSections, isLifted, liftedChecks, LIFTS, unexplained } from '../src/proof/lifts.js';
import type { HiddenSections, Lift, RuleIdentity } from '../src/proof/lifts.js';
import type { ProofSection } from '../src/index.js';

/** The sections redacted, `counts` entries each. */
const hiddenOf = (counts: Partial<Record<ProofSection, number>>): HiddenSections =>
  hiddenSections(new Map(Object.entries(counts) as [ProofSection, number][]));

/** A row asking a rule of an entry in `sections`. */
const ruleRow = (check: string, ...sections: ProofSection[]): Lift<'rule'> => ({
  check,
  sections,
  needs: Object.fromEntries(sections.map((s) => [s, 'rule'])),
});

const rule = (id: string, version?: number, subject?: string): RuleIdentity => ({
  id,
  ...(version === undefined ? {} : { version }),
  ...(subject === undefined ? {} : { subject }),
});

/** Asks `row` for each rule identity, then whether the redacted entries explain them all. */
function fits(hidden: HiddenSections, asks: [Lift<'rule'>, RuleIdentity][]): boolean {
  asks.forEach(([row, identity], i) => {
    expect(isLifted(hidden, row, { message: `problem ${i}`, rule: identity })).toBe(true);
  });
  return unexplained(hidden).length === 0;
}

const RULES = ruleRow('rules', 'rules');
const APPLIED = ruleRow('applied', 'applied');
const SKIPPED = ruleRow('skipped', 'skipped');
const EXCEPTIONS = ruleRow('exceptions', 'exceptions');

describe('identities', () => {
  it('one identity twice is one entry; two versions are two', () => {
    expect(
      fits(hiddenOf({ rules: 1 }), [
        [RULES, rule('Z', 1)],
        [RULES, rule('Z', 1)],
      ]),
    ).toBe(true);
    expect(
      fits(hiddenOf({ rules: 1 }), [
        [RULES, rule('Z', 1)],
        [RULES, rule('Z', 2)],
      ]),
    ).toBe(false);
    expect(
      fits(hiddenOf({ rules: 2 }), [
        [RULES, rule('Z', 1)],
        [RULES, rule('Z', 2)],
      ]),
    ).toBe(true);
  });

  it('two subjects of one rule are two entries', () => {
    const asks: [Lift<'rule'>, RuleIdentity][] = [
      [APPLIED, rule('X', 1, '/a')],
      [APPLIED, rule('X', 1, '/b')],
    ];
    expect(fits(hiddenOf({ applied: 1 }), asks)).toBe(false);
    expect(fits(hiddenOf({ applied: 2 }), asks)).toBe(true);
  });

  it('a rule cited by id is met by the entry of any of its versions (dropped, exact)', () => {
    const asks: [Lift<'rule'>, RuleIdentity][] = [
      [RULES, rule('Z')],
      [RULES, rule('Z', 1)],
      [RULES, rule('Z', 2)],
    ];
    expect(fits(hiddenOf({ rules: 2 }), asks)).toBe(true);
    expect(fits(hiddenOf({ rules: 1 }), asks)).toBe(false);
  });

  it('a requirement in fewer sections dominates one of the same identity in more', () => {
    const wide = ruleRow('wide', 'applied', 'skipped');
    // Both met by one applied entry: one entry; the skipped entry is left for the third.
    const asks: [Lift<'rule'>, RuleIdentity][] = [
      [wide, rule('B', 1)],
      [APPLIED, rule('B', 1)],
      [SKIPPED, rule('C', 1)],
    ];
    expect(fits(hiddenOf({ applied: 1, skipped: 1 }), asks)).toBe(true);
  });

  it('the rule and the output of one entry are counted apart', () => {
    const hidden = hiddenOf({ applied: 1 });
    isLifted(hidden, LIFTS.everyRuleDecided, { message: 'rule', rule: rule('B', 1) });
    isLifted(hidden, LIFTS.outputValue, { message: 'value', output: { output: 'value' } });
    expect(unexplained(hidden)).toEqual([]);
    const two = hiddenOf({ applied: 1 });
    isLifted(two, LIFTS.outputValue, { message: 'value', output: { output: 'value' } });
    isLifted(two, LIFTS.outputValue, { message: 'other', output: { output: 'other' } });
    expect(unexplained(two)).toEqual(['value', 'other']);
  });

  it('an output and its items: an item of the output meets the output', () => {
    const hidden = hiddenOf({ items: 1 });
    const output = { output: 'kids' };
    isLifted(hidden, LIFTS.perOutputItems, { message: 'per', output });
    isLifted(hidden, LIFTS.itemsOfCollection, {
      message: 'stray',
      output: { output: 'kids', item: '/e/@1' },
    });
    expect(unexplained(hidden)).toEqual([]);
    const two = hiddenOf({ items: 1 });
    for (const item of ['/e/@1', '/e/@2']) {
      isLifted(two, LIFTS.itemsOfCollection, { message: item, output: { output: 'kids', item } });
    }
    expect(unexplained(two)).toEqual(['/e/@1', '/e/@2']);
  });

  it('a pending rule missing: the rule and the output of one pending entry', () => {
    const hidden = hiddenOf({ pending: 1 });
    const output = { output: 'value' };
    isLifted(hidden, LIFTS.outputPending, { message: 'B', rule: rule('B'), output });
    isLifted(hidden, LIFTS.outputPending, { message: 'C', rule: rule('C'), output });
    expect(unexplained(hidden)).toEqual(['B', 'C']);
  });
});

describe('what is counted', () => {
  it('a free section redacted besides one that counts: nothing counted', () => {
    const hidden = hiddenOf({ rules: 1, applied: 1 });
    for (const name of ['a', 'b', 'c']) {
      isLifted(hidden, LIFTS.outputValue, { message: name, output: { output: name } });
    }
    expect(unexplained(hidden)).toEqual([]);
  });

  it('a pending rule missing on two outputs: one rule, two outputs, two entries', () => {
    const hidden = hiddenOf({ pending: 1 });
    for (const output of ['value', 'other']) {
      isLifted(hidden, LIFTS.outputPending, {
        message: output,
        rule: rule('B'),
        output: { output },
      });
    }
    expect(unexplained(hidden)).toEqual(['value', 'other']);
  });

  it('a less specific requirement in more sections is not counted beside one in fewer', () => {
    // B@1 at /x needs the applied entry, as C@1 does: two applied entries, one redacted.
    const asks: [Lift<'rule'>, RuleIdentity][] = [
      [ruleRow('wide', 'applied', 'skipped'), rule('B', 1)],
      [APPLIED, rule('B', 1, '/x')],
      [APPLIED, rule('C', 1)],
    ];
    expect(fits(hiddenOf({ applied: 1, skipped: 1 }), asks)).toBe(false);
    expect(fits(hiddenOf({ applied: 2, skipped: 1 }), asks)).toBe(true);
  });

  it('of one identity in nested sections, the one in fewer is counted, whatever the order', () => {
    const wide = ruleRow('wide', 'applied', 'skipped');
    for (const asks of [
      [
        [wide, rule('B', 1, '/x')],
        [APPLIED, rule('B', 1, '/x')],
        [APPLIED, rule('C', 1)],
      ],
      [
        [APPLIED, rule('B', 1, '/x')],
        [wide, rule('B', 1, '/x')],
        [APPLIED, rule('C', 1)],
      ],
    ] as [Lift<'rule'>, RuleIdentity][][]) {
      expect(fits(hiddenOf({ applied: 1, skipped: 1 }), asks)).toBe(false);
    }
  });

  it('a rule without its version, at a subject: counted after one with its version', () => {
    // Z at /s and Z@1 may be one entry; Z@2 needs another.
    const asks: [Lift<'rule'>, RuleIdentity][] = [
      [APPLIED, rule('Z', undefined, '/s')],
      [APPLIED, rule('Z', 1)],
      [APPLIED, rule('Z', 2)],
    ];
    expect(fits(hiddenOf({ applied: 2 }), asks)).toBe(true);
    expect(fits(hiddenOf({ applied: 1 }), asks)).toBe(false);
  });

  it('the most specific counted first, whatever the order asked', () => {
    // Z then Z@1, Z@2: the versions count, the id does not.
    const asks: [Lift<'rule'>, RuleIdentity][] = [
      [RULES, rule('Z')],
      [RULES, rule('Z', 1)],
      [RULES, rule('Z', 2)],
    ];
    expect(fits(hiddenOf({ rules: 1 }), asks)).toBe(false);
  });
});

describe('a requirement that may share an entry is counted once', () => {
  // P (`B@1`, applied or skipped) and Q (`B@1 at /s`, skipped or exceptions) may share a
  // skipped entry: with R (applied) and S (exceptions), three entries suffice.
  const P = ruleRow('P', 'applied', 'skipped');
  const Q = ruleRow('Q', 'skipped', 'exceptions');
  const R: [Lift<'rule'>, RuleIdentity] = [APPLIED, rule('C', 1)];
  const S: [Lift<'rule'>, RuleIdentity] = [EXCEPTIONS, rule('D', 1, '/t')];
  const CAPACITY = { applied: 1, skipped: 1, exceptions: 1 };

  it('a less specific requirement with one it agrees with, sharing a section', () => {
    expect(fits(hiddenOf(CAPACITY), [[P, rule('B', 1)], [Q, rule('B', 1, '/s')], R, S])).toBe(true);
  });

  it('not with one it disagrees with', () => {
    expect(fits(hiddenOf(CAPACITY), [[P, rule('B', 1)], [Q, rule('B', 2, '/s')], R, S])).toBe(
      false,
    );
  });

  it('not with one in sections it does not share', () => {
    const asks: [Lift<'rule'>, RuleIdentity][] = [
      [APPLIED, rule('B', 1)],
      [EXCEPTIONS, rule('B', 1, '/s')],
      [ruleRow('either', 'applied', 'exceptions'), rule('C', 1)],
    ];
    expect(fits(hiddenOf({ applied: 1, exceptions: 1 }), asks)).toBe(false);
  });

  it('a rule cited by id with every version of it, sharing a section', () => {
    const asks: [Lift<'rule'>, RuleIdentity][] = [[P, rule('B')], [Q, rule('B', 2, '/s')], R, S];
    expect(fits(hiddenOf(CAPACITY), asks)).toBe(true);
  });

  it('one identity in overlapping sections, neither within the other', () => {
    expect(fits(hiddenOf(CAPACITY), [[P, rule('B', 1, '/s')], [Q, rule('B', 1, '/s')], R, S])).toBe(
      true,
    );
  });

  it('an output without its item, with every item of it', () => {
    const outputs = (check: string, ...sections: ProofSection[]): Lift<'output'> => ({
      check,
      sections,
      needs: Object.fromEntries(sections.map((s) => [s, 'output'])),
    });
    const hidden = hiddenOf(CAPACITY);
    isLifted(hidden, outputs('P', 'applied', 'skipped'), { message: 'p', output: { output: 'o' } });
    isLifted(hidden, outputs('Q', 'skipped', 'exceptions'), {
      message: 'q',
      output: { output: 'o', item: '/e/@1' },
    });
    isLifted(hidden, outputs('R', 'applied'), { message: 'r', output: { output: 'r' } });
    isLifted(hidden, outputs('S', 'exceptions'), { message: 's', output: { output: 's' } });
    expect(unexplained(hidden)).toEqual([]);
  });
});

describe("Hall's condition", () => {
  it('counts per section pass, the matching does not', () => {
    const either = ruleRow('either', 'applied', 'skipped');
    const asks: [Lift<'rule'>, RuleIdentity][] = [
      [APPLIED, rule('A', 1)],
      [APPLIED, rule('B', 1)],
      [either, rule('C', 1)],
    ];
    // Three entries, three requirements; but two need applied, which has one.
    expect(fits(hiddenOf({ applied: 1, skipped: 2 }), asks)).toBe(false);
    expect(fits(hiddenOf({ applied: 2, skipped: 1 }), asks)).toBe(true);
  });

  it('a free section explains without an entry', () => {
    const hidden = hiddenOf({ rules: 1 });
    for (const name of ['a', 'b', 'c']) {
      isLifted(hidden, LIFTS.outputValue, { message: name, output: { output: name } });
    }
    expect(unexplained(hidden)).toEqual([]);
  });

  it('only the sections redacted are allowed', () => {
    const hidden = hiddenOf({ applied: 1 });
    isLifted(hidden, LIFTS.everyRuleDecided, { message: 'A', rule: rule('A', 1) });
    isLifted(hidden, LIFTS.everyRuleDecided, { message: 'B', rule: rule('B', 1) });
    expect(unexplained(hidden)).toEqual(['A', 'B']);
  });
});

describe('the ledger', () => {
  it('a check of no redacted section is not lifted, nor recorded', () => {
    const hidden = hiddenOf({ factsRead: 1 });
    expect(isLifted(hidden, LIFTS.countForm, { message: 'x', output: { output: 'o' } })).toBe(
      false,
    );
    expect(liftedChecks(hidden)).toEqual([]);
  });

  it('names the checks lifted, in the order of LIFTS, with their sections redacted', () => {
    const hidden = hiddenOf({ applied: 1, exceptions: 1 });
    isLifted(hidden, LIFTS.shortCircuitCarrier, { message: 'x', rule: rule('X', 1) });
    isLifted(hidden, LIFTS.outputValue, { message: 'v', output: { output: 'v' } });
    expect(unexplained(hidden)).toEqual([]);
    expect(liftedChecks(hidden)).toEqual([
      { check: 'output value from its contributions', redacted: ['applied', 'exceptions'] },
      { check: 'short circuit with its carrier applied', redacted: ['applied'] },
    ]);
  });

  it('once unexplained: every problem said once, nothing lifted, nothing lifted after', () => {
    const hidden = hiddenOf({ rules: 1 });
    for (const version of [1, 2, 1]) {
      isLifted(hidden, LIFTS.ruleCitations, { message: `Z@${version}`, rule: rule('Z', version) });
    }
    expect(unexplained(hidden)).toEqual(['Z@1', 'Z@2']);
    expect(liftedChecks(hidden)).toEqual([]);
    expect(unexplained(hidden)).toEqual([]);
    expect(isLifted(hidden, LIFTS.ruleCitations, { message: 'Y', rule: rule('Y', 1) })).toBe(false);
    expect(liftedChecks(hidden)).toEqual([]);
  });

  it('without a ledger, a redacted section lifts and nothing is recorded', () => {
    const hidden = new Set<ProofSection>(['rules']);
    expect(isLifted(hidden, LIFTS.ruleCitations, { message: 'Z', rule: rule('Z') })).toBe(true);
    expect(unexplained(hidden)).toEqual([]);
    expect(liftedChecks(hidden)).toEqual([]);
  });
});
