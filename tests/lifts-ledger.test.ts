/**
 * The accounting of what redacted entries can explain (`src/proof/lifts.ts`, review of 9K1,
 * round 4), on hand-made rows and problems: identities, domination, merges, Hall's condition.
 */
import { describe, expect, it } from 'vitest';
import {
  hiddenSections,
  isLifted,
  liftedChecks,
  LIFTS,
  matched,
  unexplained,
} from '../src/proof/lifts.js';
import type { HiddenSections, Lift, RuleIdentity } from '../src/proof/lifts.js';
import { PROOF_SECTIONS } from '../src/index.js';
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
    const ties = new Set<ProofSection>(['rules']);
    for (const name of ['a', 'b', 'c']) {
      isLifted(hidden, LIFTS.causes, { message: name, output: { output: name }, ties });
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
    const hidden = hiddenOf({ exceptions: 1 });
    for (const name of ['a', 'b', 'c']) {
      isLifted(hidden, LIFTS.decisionsAgainstExceptions, { message: name });
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
    isLifted(hidden, LIFTS.shortCircuitCarrier, {
      message: 'x',
      rule: rule('X', 1),
      output: { output: 'v' },
      as: { exceptions: 'none' },
    });
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

describe('Hall on synthetic masks (review of 9K1, round 5, M1)', () => {
  /** Ten sections, `count` entries in each of `sections` (by index), none elsewhere. */
  const capacity = (counts: Record<number, number>): number[] =>
    Array.from({ length: 10 }, (_, i) => counts[i] ?? 0);
  const ALL = (1 << 10) - 1;

  it('no requirement fits anything', () => {
    expect(matched([], capacity({}))).toBe(true);
  });

  it('one section: as many requirements as entries, never one more', () => {
    expect(matched([1, 1], capacity({ 0: 2 }))).toBe(true);
    expect(matched([1, 1, 1], capacity({ 0: 2 }))).toBe(false);
    expect(matched([1 << 9], capacity({ 9: 1 }))).toBe(true);
    expect(matched([1 << 9, 1 << 9], capacity({ 9: 1 }))).toBe(false);
  });

  it('the full union counts every entry, and no more', () => {
    const tenEach = capacity(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, 1])));
    expect(
      matched(
        Array.from({ length: 10 }, () => ALL),
        tenEach,
      ),
    ).toBe(true);
    expect(
      matched(
        Array.from({ length: 11 }, () => ALL),
        tenEach,
      ),
    ).toBe(false);
  });

  it('a union is short only together: the requirements of its subsets add up', () => {
    // Sections 0 and 1, one entry each: {0}, {1} and {0, 1} need three.
    expect(matched([1, 2], capacity({ 0: 1, 1: 1 }))).toBe(true);
    expect(matched([1, 2, 3], capacity({ 0: 1, 1: 1 }))).toBe(false);
    expect(matched([1, 2, 3], capacity({ 0: 2, 1: 1 }))).toBe(true);
    // Sections 0 and 2: the sum over subsets crosses bit 0 and bit 1 alike.
    expect(matched([1, 4, 5], capacity({ 0: 1, 2: 1 }))).toBe(false);
    expect(matched([2, 4, 6], capacity({ 1: 1, 2: 1 }))).toBe(false);
  });

  it('an entry of a section outside a requirement does not meet it', () => {
    expect(matched([1, 1], capacity({ 0: 1, 1: 5 }))).toBe(false);
    expect(matched([1, 3], capacity({ 0: 1, 1: 1 }))).toBe(true);
  });
});

