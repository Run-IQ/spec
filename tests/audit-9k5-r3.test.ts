/**
 * Task 9K5, round 3 of the audit: the verdict depends on the time zone database only when the
 * proof and the runtime name the same release (W1), the formatter cache is bounded and the number
 * of zones of a proof is limited (W2), a Date is a Date only under a Date's prototype (W3), a
 * runtime that cannot read offsets says so in a notice (W6), and the guards left without a test
 * (W7).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeRuleDefinition,
  sealProof,
  signProof,
  validateProofInput,
  verifyProof,
} from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';
import { canonicalize } from '../src/index.js';
import { definitionFindings } from '../src/proof/definition-checks.js';
import {
  clearIntlCaches,
  intlCacheLimits,
  intlCacheSizes,
  intlCalendar,
  parseOffset,
} from '../src/proof/intl-calendar.js';
import type { ProofView } from '../src/proof/types.js';
import { MAX_PROOF_TIME_ZONES } from '../src/proof/verify.js';
import { dateTimeOf, hasDateSlot, isPlainObject, notADateMessage } from '../src/values.js';
import { specError } from './helpers.js';
import { NOT_REPLAYED, withRuntimeTzdata } from './notices.js';
import { RFC_PUBLIC, RFC_SECRET, ruleA, unsalted, unsigned } from './proof-cases.js';

const TRUSTED = { 'executor-1': RFC_PUBLIC };

interface Run {
  invalid: string[];
  unchecked: string[];
}

/** `definitionFindings` of rules of `zones`, each applied at `evaluatedAt`, against `tzdata`. */
function run(
  rules: RuleDefinitionInput[],
  evaluatedAt: string,
  proofTzdata: string | undefined,
  runtimeTzdata: string | undefined,
  proofExtra: object = {},
): Run {
  const definitions = new Map(rules.map((r) => [`${r.id}@1`, normalizeRuleDefinition(r)]));
  const view = {
    evaluatedAt,
    timeZone: 'UTC',
    ruleSets: [],
    versions: {
      components:
        proofTzdata === undefined
          ? []
          : [{ name: 'tzdata', version: proofTzdata, declaredBy: 'engine' }],
    },
    applied: rules.map((r) => ({ ruleId: r.id, version: 1, model: 'FLAT', output: 'value' })),
    pending: [],
    skipped: [],
    ...proofExtra,
  } as unknown as ProofView;
  const out: Run = { invalid: [], unchecked: [] };
  definitionFindings(
    view,
    definitions,
    { invalid: (m) => out.invalid.push(m), unchecked: (m) => out.unchecked.push(m) },
    undefined,
    { tzdata: runtimeTzdata },
  );
  return out;
}

const vancouver = (extra: object): RuleDefinitionInput => ({
  ...ruleA,
  timeZone: 'America/Vancouver',
  ...extra,
});

