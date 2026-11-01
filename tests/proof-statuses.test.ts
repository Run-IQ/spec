import { describe, expect, it } from 'vitest';
import { entries } from './proof-cases.js';
import { problems, withEntry, withSection } from './proof-builders.js';
import type { Entry } from './proof-builders.js';

describe('statuses of contributions and candidates (pre-flight C1, C2)', () => {
  it('an output weaker than one of its applied contributions', () => {
    expect(problems(withEntry('outputs', 1, { status: 'determined' }))).toEqual([
      'output status weaker than its contributions: social:aid',
    ]);
  });

  it('an output weaker than an exclusion that feeds it', () => {
    expect(problems(withEntry('skipped', 1, { status: 'provisional' }))).toEqual([
      'output status weaker than its candidates: value',
    ]);
  });

  it('an item weaker than an exclusion of its rule without subject (a grouped one)', () => {
    expect(problems(withEntry('skipped', 0, { status: 'provisional' }))).toEqual([
      'output status weaker than its candidates: kids at /enfants/@a7',
    ]);
  });

  it('an item weaker than an exclusion at its subject, or at a prefix of it', () => {
    const skip = (subject: string): Entry => ({
      ruleId: 'x',
      version: 1,
      subject,
      output: 'kids',
      reason: 'DOMINATED',
      status: 'conflict',
      stratum: 0,
    });
    const skipped = entries('skipped');
    for (const subject of ['/enfants/@a7', '/enfants']) {
      const list = [skipped[0], skipped[1], skip(subject), skipped[2]] as Entry[];
      expect(problems(withSection('skipped', list))).toEqual([
        'output status weaker than its candidates: kids at /enfants/@a7',
      ]);
    }
    const elsewhere = [skipped[0], skipped[1], skip('/enfants/@b1'), skipped[2]] as Entry[];
    expect(problems(withSection('skipped', elsewhere))).toEqual([]);
  });

  it('an item weaker than its own contributions', () => {
    expect(problems(withEntry('applied', 0, { status: 'provisional' }))).toEqual([
      'output status weaker than its contributions: kids at /enfants/@a7',
    ]);
  });
});

describe('bounds, pending rules and undeclared reads', () => {
  it('refuses bounds on an output whose values have no order', () => {
    const content = withEntry('outputs', 1, {
      status: 'undetermined',
      value: undefined,
      bounds: { min: false },
    });
    expect(problems(content)).toEqual([
      'bounds on an unordered output: social:aid',
      'undetermined output without a cause: social:aid',
    ]);
  });

  it('refuses pending rules of an item that are not those the pending section gives it', () => {
    expect(problems(withEntry('items', 1, { pending: [] }))).toEqual([
      'pending differ from pending rules: kids at /enfants/@c9',
    ]);
    expect(problems(withEntry('items', 1, { pending: ['k', 'r1'] }))).toEqual([
      'pending differ from pending rules: kids at /enfants/@c9',
    ]);
  });

  it('refuses pending rules on an output the pending section does not feed', () => {
    expect(problems(withEntry('outputs', 2, { pending: ['r2'] }))).toEqual([
      'pending differ from pending rules: value',
    ]);
  });

  it('refuses a determined step of a rule whose reads were undeclared', () => {
    expect(problems(withEntry('applied', 2, { status: 'determined' }))).toEqual([
      'rule with undeclared reads cannot be determined: social:R1@1',
    ]);
  });
});
