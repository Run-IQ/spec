import { describe, expect, it } from 'vitest';
import { findOverlappingVersions, windowContains } from '../src/index.js';
import type { CivilCalendar } from '../src/index.js';
import { fixedCalendar, specError } from './helpers.js';

interface TestRule {
  id: string;
  version: number;
  ruleSet?: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  timeZone?: string;
  effectiveOn?: string;
}

function rule(
  version: number,
  effectiveFrom: string,
  effectiveUntil: string | null,
  extra: Partial<TestRule> = {},
): TestRule {
  return { id: 'R1', version, effectiveFrom, effectiveUntil, ...extra };
}

const overlap = (versions: [number, number], ruleSet = 'local', id = 'R1') => ({
  ruleSet,
  id,
  versions,
  kind: 'overlap',
});

describe('findOverlappingVersions', () => {
  it('a successor starting when its predecessor ends does not overlap', () => {
    const rules = [rule(1, '2025-01-01', '2026-01-01'), rule(2, '2026-01-01', null)];
    expect(findOverlappingVersions(rules, 'UTC', fixedCalendar)).toEqual([]);
  });

  it('reports two versions whose windows overlap', () => {
    const rules = [rule(1, '2025-01-01', '2026-01-01'), rule(2, '2025-06-01', null)];
    expect(findOverlappingVersions(rules, 'UTC', fixedCalendar)).toEqual([overlap([1, 2])]);
  });

  it('two open windows overlap', () => {
    const rules = [rule(1, '2025-01-01', null), rule(2, '2030-01-01', null)];
    expect(findOverlappingVersions(rules, 'UTC', fixedCalendar)).toEqual([overlap([1, 2])]);
  });

  it('the same id in two rule sets is two rules', () => {
    const rules = [
      rule(1, '2025-01-01', null),
      rule(1, '2025-01-01', null, { ruleSet: 'pack-a' }),
      rule(2, '2025-01-01', null, { ruleSet: 'pack-b' }),
    ];
    expect(findOverlappingVersions(rules, 'UTC', fixedCalendar)).toEqual([]);
  });

  it("an absent rule set is 'local'", () => {
    const rules = [rule(1, '2025-01-01', null), rule(2, '2025-06-01', null, { ruleSet: 'local' })];
    expect(findOverlappingVersions(rules, 'UTC', fixedCalendar)).toEqual([overlap([1, 2])]);
  });

  it('compares an instant bound and a civil bound in instants, by startOfDay (I7a, D-13)', () => {
    const rules = [
      rule(1, '2025-01-01T00:00:00.000Z', '2025-12-31T23:30:00.000Z'),
      rule(2, '2026-01-01', null),
    ];
    // In Paris, v2 starts at 2025-12-31T23:00:00.000Z, before v1 ends.
    expect(findOverlappingVersions(rules, 'Europe/Paris', fixedCalendar)).toEqual([
      overlap([1, 2]),
    ]);
    // In UTC, v2 starts at midnight UTC, after v1 ends.
    expect(findOverlappingVersions(rules, 'UTC', fixedCalendar)).toEqual([]);
  });

  it("uses each version's own time zone", () => {
    const utcThenParis = [
      rule(1, '2025-01-01', '2026-01-01', { timeZone: 'UTC' }),
      rule(2, '2026-01-01', null, { timeZone: 'Europe/Paris' }),
    ];
    // v1 ends at 2026-01-01T00:00Z, v2 starts at 2025-12-31T23:00Z: an hour where both apply.
    expect(findOverlappingVersions(utcThenParis, 'UTC', fixedCalendar)).toEqual([overlap([1, 2])]);
    const parisThenUtc = [
      rule(1, '2025-01-01', '2026-01-01', { timeZone: 'Europe/Paris' }),
      rule(2, '2026-01-01', null, { timeZone: 'UTC' }),
    ];
    expect(findOverlappingVersions(parisThenUtc, 'UTC', fixedCalendar)).toEqual([]);
  });

  it('civil windows in distant zones overlap on a civil day, even apart in instants', () => {
    // v1 ends at 2026-01-01T01:00Z, v2 starts at 2026-01-01T02:00Z, yet a civil reference date
    // 2026-01-01 is inside both windows.
    const rules = [
      rule(1, '2025-01-01', '2026-01-02', { timeZone: '+23:00' }),
      rule(2, '2026-01-01', null, { timeZone: '-02:00' }),
    ];
    expect(findOverlappingVersions(rules, 'UTC', fixedCalendar)).toEqual([overlap([1, 2])]);
  });

  it('reports versions that read different reference dates (I17, D-31)', () => {
    const rules = [
      rule(1, '2020-01-01', '2024-01-01', { effectiveOn: '/$dates/contrat' }),
      rule(2, '2024-01-01', null, { effectiveOn: '/$dates/effective' }),
    ];
    expect(findOverlappingVersions(rules, 'UTC', fixedCalendar)).toEqual([
      { ruleSet: 'local', id: 'R1', versions: [1, 2], kind: 'effectiveOn' },
    ]);
  });

  it("an absent effectiveOn is the default '/$dates/effective'", () => {
    const rules = [
      rule(1, '2020-01-01', '2024-01-01'),
      rule(2, '2024-01-01', null, { effectiveOn: '/$dates/effective' }),
    ];
    expect(findOverlappingVersions(rules, 'UTC', fixedCalendar)).toEqual([]);
    const other = [rule(1, '2020-01-01', '2024-01-01'), { ...rules[1]!, effectiveOn: '/$dates/x' }];
    expect(findOverlappingVersions(other, 'UTC', fixedCalendar)).toEqual([
      { ruleSet: 'local', id: 'R1', versions: [1, 2], kind: 'effectiveOn' },
    ]);
  });

  it('reports versions true on one civil day in far zones, apart in instants', () => {
    // v1 covers 2026-01-01 in +14:00; v2 starts during 2025-12-31 in -12:00, so the whole of
    // 2026-01-01 there is in v2: a civil reference date 2026-01-01 applies both.
    const civilAndInstant = [
      rule(1, '2026-01-01', '2026-01-02', { timeZone: '+14:00' }),
      rule(2, '2026-01-01T10:00:00.000Z', null, { timeZone: '-12:00' }),
    ];
    expect(findOverlappingVersions(civilAndInstant, 'UTC', fixedCalendar)).toEqual([
      overlap([1, 2]),
    ]);
    const instants = [
      rule(1, '2025-01-01T00:00:00.000Z', '2026-01-01T11:00:00.000Z', { timeZone: '+14:00' }),
      rule(2, '2026-01-01T11:00:00.000Z', null, { timeZone: '-12:00' }),
    ];
    expect(findOverlappingVersions(instants, 'UTC', fixedCalendar)).toEqual([overlap([1, 2])]);
    const named = [
      rule(1, '2025-01-01', '2026-01-01', { timeZone: 'Pacific/Kiritimati' }),
      rule(2, '2025-12-31T10:00:00.000Z', null, { timeZone: 'Pacific/Niue' }),
    ];
    expect(findOverlappingVersions(named, 'UTC', fixedCalendar)).toEqual([overlap([1, 2])]);
  });

  it('agrees with a brute force "both true on some reference date"', () => {
    let seed = 20261031;
    // mulberry32: a small seeded generator, so the test is the same on every run.
    const random = (n: number): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const zones = ['UTC', '+14:00', '-12:00', '+05:30', '-03:00'];
    const day = (i: number): string =>
      new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    const half = (i: number): string =>
      new Date(Date.UTC(2026, 0, 1) + i * 1_800_000).toISOString();
    const randomRule = (version: number): TestRule => {
      const timeZone = zones[random(zones.length)] ?? 'UTC';
      if (random(2) === 0) {
        const from = random(20);
        const until = random(8) === 0 ? null : day(from + 1 + random(2));
        return rule(version, day(from), until, { timeZone });
      }
      const from = random(20 * 48);
      const until = random(8) === 0 ? null : half(from + 1 + random(2 * 48));
      return rule(version, half(from), until, { timeZone });
    };
    const civilRefs = Array.from({ length: 28 }, (_, i) => day(i - 4));
    const instantRefs = Array.from({ length: 28 * 48 }, (_, i) => half(i - 4 * 48));
    let overlaps = 0;
    for (let n = 0; n < 300; n++) {
      const pair = [randomRule(1), randomRule(2)];
      const both = [...civilRefs, ...instantRefs].some((at) =>
        pair.every((r) => windowContains(r, at, 'UTC', fixedCalendar) === true),
      );
      if (both) overlaps++;
      const found = findOverlappingVersions(pair, 'UTC', fixedCalendar);
      expect(found, JSON.stringify(pair)).toEqual(both ? [overlap([1, 2])] : []);
    }
    // Both answers are well represented.
    expect(overlaps).toBeGreaterThan(60);
    expect(overlaps).toBeLessThan(240);
  });

  it('decides windows at the edges of the years 0000 and 9999', () => {
    const rules = [
      rule(1, '0000-01-01T00:00:00.000Z', '0000-01-01T00:30:00.000Z', { timeZone: '-01:00' }),
      rule(2, '0000-01-01', null, { timeZone: '+01:00' }),
    ];
    // v2 starts at -0001-12-31T23:00Z, before every instant: it covers all of v1.
    expect(findOverlappingVersions(rules, 'UTC', fixedCalendar)).toEqual([overlap([1, 2])]);
    const late = [
      rule(1, '9999-12-31T22:00:00.000Z', null, { timeZone: '+05:00' }),
      rule(2, '2026-01-01', '9999-12-31', { timeZone: '+05:00' }),
    ];
    // v2 ends at 9999-12-30T19:00Z, before v1 starts; v1 is true on no day of 0000-9999.
    expect(findOverlappingVersions(late, 'UTC', fixedCalendar)).toEqual([]);
  });

  it('sorts by rule set, id, then versions, smaller version first', () => {
    const rules = [
      rule(3, '2025-01-01', null, { id: 'R2' }),
      rule(2, '2025-01-01', null, { id: 'R2' }),
      rule(1, '2025-01-01', null, { id: 'R2' }),
      rule(9, '2025-01-01', null, { ruleSet: 'pack' }),
      rule(4, '2025-01-01', null, { ruleSet: 'pack' }),
      rule(2, '2025-01-01', null, { id: 'R10' }),
      rule(1, '2025-01-01', null, { id: 'R10' }),
    ];
    expect(findOverlappingVersions(rules, 'UTC', fixedCalendar)).toEqual([
      overlap([1, 2], 'local', 'R10'),
      overlap([1, 2], 'local', 'R2'),
      overlap([1, 3], 'local', 'R2'),
      overlap([2, 3], 'local', 'R2'),
      overlap([4, 9], 'pack', 'R1'),
    ]);
  });

  it('compares instants without the calendar, and civil dates of one zone too', () => {
    const noCalendar: CivilCalendar = {
      toCivilDate: () => {
        throw new Error('not called');
      },
      startOfDay: () => {
        throw new Error('not called');
      },
    };
    const instants = [
      rule(1, '2025-01-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z'),
      rule(2, '2025-05-31T23:59:59.999Z', null),
    ];
    expect(findOverlappingVersions(instants, 'Europe/Paris', noCalendar)).toEqual([
      overlap([1, 2]),
    ]);
    const civil = [rule(1, '2025-01-01', '2025-06-01'), rule(2, '2025-06-01', null)];
    expect(findOverlappingVersions(civil, 'Europe/Paris', noCalendar)).toEqual([]);
  });

  it('checks 20 000 distinct ids in linear time', () => {
    const rules = Array.from({ length: 20_000 }, (_, i) =>
      rule(1, '2025-01-01', null, { id: `R${i}` }),
    );
    expect(findOverlappingVersions(rules, 'UTC', fixedCalendar)).toEqual([]);
  });

  it('returns [] for no rule', () => {
    expect(findOverlappingVersions([], 'UTC', fixedCalendar)).toEqual([]);
  });
});