describe('W1: the exact offset is used only under the database of the proof', () => {
  // 2026-11-05T07:30Z: Vancouver is 23:30 on the 4th at -08:00 (tzdata 2025c) and 00:30 on the 5th
  // at -07:00 (tzdata 2026c, where Vancouver stays on summer time).
  const at = '2026-11-05T07:30:00.000Z';
  const start = vancouver({ effectiveFrom: '2026-11-05' });
  const end = vancouver({ effectiveFrom: '2026-01-01', effectiveUntil: '2026-11-05' });

  it('the same release: decided, in both directions (start bound and end bound)', () => {
    // A zone no release changes (Paris is +01:00 in January), so the answer does not depend on
    // the database of the machine that runs the test.
    const startParis = { ...ruleA, timeZone: 'Europe/Paris', effectiveFrom: '2025-01-01' };
    const endParis = {
      ...ruleA,
      timeZone: 'Europe/Paris',
      effectiveFrom: '2024-01-01',
      effectiveUntil: '2025-01-01',
    };
    const early = '2024-12-31T23:30:00.000Z';
    expect(run([startParis], early, '2025c', '2025c')).toEqual({ invalid: [], unchecked: [] });
    expect(run([endParis], early, '2025c', '2025c')).toEqual({
      invalid: ['rule applied outside its window: r1@1'],
      unchecked: [],
    });
    const late = '2024-12-31T22:59:59.999Z';
    expect(run([startParis], late, '2025c', '2025c').invalid).toHaveLength(1);
    expect(run([endParis], late, '2025c', '2025c').invalid).toEqual([]);
  });

  it('another release: a notice, never a verdict, whichever way the databases differ', () => {
    const notice = ['window not checked: r1@1 (tzdata 2026c of the proof, 2025c here)'];
    expect(run([start], at, '2026c', '2025c')).toEqual({ invalid: [], unchecked: notice });
    expect(run([end], at, '2026c', '2025c')).toEqual({ invalid: [], unchecked: notice });
    const other = ['window not checked: r1@1 (tzdata 2025c of the proof, 2026c here)'];
    expect(run([start], at, '2025c', '2026c')).toEqual({ invalid: [], unchecked: other });
    expect(run([end], at, '2025c', '2026c')).toEqual({ invalid: [], unchecked: other });
  });

  it('no tzdata in the proof, or none named by the runtime: a notice', () => {
    expect(run([start], at, undefined, '2025c').unchecked).toEqual([
      'window not checked: r1@1 (no tzdata in the proof)',
    ]);
    expect(run([start], at, '2025c', undefined).unchecked).toEqual([
      'window not checked: r1@1 (this runtime does not name its tzdata)',
    ]);
  });

  it('a decision outside the bands needs no database: it stays decided under any release', () => {
    expect(run([start], '2020-01-01T00:00:00.000Z', '2026c', '2025c')).toEqual({
      invalid: ['rule applied outside its window: r1@1'],
      unchecked: [],
    });
    expect(run([start], '2030-01-01T00:00:00.000Z', undefined, undefined)).toEqual({
      invalid: [],
      unchecked: [],
    });
  });

  it('fixed offsets and a given calendar never look at the release', () => {
    const fixed = { ...ruleA, effectiveFrom: '2026-11-05', timeZone: '-08:00' };
    expect(run([fixed], at, undefined, undefined).invalid).toEqual([
      'rule applied outside its window: r1@1',
    ]);
  });

  it('several releases are grouped and named', () => {
    const rules = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      vancouver({ id, effectiveFrom: '2026-11-05' }),
    );
    expect(run(rules, at, '2026c', '2025c').unchecked).toEqual([
      "window not checked for 5 rules (tzdata of the proof differs from this runtime's: " +
        '2026c of the proof, 2025c here): a@1, b@1, c@1, d@1, e@1',
    ]);
  });

  it('end to end, a proof made under this runtime database is decided', () => {
    const content = withRuntimeTzdata(unsigned());
    content.evaluatedAt = '2020-06-01T00:00:00.000Z';
    const rule = vancouver({ effectiveFrom: '2025-01-01' });
    const proof = signProof(sealProof(unsalted(content)), RFC_SECRET, 'executor-1');
    expect(verifyProof(proof, { trustedKeys: TRUSTED, rules: [rule, ruleA] }).status).toBe(
      'invalid',
    );
  });
});

describe('W2: the formatter cache is bounded, and the zones of a proof are limited', () => {
  const variant = (n: number): string =>
    'America/Argentina/ComodRivadavia'
      .split('')
      .map((ch, i) =>
        n & (1 << (i % 30)) && (n >> (i % 30)) & 1 ? ch.toUpperCase() : ch.toLowerCase(),
      )
      .join('');

  it('every spelling of a zone shares one formatter; the names are bounded', () => {
    const before = intlCacheSizes();
    for (let n = 0; n < 5000; n++) {
      intlCalendar.toCivilDate('2025-01-01T00:00:00.000Z', variant(n * 7919 + 1));
    }
    const after = intlCacheSizes();
    expect(after.formatters - before.formatters).toBeLessThanOrEqual(1);
    expect(after.formatters).toBeLessThanOrEqual(512);
    expect(after.names).toBeLessThanOrEqual(512);
  });

  it('a flood of distinct zones never holds more than 512 formatters', () => {
    const zones = Intl.supportedValuesOf('timeZone');
    for (let i = 0; i < 1500; i++) {
      intlCalendar.toCivilDate('2025-01-01T00:00:00.000Z', zones[i % zones.length]!);
    }
    expect(intlCacheSizes().formatters).toBeLessThanOrEqual(512);
  });

  it('the bound evicts: lowered to 5, twenty zones leave at most 5 formatters', () => {
    const saved = intlCacheLimits.max;
    clearIntlCaches();
    intlCacheLimits.max = 5;
    try {
      const zones = Intl.supportedValuesOf('timeZone').slice(0, 20);
      for (const zone of zones) intlCalendar.toCivilDate('2025-01-01T00:00:00.000Z', zone);
      expect(intlCacheSizes().formatters).toBeLessThanOrEqual(5);
      expect(intlCacheSizes().names).toBeLessThanOrEqual(5);
      // An evicted zone is read again, correctly.
      expect(intlCalendar.toCivilDate('2025-01-01T00:30:00.000Z', zones[0]!)).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    } finally {
      intlCacheLimits.max = saved;
    }
  });

  it('a proof that names more zones than maxProofTimeZones is invalid, the limit named', () => {
    expect(MAX_PROOF_TIME_ZONES).toBe(64);
    const content = unsigned();
    content.ruleSets = [{ kind: 'local', timeZone: '+02:00' }];
    const proof = signProof(sealProof(unsalted(content)), RFC_SECRET, 'executor-1');
    expect(verifyProof(proof, { trustedKeys: TRUSTED })).toMatchObject({ status: 'authentic' });
    expect(verifyProof(proof, { trustedKeys: TRUSTED, maxProofTimeZones: 1 })).toEqual({
      status: 'invalid',
      issues: ['proof names 2 time zones, more than maxProofTimeZones (1)'],
    });
    expect(verifyProof(proof, { trustedKeys: TRUSTED, maxProofTimeZones: 2 }).status).toBe(
      'authentic',
    );
  });

  it('65 distinct zones exceed the default', () => {
    const content = unsigned();
    content.ruleSets = Array.from({ length: 65 }, (_, i) => ({
      kind: 'pack' as const,
      id: `p${String(i).padStart(2, '0')}`,
      version: '1',
      digest: 'a'.repeat(64),
      timeZone: `+${String(Math.floor(i / 6) + 1).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}`,
    }));
    const proof = signProof(sealProof(unsalted(content)), RFC_SECRET, 'executor-1');
    const out = verifyProof(proof, { trustedKeys: TRUSTED });
    expect(out.status).toBe('invalid');
    expect(out.issues[0]).toBe('proof names 66 time zones, more than maxProofTimeZones (64)');
  });
});

