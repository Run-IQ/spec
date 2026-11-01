import { describe, expect, it } from 'vitest';
import { findOverlappingVersions } from '../src/index.js';
import type { CivilCalendar, VersionedRuleWindow, VersionOverlap } from '../src/index.js';
import { overlapScanSteps, readVersionGroups, versionsOverlap } from '../src/rule/versions.js';
import { requireTimeZone } from '../src/time/civil.js';
import { fixedCalendar, transitionCalendar } from './helpers.js';

/**
 * The pairwise implementation of Task 9D, kept as the oracle of the sweep: every pair of every
 * (`ruleSet`, `id`) group checked by `versionsOverlap`, sorted by `ruleSet`, `id`, versions.
 */
function pairwise(
  rules: readonly VersionedRuleWindow[],
  timeZone: string,
  calendar: CivilCalendar,
): VersionOverlap[] {
  const found: VersionOverlap[] = [];
  const groups = readVersionGroups(rules, requireTimeZone(timeZone, 'INVALID_DATE'));
  for (const [ruleSet, ids] of groups) {
    for (const [id, versions] of ids) {
      for (const [i, a] of versions.entries()) {
        for (const b of versions.slice(i + 1)) {
          const kind =
            a.effectiveOn !== b.effectiveOn
              ? 'effectiveOn'
              : versionsOverlap(a.window, b.window, calendar)
                ? 'overlap'
                : undefined;
          if (kind === undefined) continue;
          const pair: [number, number] =
            a.version < b.version ? [a.version, b.version] : [b.version, a.version];
          found.push({ ruleSet, id, versions: pair, kind });
        }
      }
    }
  }
  const text = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return found.sort(
    (x, y) =>
      text(x.ruleSet, y.ruleSet) ||
      text(x.id, y.id) ||
      x.versions[0] - y.versions[0] ||
      x.versions[1] - y.versions[1],
  );
}

/** A deterministic pseudo-random generator (mulberry32), so every run checks the same sets. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZONES = ['UTC', 'Europe/Paris', 'Pacific/Noumea', 'Pacific/Niue', 'America/Santiago'];
const POINTERS = [undefined, '/$dates/effective', '/$dates/facture'];

/**
 * A random list of versions around the Santiago change of 2026-09-06: two rule sets, two ids,
 * civil and instant windows, own time zones or none, three `effectiveOn`.
 */
function randomVersions(next: () => number): VersionedRuleWindow[] {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const count = 2 + Math.floor(next() * 9);
  return Array.from({ length: count }, (_, i) => {
    const civil = next() < 0.5;
    const day = 1 + Math.floor(next() * 10);
    const length = 1 + Math.floor(next() * 4);
    const bound = (d: number): string => {
      const date = `2026-09-${String(d).padStart(2, '0')}`;
      if (civil) return date;
      const hour = String(Math.floor(next() * 24)).padStart(2, '0');
      return `${date}T${hour}:${pick(['00', '30'])}:00.000Z`;
    };
    const from = bound(day);
    let until: string | null = next() < 0.2 ? null : bound(day + length);
    if (until !== null && until <= from) until = null;
    const zone = next() < 0.5 ? pick(ZONES) : undefined;
    const ruleSet = pick([undefined, 'pack-a']);
    const effectiveOn = pick(POINTERS);
    return {
      id: pick(['R1', 'R2']),
      version: i + 1,
      effectiveFrom: from,
      effectiveUntil: until,
      ...(zone === undefined ? {} : { timeZone: zone }),
      ...(ruleSet === undefined ? {} : { ruleSet }),
      ...(effectiveOn === undefined ? {} : { effectiveOn }),
    };
  });
}

/** A calendar that counts its calls. */
function countingCalendar(calendar: CivilCalendar): {
  calendar: CivilCalendar;
  calls: () => number;
} {
  let calls = 0;
  return {
    calendar: {
      toCivilDate: (at, zone) => {
        calls += 1;
        return calendar.toCivilDate(at, zone);
      },
      startOfDay: (day, zone) => {
        calls += 1;
        return calendar.startOfDay(day, zone);
      },
    },
    calls: () => calls,
  };
}

/** `n` versions of R1, each a half year of a distinct year: no two overlap. */
function disjoint(n: number, instantsInParis = false): VersionedRuleWindow[] {
  return Array.from({ length: n }, (_, i) => {
    const year = String(1000 + i).padStart(4, '0');
    const instant = instantsInParis && i % 2 === 1;
    return {
      id: 'R1',
      version: i + 1,
      effectiveFrom: instant ? `${year}-01-01T12:00:00.000Z` : `${year}-01-01`,
      effectiveUntil: instant ? `${year}-06-01T12:00:00.000Z` : `${year}-06-01`,
      ...(instant ? { timeZone: 'Europe/Paris' } : {}),
    };
  });
}