describe('agreement: one entry may carry both (review of 9K1, round 5)', () => {
  const asks = (hidden: HiddenSections, ...rules: RuleIdentity[]): string[] => {
    rules.forEach((identity, i) => {
      isLifted(hidden, LIFTS.ruleCitations, { message: `p${i}`, rule: identity });
    });
    return unexplained(hidden);
  };

  it('Z@1 and Z@2 need two entries; Z agrees with either', () => {
    expect(asks(hiddenOf({ rules: 1 }), rule('Z', 1), rule('Z', 2), rule('Z'))).not.toEqual([]);
    expect(asks(hiddenOf({ rules: 2 }), rule('Z', 1), rule('Z', 2), rule('Z'))).toEqual([]);
    expect(asks(hiddenOf({ rules: 1 }), rule('Z'), rule('Z', 1))).toEqual([]);
  });

  it('Z@1 and Z at /s agree (Z@1 at /s carries both); Z@1 at /s and Z@1 at /t do not', () => {
    expect(asks(hiddenOf({ rules: 1 }), rule('Z', 1), rule('Z', undefined, '/s'))).toEqual([]);
    expect(asks(hiddenOf({ rules: 1 }), rule('Z', 1, '/s'), rule('Z', 1, '/t'))).not.toEqual([]);
    expect(asks(hiddenOf({ rules: 1 }), rule('Z', 1, '/s'), rule('Z', 2))).not.toEqual([]);
  });

  it('an output and an item of it agree; two items of it do not', () => {
    const outputs = (counts: number, ...places: { output: string; item?: string }[]) => {
      const hidden = hiddenOf({ items: counts });
      places.forEach((output, i) => {
        isLifted(hidden, LIFTS.itemsOfCollection, { message: `p${i}`, output });
      });
      return unexplained(hidden);
    };
    expect(outputs(1, { output: 'o', item: '/e/@1' }, { output: 'o' })).toEqual([]);
    expect(outputs(1, { output: 'o', item: '/e/@1' }, { output: 'o', item: '/e/@2' })).not.toEqual(
      [],
    );
    expect(outputs(2, { output: 'o', item: '/e/@1' }, { output: 'o', item: '/e/@2' })).toEqual([]);
  });

  it('an alternative in another section never makes two agree', () => {
    // Z in rules and Z in applied: one entry cannot be in both sections.
    const hidden = hiddenOf({ rules: 1, applied: 1 });
    isLifted(hidden, RULES, { message: 'a', rule: rule('Z', 1) });
    isLifted(hidden, APPLIED, { message: 'b', rule: rule('Z', 1) });
    expect(unexplained(hidden)).toEqual([]);
    // Z@2 in applied agrees with no requirement there: a second applied entry.
    isLifted(hidden, APPLIED, { message: 'c', rule: rule('Z', 2) });
    expect(unexplained(hidden)).toEqual(['a', 'b', 'c']);
  });

  it('a pair needs its own entry where its rule and its output each agree elsewhere', () => {
    const hidden = hiddenOf({ pending: 2 });
    const ask = (id: string, output: string): void => {
      isLifted(hidden, LIFTS.outputPending, {
        message: `${id} ${output}`,
        rule: { id },
        output: { output },
      });
    };
    ask('X', 'v');
    ask('Y', 'w');
    expect(unexplained(hidden)).toEqual([]);
    ask('X', 'w');
    expect(unexplained(hidden)).toEqual(['X v', 'Y w', 'X w']);
  });

  it('a problem narrowed to none in a section asks nothing there', () => {
    const hidden = hiddenOf({ rules: 1 });
    expect(
      isLifted(hidden, LIFTS.outputValue, {
        message: 'sum',
        output: { output: 'v' },
        as: { rules: 'none' },
      }),
    ).toBe(false);
    expect(liftedChecks(hidden)).toEqual([]);
  });

  it('a tie section is no alternative unless the ties may be hidden, then free', () => {
    const hidden = hiddenOf({ rules: 1 });
    expect(isLifted(hidden, LIFTS.tieStatus, { message: 't' })).toBe(false);
    const ties = new Set<ProofSection>(['rules']);
    for (const name of ['a', 'b', 'c']) {
      expect(isLifted(hidden, LIFTS.tieStatus, { message: name, ties })).toBe(true);
    }
    expect(unexplained(hidden)).toEqual([]);
    expect(liftedChecks(hidden)).toEqual([
      { check: 'output status no weaker than its tie', redacted: ['rules'] },
    ]);
  });
});