describe('findOverlappingVersions: refusals', () => {
  it('refuses the same version twice in a rule set (M-19)', () => {
    const rules = [rule(1, '2025-01-01', '2025-02-01'), rule(1, '2026-01-01', null)];
    const error = specError(() => findOverlappingVersions(rules, 'UTC', fixedCalendar));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe('duplicate rule R1@1');
  });

  it('refuses a rule mixing a civil bound and an instant bound, naming it', () => {
    const rules = [rule(1, '2025-01-01', '2026-01-01T00:00:00.000Z')];
    const error = specError(() => findOverlappingVersions(rules, 'UTC', fixedCalendar));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe(
      'rule R1@1: effectiveFrom and effectiveUntil must both be civil dates or both instants',
    );
  });

  it('refuses an invalid rule field, naming the rule', () => {
    const cases: [Partial<TestRule>, string, string][] = [
      [{ effectiveFrom: 'x' }, 'INVALID_DATE', 'rule R1@1: effectiveFrom must be a Date'],
      [{ timeZone: 'Paris' }, 'INVALID_RULE', 'rule R1@1: timeZone must be UTC'],
      [{ effectiveOn: '' }, 'INVALID_RULE', 'rule R1@1: effectiveOn must start with /$dates/'],
      [{ ruleSet: '' }, 'INVALID_RULE', 'rule R1@1: ruleSet must be a non-empty string'],
      [{ id: '' }, 'INVALID_RULE', 'rule @1: id must be a non-empty string'],
      [{ version: 0 }, 'INVALID_RULE', 'rule R1@0: version must be a positive integer'],
    ];
    for (const [change, code, start] of cases) {
      const rules = [{ ...rule(1, '2025-01-01', null), ...change }];
      const error = specError(() => findOverlappingVersions(rules, 'UTC', fixedCalendar));
      expect(error.code).toBe(code);
      expect(error.message.startsWith(start)).toBe(true);
    }
  });

  it('refuses an invalid time zone argument', () => {
    const error = specError(() => findOverlappingVersions([], 'Paris', fixedCalendar));
    expect(error.code).toBe('INVALID_DATE');
    expect(error.message).toBe(
      'timeZone must be UTC, ±HH:MM or an IANA name Area/Location; got "Paris"',
    );
  });

  it('refuses a non-array and an unreadable list with INVALID_RULE', () => {
    const notList = specError(() =>
      findOverlappingVersions('x' as unknown as TestRule[], 'UTC', fixedCalendar),
    );
    expect(notList.code).toBe('INVALID_RULE');
    expect(notList.message).toBe('rules must be an array of rules');
    const hostile = new Proxy([rule(1, '2025-01-01', null)], {
      get: () => {
        throw new Error('trap');
      },
    });
    const unreadable = specError(() => findOverlappingVersions(hostile, 'UTC', fixedCalendar));
    expect(unreadable.code).toBe('INVALID_RULE');
    expect(unreadable.message).toBe('rules could not be read: trap');
  });
});