describe('W3: a Date is a slot under the prototype of a Date', () => {
  const under = (proto: object | null): Date => Object.setPrototypeOf(new Date(0), proto) as Date;
  class NotDate {}
  const FOREIGN: [string, () => Date][] = [
    ['Map.prototype', () => under(Map.prototype)],
    ['Array.prototype', () => under(Array.prototype)],
    ['an object', () => under({})],
    ['a class prototype', () => under(NotDate.prototype)],
  ];

  it.each(FOREIGN)('a Date under %s is refused, as a foreign prototype', (_name, make) => {
    const fake = make();
    expect(hasDateSlot(fake)).toBe(true);
    expect(dateTimeOf(fake)).toBeUndefined();
    expect(isPlainObject(fake)).toBe(false);
    expect(notADateMessage(fake)).toBe('a Date with a foreign prototype');
    const error = specError(() => canonicalize({ list: [{ at: fake }] }));
    expect(error.path).toBe('list[0].at');
    expect(error.message).toContain('a Date with a foreign prototype');
  });

  it('a Date whose prototype chain reaches Date.prototype stays a Date', () => {
    class Sub extends Date {}
    class SubSub extends Sub {}
    expect(dateTimeOf(new SubSub(7))).toBe(7);
    expect(notADateMessage(new SubSub(7))).toBeUndefined();
    expect(notADateMessage({})).toBeUndefined();
    expect(notADateMessage('x')).toBeUndefined();
  });

  it('a constructor named Date whose prototype is not that object does not make a Date prototype', () => {
    const impostor = { constructor: function Date() {} };
    expect(notADateMessage(under(impostor))).toBe('a Date with a foreign prototype');
    expect(dateTimeOf(under(impostor))).toBeUndefined();
  });

  it('the same text at a rule bound and at a date of an input', () => {
    const fake = under(Map.prototype);
    const rule = { id: 'r', version: 1, model: 'M', params: 1, priority: 1, effectiveFrom: fake };
    expect(() => normalizeRuleDefinition(rule as never)).toThrow(
      'got a Date with a foreign prototype',
    );
    const plain = under(Object.prototype);
    const issues = validateProofInput({
      data: {},
      meta: {
        tenantId: 't',
        dates: { effective: plain },
        tags: [],
        dimensions: {},
        context: {},
        assertions: {},
      },
    } as never);
    expect(issues.map((i) => i.message)).toEqual([
      '/meta/dates/effective must be a civil date YYYY-MM-DD or an instant YYYY-MM-DDTHH:MM:SS.sssZ; got a Date with a plain prototype',
    ]);
  });
});