describe('findOverlappingVersions: the sweep agrees with the pairwise oracle', () => {
  it('returns exactly the pairs of the oracle on 2000 random version sets', () => {
    const next = random(9);
    for (let run = 0; run < 2000; run++) {
      const rules = randomVersions(next);
      const zone = run % 2 === 0 ? 'UTC' : 'Europe/Paris';
      const expected = pairwise(rules, zone, transitionCalendar);
      expect(
        findOverlappingVersions(rules, zone, transitionCalendar),
        JSON.stringify(rules),
      ).toEqual({ overlaps: expected, truncated: false });
    }
  }, 60_000);

  it('finds overlaps of every kind among the random sets (the test is not vacuous)', () => {
    const next = random(9);
    const kinds = new Set<string>();
    for (let run = 0; run < 2000; run++) {
      for (const pair of pairwise(randomVersions(next), 'UTC', transitionCalendar)) {
        kinds.add(pair.kind);
      }
    }
    expect([...kinds].sort()).toEqual(['effectiveOn', 'overlap']);
  }, 60_000);
});

describe('findOverlappingVersions: bounded output and work', () => {
  it('lists at most 100 pairs, then says the list is truncated', () => {
    const rules = Array.from({ length: 8000 }, (_, i) => ({
      id: 'R1',
      version: i + 1,
      effectiveFrom: '2025-01-01',
      effectiveUntil: null,
    }));
    const report = findOverlappingVersions(rules, 'UTC', fixedCalendar);
    expect(report.truncated).toBe(true);
    expect(report.overlaps).toHaveLength(100);
    expect(report.overlaps.every((pair) => pair.kind === 'overlap')).toBe(true);
    expect(overlapScanSteps(rules, 'UTC', fixedCalendar)).toBeLessThan(8000 * 13 * 4);
  });

  it('stops listing pairs of different effectiveOn at the limit', () => {
    const rules = Array.from({ length: 8000 }, (_, i) => ({
      id: 'R1',
      version: i + 1,
      effectiveFrom: '2025-01-01',
      effectiveUntil: null,
      effectiveOn: `/$dates/d${i}`,
    }));
    const report = findOverlappingVersions(rules, 'UTC', fixedCalendar);
    expect(report.truncated).toBe(true);
    expect(report.overlaps).toHaveLength(100);
    expect(report.overlaps[0]).toEqual({
      ruleSet: 'local',
      id: 'R1',
      versions: [1, 2],
      kind: 'effectiveOn',
    });
    expect(overlapScanSteps(rules, 'UTC', fixedCalendar)).toBeLessThan(8000 * 13 * 4);
  }, 60_000);

  it('lists exactly 100 pairs without truncation, and truncates at 101', () => {
    // R1: 14 versions all overlapping, 91 pairs. R2: a chain where each version overlaps the
    // next only, `links` pairs.
    const rules = (links: number): VersionedRuleWindow[] => [
      ...Array.from({ length: 14 }, (_, i) => ({
        id: 'R1',
        version: i + 1,
        effectiveFrom: '2025-01-01',
        effectiveUntil: null,
      })),
      ...Array.from({ length: links + 1 }, (_, i) => ({
        id: 'R2',
        version: i + 1,
        effectiveFrom: `2025-01-${String(i + 1).padStart(2, '0')}`,
        effectiveUntil: `2025-01-${String(i + 3).padStart(2, '0')}`,
      })),
    ];
    const hundred = rules(9);
    expect(pairwise(hundred, 'UTC', fixedCalendar)).toHaveLength(100);
    expect(findOverlappingVersions(hundred, 'UTC', fixedCalendar)).toEqual({
      overlaps: pairwise(hundred, 'UTC', fixedCalendar),
      truncated: false,
    });
    const more = rules(10);
    const report = findOverlappingVersions(more, 'UTC', fixedCalendar);
    expect(report.truncated).toBe(true);
    expect(report.overlaps).toEqual(pairwise(more, 'UTC', fixedCalendar).slice(0, 100));
  });

  it('8000 disjoint versions cost O(n log n) steps and no calendar call', () => {
    const counted = countingCalendar(fixedCalendar);
    const rules = disjoint(8000);
    expect(findOverlappingVersions(rules, 'UTC', counted.calendar)).toEqual({
      overlaps: [],
      truncated: false,
    });
    expect(counted.calls()).toBe(0);
    expect(overlapScanSteps(rules, 'UTC', fixedCalendar)).toBeLessThan(8000 * 13 * 4);
  }, 60_000);

  it('8000 disjoint versions of mixed forms and zones: at most 3 calendar calls each', () => {
    const counted = countingCalendar(fixedCalendar);
    const rules = disjoint(8000, true);
    expect(findOverlappingVersions(rules, 'UTC', counted.calendar)).toEqual({
      overlaps: [],
      truncated: false,
    });
    expect(counted.calls()).toBeLessThanOrEqual(3 * 8000);
    expect(overlapScanSteps(rules, 'UTC', fixedCalendar)).toBeLessThan(8000 * 13 * 8);
  }, 60_000);
});