describe('every need of every row of LIFTS (review of 9K1, round 5)', () => {
  type Asked = {
    rule?: RuleIdentity;
    output?: { output: string; item?: string };
    ties?: ReadonlySet<ProofSection>;
  };
  /** Asks `row` each problem of `asked`, then whether one entry of `section` explains them. */
  const oneEntry = (row: Lift, section: ProofSection, asked: Asked[]): boolean | 'unlifted' => {
    const hidden = hiddenOf({ [section]: 1 });
    for (const [i, problem] of asked.entries()) {
      if (!isLifted(hidden, row, { message: `p${i}`, ...problem } as never)) return 'unlifted';
    }
    return unexplained(hidden).length === 0;
  };
  const at = (output: string, item?: string) =>
    item === undefined ? { output } : { output, item };
  // Frozen, written by hand from the audit (report of 9K1, round 5): LIFTS must say exactly this.
  const NEEDS: Record<string, Partial<Record<ProofSection, string>>> = {
    ruleCitations: { rules: 'rule' },
    outputCitations: { outputs: 'output' },
    requestedOutputs: { outputs: 'output' },
    strataOutputs: { outputs: 'output' },
    outputValue: { rules: 'output', applied: 'place', exceptions: 'output' },
    causes: { rules: 'tie', applied: 'place', skipped: 'output', exceptions: 'tie' },
    tieStatus: { rules: 'tie', skipped: 'tie', exceptions: 'tie' },
    undeterminedCause: { pending: 'output' },
    settledPending: { rules: 'output', applied: 'place' },
    rankRange: { applied: 'rule' },
    outputPending: { pending: 'both' },
    itemsOfCollection: { items: 'place' },
    perOutputItems: { items: 'output' },
    countForm: { exceptions: 'output' },
    everyRuleDecided: { applied: 'rule', skipped: 'rule', pending: 'rule', exceptions: 'rule' },
    decisionsAgainstExceptions: { exceptions: 'free' },
    firedExceptions: { rules: 'tie', skipped: 'tie', exceptions: 'free' },
    exclusionException: { rules: 'tie', skipped: 'tie', exceptions: 'free' },
    affectedFound: {
      rules: 'tie',
      applied: 'free',
      skipped: 'free',
      pending: 'free',
      exceptions: 'free',
    },
    shortCircuitCarrier: { rules: 'tie', applied: 'both', skipped: 'tie', exceptions: 'output' },
    carrierStatus: { exceptions: 'rule' },
    tieLoser: { rules: 'tie', skipped: 'tie', exceptions: 'tie' },
    tieRecords: { rules: 'tie', skipped: 'tie', exceptions: 'tie' },
    pendingCarrierFired: { exceptions: 'rule' },
    pendingCarrierChain: { pending: 'free' },
    provisionalSource: { factsRead: 'free', readsUndeclared: 'free' },
    conflictSource: { skipped: 'free' },
    carrierRecords: { rules: 'tie', skipped: 'rule', exceptions: 'rule' },
    givenRules: { rules: 'rule' },
  };
  const rows = LIFTS as unknown as Record<string, Lift>;

  it('LIFTS is the audited table, its sections in the order of the proof', () => {
    expect(
      Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, row.needs])),
    ).toEqual(NEEDS);
    for (const row of Object.values(rows)) {
      expect(row.sections).toEqual(PROOF_SECTIONS.filter((section) => section in row.needs));
    }
  });

  const cases = Object.entries(NEEDS).flatMap(([name, needs]) =>
    (Object.entries(needs) as [ProofSection, string][]).map(
      ([section, need]) => [name, section, need, rows[name]!] as const,
    ),
  );

  it.each(cases)('%s: %s is %s', (_, section, need, row) => {
    const ties = new Set<ProofSection>([section]);
    const anyRule = (i: number): Asked => ({
      rule: rule(`R${i}`, 1),
      output: at(`o${i}`, `/e/@${i}`),
    });
    switch (need) {
      case 'free':
        expect(oneEntry(row, section, [anyRule(1), anyRule(2), anyRule(3)])).toBe(true);
        break;
      case 'tie':
        expect(oneEntry(row, section, [anyRule(1)])).toBe('unlifted');
        expect(
          oneEntry(
            row,
            section,
            [1, 2, 3].map((i) => ({ ...anyRule(i), ties })),
          ),
        ).toBe(true);
        break;
      case 'rule':
        // The rule counts, the output does not.
        expect(
          oneEntry(row, section, [
            { rule: rule('Z', 1), output: at('a') },
            { rule: rule('Z', 1), output: at('b') },
          ]),
        ).toBe(true);
        expect(
          oneEntry(row, section, [
            { rule: rule('Z', 1), output: at('a') },
            { rule: rule('Z', 2), output: at('a') },
          ]),
        ).toBe(false);
        break;
      case 'output':
        // The output counts, not its item nor the rule.
        expect(
          oneEntry(row, section, [
            { rule: rule('A', 1), output: at('o', '/e/@1') },
            { rule: rule('B', 1), output: at('o', '/e/@2') },
          ]),
        ).toBe(true);
        expect(oneEntry(row, section, [{ output: at('o') }, { output: at('p') }])).toBe(false);
        break;
      case 'place':
        expect(
          oneEntry(row, section, [
            { rule: rule('A', 1), output: at('o', '/e/@1') },
            { rule: rule('B', 1), output: at('o', '/e/@1') },
          ]),
        ).toBe(true);
        expect(
          oneEntry(row, section, [{ output: at('o', '/e/@1') }, { output: at('o', '/e/@2') }]),
        ).toBe(false);
        break;
      case 'both':
        expect(
          oneEntry(row, section, [
            { rule: rule('X'), output: at('v') },
            { rule: rule('X'), output: at('v') },
          ]),
        ).toBe(true);
        expect(
          oneEntry(row, section, [
            { rule: rule('X'), output: at('v') },
            { rule: rule('X'), output: at('w') },
          ]),
        ).toBe(false);
        expect(
          oneEntry(row, section, [
            { rule: rule('X'), output: at('v') },
            { rule: rule('Y'), output: at('v') },
          ]),
        ).toBe(false);
        break;
      default:
        throw new Error(`unknown need ${String(need)}`);
    }
  });

  it('a pair counts in the rules too: beside a rule of another row in its section', () => {
    // A pending entry of X for `v`, and a decision of Y: two pending entries.
    const hidden = hiddenOf({ pending: 1 });
    isLifted(hidden, LIFTS.outputPending, {
      message: 'X',
      rule: { id: 'X' },
      output: { output: 'v' },
    });
    isLifted(hidden, LIFTS.everyRuleDecided, { message: 'Y', rule: rule('Y', 1) });
    expect(unexplained(hidden)).toEqual(['X', 'Y']);
  });

  it('one short circuit explains the value of every item of its output', () => {
    const hidden = hiddenOf({ exceptions: 1 });
    for (const item of ['/e/@1', '/e/@2']) {
      isLifted(hidden, LIFTS.outputValue, { message: item, output: { output: 'o', item } });
    }
    expect(unexplained(hidden)).toEqual([]);
  });
});