describe('W6: a runtime that cannot read offsets says so, in a notice', () => {
  // The fakes must not stay in the caches of the real runtime.
  beforeEach(() => clearIntlCaches());
  afterEach(() => {
    vi.restoreAllMocks();
    clearIntlCaches();
  });

  const fakeFormatter = (offsetOf: (zone: string) => string) =>
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
      _locale: unknown,
      options: unknown,
    ) {
      const zone = (options as { timeZone: string }).timeZone;
      return {
        resolvedOptions: () => ({ timeZone: `Fake/${zone}` }),
        formatToParts: () => [{ type: 'timeZoneName', value: offsetOf(zone) }],
      } as never;
    } as never);

  const paris = { ...ruleA, timeZone: 'Atlantis/Poseidon' };
  const near = '2025-01-01T00:30:00.000Z';

  it('no time zone support at all: one notice, never invalid', () => {
    fakeFormatter(() => 'not an offset');
    const out = run([{ ...paris, effectiveFrom: '2025-01-01' }], near, '2025c', '2025c');
    expect(out).toEqual({
      invalid: [],
      unchecked: ['window not checked: r1@1 (this runtime cannot read time zone offsets)'],
    });
  });

  it('a runtime whose Intl refuses every time zone: the same notice, no zone is "unknown"', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
      throw new RangeError('Invalid time zone specified');
    } as never);
    const out = run([{ ...paris, effectiveFrom: '2025-01-01' }], near, '2025c', '2025c');
    expect(out).toEqual({
      invalid: [],
      unchecked: ['window not checked: r1@1 (this runtime cannot read time zone offsets)'],
    });
  });

  it('a zone whose offset cannot be read while others can: a notice, not "unknown"', () => {
    fakeFormatter((zone) => (zone === 'UTC' ? 'GMT+00:00' : 'UTC-06:00'));
    const out = run([{ ...paris, effectiveFrom: '2025-01-01' }], near, '2025c', '2025c');
    expect(out.invalid).toEqual([]);
    expect(out.unchecked).toEqual([
      'window not checked: r1@1 (this runtime cannot read time zone offsets)',
    ]);
  });

  it('parseOffset reads GMT, signed offsets with seconds and the true minus sign', () => {
    expect(parseOffset('GMT')).toBe(0);
    expect(parseOffset('GMT+00:00')).toBe(0);
    expect(parseOffset('GMT+05:30')).toBe(19_800_000);
    expect(parseOffset('GMT-03:30')).toBe(-12_600_000);
    expect(parseOffset('GMT−03:30')).toBe(-12_600_000);
    expect(parseOffset('GMT+14:58:47')).toBe(53_927_000);
    for (const bad of ['UTC-06:00', 'GMT+5', 'GMT+05:3', '', 'gmt+01:00', 'GMT+01:00:0']) {
      expect(parseOffset(bad)).toBeUndefined();
    }
  });
});

describe('W7: the guards that had no test', () => {
  const mars = (extra: object): RuleDefinitionInput => ({
    ...ruleA,
    timeZone: 'Mars/Olympus',
    ...extra,
  });

  it('an open window under an unknown zone is decided far inside it, and not at its start band', () => {
    const open = mars({ effectiveFrom: '2025-01-01' });
    expect(run([open], '2026-06-01T00:00:00.000Z', '2025c', '2025c')).toEqual({
      invalid: [],
      unchecked: [],
    });
    expect(run([open], '2025-01-01T12:00:00.000Z', '2025c', '2025c').unchecked).toEqual([
      'window not checked: r1@1 (zone Mars/Olympus unknown to this verifier)',
    ]);
  });

  it('150 distinct unknown zones are one notice that names the first three', () => {
    const rules = Array.from({ length: 150 }, (_, i) =>
      mars({
        id: `z${String(i).padStart(3, '0')}`,
        timeZone: `Planet/Zone${i}`,
        effectiveFrom: '2025-01-01',
      }),
    );
    const out = run(rules, '2025-01-01T12:00:00.000Z', '2025c', '2025c');
    expect(out.unchecked).toEqual([
      'window not checked for 150 rules (zone unknown to this verifier: Planet/Zone0, Planet/Zone1, Planet/Zone2, and 147 more): ' +
        'z000@1, z001@1, z002@1, z003@1, z004@1 and 145 more',
    ]);
  });

  it('two distinct unknown zones are grouped, both named', () => {
    const rules = [
      mars({ id: 'a', effectiveFrom: '2025-01-01' }),
      mars({ id: 'b', timeZone: 'Venus/Maxwell', effectiveFrom: '2025-01-01' }),
    ];
    expect(run(rules, '2025-01-01T12:00:00.000Z', '2025c', '2025c').unchecked).toEqual([
      'window not checked for 2 rules (zone unknown to this verifier: Mars/Olympus, Venus/Maxwell): a@1, b@1',
    ]);
  });

  it('options whose own keys cannot be read throw, never authentic', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('nope');
        },
      },
    );
    const error = specError(() => verifyProof(unsigned() as never, hostile as never));
    expect(error).toMatchObject({
      code: 'INVALID_PROOF',
      message: 'options could not be read: nope',
    });
    expect(NOT_REPLAYED).toBeDefined();
  });
});
