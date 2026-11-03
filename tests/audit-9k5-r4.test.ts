/**
 * Task 9K5, round 4 of the audit: every mistake of the caller in the options throws
 * `VerifyOptionsError` (Y1); every fault of the runtime is a notice (Y2); a Date is the slot under
 * `Date.prototype`, checked in one step (Y3, Y4); one engine-recorded `tzdata` decides (Y5); the
 * sign class of an offset (Y7); the two mutants of round 4 (Y8); the bound of the notices derived
 * from the code (Y9).
 */
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalize,
  computeRuleChecksum,
  normalizeRuleDefinition,
  sealProof,
  signProof,
  SpecError,
  toReferenceDate,
  validateProofInput,
  verifyProof,
  VerifyOptionsError,
} from '../src/index.js';
import * as canonicalEntry from '../src/canonical-entry.js';
import type { RuleDefinitionInput } from '../src/index.js';
import { definitionFindings, WINDOW_KINDS } from '../src/proof/definition-checks.js';
import { clearIntlCaches, parseOffset, runtimeTzdata } from '../src/proof/intl-calendar.js';
import { LIFTS } from '../src/proof/lifts.js';
import type { ProofView } from '../src/proof/types.js';
import { dateTimeOf, hasDateSlot, notADateMessage } from '../src/values.js';
import { handSealed, optionError } from './helpers.js';
import { withRuntimeTzdata } from './notices.js';
import { RFC_PUBLIC, RFC_SECRET, ruleA, ruleB, unsalted, unsigned } from './proof-cases.js';

const TRUSTED = { 'executor-1': RFC_PUBLIC };
const proof = () => signProof(sealProof(unsalted(unsigned())), RFC_SECRET, 'executor-1');
type Options = Parameters<typeof verifyProof>[1];
const call = (options: unknown) => () => verifyProof(proof(), options as Options);
const boom = (message: string): never => {
  throw new Error(message);
};

describe('Y1: VerifyOptionsError', () => {
  it('is a SpecError with its own code, the option named, exported by both entries', () => {
    const error = new VerifyOptionsError('options.rules', 'options.rules must be an array');
    expect(error).toBeInstanceOf(SpecError);
    expect(error.code).toBe('INVALID_OPTIONS');
    expect(error.name).toBe('VerifyOptionsError');
    expect(error.option).toBe('options.rules');
    expect(canonicalEntry.VerifyOptionsError).toBe(VerifyOptionsError);
  });

  it.each([
    ['null', null],
    ['a number', 5],
    ['a string', 'trusted'],
    ['an array', []],
    ['an object that inherits its keys', Object.create({ trustedKeys: TRUSTED })],
  ])('options that are %s throw', (_name, options) => {
    expect(optionError(call(options))).toMatchObject({
      code: 'INVALID_OPTIONS',
      option: 'options',
      message: 'options must be an object { trustedKeys?, rules?, calendar?, maxProofTimeZones? }',
    });
  });

  it.each([
    ['a number', 5],
    ['a string', 'Europe/Paris'],
    ['null', null],
    ['an object without the functions', { toCivilDate: () => '2025-01-01' }],
  ])('a calendar that is %s throws', (_name, calendar) => {
    expect(optionError(call({ calendar }))).toMatchObject({
      option: 'options.calendar',
      message: 'options.calendar must be a calendar { toCivilDate, startOfDay }',
    });
  });

  it('a calendar whose getter throws throws, the option named', () => {
    const calendar = {
      get toCivilDate(): never {
        return boom('getter');
      },
      startOfDay: () => '2025-01-01T00:00:00.000Z',
    };
    expect(optionError(call({ calendar }))).toMatchObject({
      option: 'options.calendar',
      message: 'options.calendar could not be read: getter',
    });
  });

  it('the calendar is read once: a getter that answers differently later is not consulted', () => {
    let reads = 0;
    const calendar = {
      get toCivilDate(): () => string {
        reads++;
        return (reads === 1 ? () => '2025-01-01' : 5) as () => string;
      },
      startOfDay: () => '2025-01-01T00:00:00.000Z',
    };
    const rule = { ...ruleA, timeZone: 'Atlantis/Poseidon', effectiveFrom: '2025-01-01' };
    const content = unsigned();
    content.evaluatedAt = '2025-01-01T00:30:00.000Z';
    content.rules = content.rules.map((r) =>
      r.id === 'r1' ? { ...r, checksum: computeRuleChecksum(rule) } : r,
    );
    const sealed = signProof(sealProof(unsalted(content)), RFC_SECRET, 'executor-1');
    const out = verifyProof(sealed, { trustedKeys: TRUSTED, rules: [rule, ruleB], calendar });
    expect(out.status).not.toBe('invalid');
    expect(reads).toBe(1);
  });

  it('a calendar that throws, or answers with something that is not a date, throws', () => {
    const rule = { ...ruleA, timeZone: 'Atlantis/Poseidon', effectiveFrom: '2025-01-01' };
    const content = unsigned();
    content.evaluatedAt = '2025-01-01T00:30:00.000Z';
    content.rules = content.rules.map((r) =>
      r.id === 'r1' ? { ...r, checksum: computeRuleChecksum(rule) } : r,
    );
    const sealed = signProof(sealProof(unsalted(content)), RFC_SECRET, 'executor-1');
    const start = () => '2025-01-01T00:00:00.000Z';
    const verify = (calendar: unknown) =>
      optionError(() =>
        verifyProof(sealed, { trustedKeys: TRUSTED, rules: [rule, ruleB], calendar } as Options),
      );
    expect(verify({ toCivilDate: () => boom('cal boom'), startOfDay: start })).toMatchObject({
      code: 'INVALID_OPTIONS',
      option: 'options.calendar',
      message: 'options.calendar is not usable: cal boom',
    });
    const garbage = verify({ toCivilDate: () => 5, startOfDay: start });
    expect(garbage.option).toBe('options.calendar');
    expect(garbage.message).toContain(
      'options.calendar is not usable: calendar.toCivilDate returned',
    );
  });

  it('trustedKeys that are not an object, and a getter on one key, throw', () => {
    expect(optionError(call({ trustedKeys: 'abc' }))).toMatchObject({
      option: 'options.trustedKeys',
      message: 'options.trustedKeys must be an object of hex public keys',
    });
    const keys = {
      get 'executor-1'(): never {
        return boom('tk boom');
      },
    };
    expect(optionError(call({ trustedKeys: keys }))).toMatchObject({
      option: 'options.trustedKeys.executor-1',
      message: 'options.trustedKeys.executor-1 could not be read: tk boom',
    });
  });

  it('rules that are not a list, a Proxy list, a rule that is not valid, a duplicate throw', () => {
    expect(optionError(call({ rules: {} }))).toMatchObject({
      option: 'options.rules',
      message: 'options.rules must be an array',
    });
    const proxy = new Proxy([], { get: () => boom('rules boom') });
    expect(optionError(call({ rules: proxy }))).toMatchObject({
      option: 'options.rules',
      message: 'options.rules could not be read: rules boom',
    });
    expect(optionError(call({ rules: [ruleA, { nope: 1 }] }))).toMatchObject({
      option: 'options.rules[1]',
    });
    expect(optionError(call({ rules: [ruleA, ruleA] }))).toMatchObject({
      option: 'options.rules[1]',
      message: 'options.rules[1] repeats the rule r1@1',
    });
  });

  it('the options are checked before the proof is read: a hostile proof does not hide them', () => {
    const hostile = new Proxy({}, { ownKeys: () => boom('proof boom') });
    expect(() => verifyProof(hostile, { calender: {} } as Options)).toThrow(VerifyOptionsError);
    expect(verifyProof(hostile, { trustedKeys: TRUSTED })).toEqual({
      status: 'invalid',
      issues: ['proof could not be read: proof boom'],
    });
  });

  it('no mistake of the caller is ever INVALID_PROOF', () => {
    for (const options of [5, { rules: 'x' }, { trustedKeys: { a: 'zz' } }, { calender: 1 }]) {
      expect(optionError(call(options)).code).toBe('INVALID_OPTIONS');
    }
  });
});

/** `definitionFindings` of rules against a proof naming `components`, under a runtime. */
function run(
  rules: RuleDefinitionInput[],
  evaluatedAt: string,
  components: object[],
  runtimeTzdata: string | undefined,
): { invalid: string[]; unchecked: string[] } {
  const definitions = new Map(rules.map((r) => [`${r.id}@1`, normalizeRuleDefinition(r)]));
  const view = {
    evaluatedAt,
    timeZone: 'UTC',
    ruleSets: [],
    versions: { components },
    applied: rules.map((r) => ({ ruleId: r.id, version: 1, model: 'FLAT', output: 'value' })),
    pending: [],
    skipped: [],
  } as unknown as ProofView;
  const out = { invalid: [] as string[], unchecked: [] as string[] };
  definitionFindings(
    view,
    definitions,
    { invalid: (m) => out.invalid.push(m), unchecked: (m) => out.unchecked.push(m) },
    undefined,
    { tzdata: runtimeTzdata },
  );
  return out;
}

const paris = { ...ruleA, timeZone: 'Europe/Paris', effectiveFrom: '2025-01-01' };
const near = '2025-01-01T00:30:00.000Z';
const engine = (version: string) => ({ name: 'tzdata', version, declaredBy: 'engine' });

describe('Y2: a fault of the runtime is a notice naming what could not be checked', () => {
  beforeEach(() => clearIntlCaches());
  afterEach(() => {
    vi.restoreAllMocks();
    clearIntlCaches();
  });

  const stub = (build: (zone: string) => object) =>
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (_l: unknown, options: unknown) {
      return build((options as { timeZone: string }).timeZone) as never;
    } as never);
  const reads = (zone: string) => ({
    resolvedOptions: () => ({ timeZone: zone }),
    formatToParts: () => [{ type: 'timeZoneName', value: 'GMT+01:00' }],
  });

  it('formatToParts that throws for the zone: a notice, never invalid', () => {
    stub((zone) =>
      zone === 'Europe/Paris'
        ? {
            resolvedOptions: () => ({ timeZone: zone }),
            formatToParts: () => boom('icu broke'),
          }
        : reads(zone),
    );
    expect(run([paris], near, [engine('2025c')], '2025c')).toEqual({
      invalid: [],
      unchecked: ['window not checked: r1@1 (this runtime cannot read time zone offsets)'],
    });
  });

  it('a runtime that knows UTC only: no time zone data, not "zone unknown"', () => {
    stub((zone) => {
      if (zone !== 'UTC') throw new RangeError('Invalid time zone specified');
      return reads(zone);
    });
    expect(run([paris], near, [engine('2025c')], '2025c')).toEqual({
      invalid: [],
      unchecked: ['window not checked: r1@1 (this runtime has no time zone data)'],
    });
  });

  it('a resolvedOptions that throws is a limit of the runtime, not an unknown zone', () => {
    stub((zone) => ({
      resolvedOptions: () => (zone === 'Europe/Paris' ? boom('ro boom') : { timeZone: zone }),
      formatToParts: () => [{ type: 'timeZoneName', value: 'GMT+01:00' }],
    }));
    expect(run([paris], near, [engine('2025c')], '2025c').unchecked).toEqual([
      'window not checked: r1@1 (this runtime cannot read time zone offsets)',
    ]);
  });

  it('a zone the runtime refuses, where it has a database, is unknown', () => {
    stub((zone) => {
      if (zone === 'Atlantis/Poseidon') throw new RangeError('Invalid time zone specified');
      return reads(zone);
    });
    const atlantis = { ...paris, timeZone: 'Atlantis/Poseidon' };
    expect(run([atlantis], near, [engine('2025c')], '2025c').unchecked).toEqual([
      'window not checked: r1@1 (zone Atlantis/Poseidon unknown to this verifier)',
    ]);
  });

  it('process.versions that throws: the release is not known, said in a notice', () => {
    const real = Object.getOwnPropertyDescriptor(process, 'versions')!;
    const content = withRuntimeTzdata(unsigned());
    content.evaluatedAt = near;
    content.rules = content.rules.map((r) =>
      r.id === 'r1' ? { ...r, checksum: computeRuleChecksum(paris) } : r,
    );
    const sealed = signProof(sealProof(unsalted(content)), RFC_SECRET, 'executor-1');
    Object.defineProperty(process, 'versions', {
      configurable: true,
      get: () => boom('versions boom'),
    });
    try {
      expect(runtimeTzdata()).toBeUndefined();
      const out = verifyProof(sealed, { trustedKeys: TRUSTED, rules: [paris, ruleB] });
      expect(out.status).not.toBe('invalid');
      expect(out.issues).toContain(
        'window not checked: r1@1 (this runtime does not name its tzdata)',
      );
    } finally {
      Object.defineProperty(process, 'versions', real);
    }
  });
});

describe('Y3 and Y4: a Date is the slot under Date.prototype, in one step', () => {
  const handler: ProxyHandler<object> = {
    getPrototypeOf: () => new Proxy({}, handler),
  };
  const endless = (): object => Object.create(new Proxy({}, handler)) as object;

  it('an endless prototype chain returns at once, everywhere a value is read', () => {
    const started = Date.now();
    expect(() => canonicalize({ a: endless() })).toThrow();
    expect(() => toReferenceDate(endless() as never)).toThrow();
    const issues = validateProofInput({
      data: { a: endless() },
      meta: { tenantId: 't', dates: {}, tags: [], dimensions: {}, context: {}, assertions: {} },
    } as never);
    expect(issues.length).toBeGreaterThan(0);
    const tampered = JSON.parse(JSON.stringify(proof())) as {
      applied: { contribution?: unknown }[];
    };
    tampered.applied[0]!.contribution = endless();
    expect(verifyProof(tampered).status).toBe('invalid');
    const rule = { ...ruleA, params: { a: endless() } };
    expect(() => computeRuleChecksum(rule as never)).toThrow();
    expect(
      optionError(() => verifyProof(proof(), { rules: [rule as never] } as Options)).option,
    ).toBe('options.rules[0]');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('a counterfeit class or function named Date is not Date.prototype', () => {
    class Date {}
    const viaClass = Object.setPrototypeOf(new globalThis.Date(7), Date.prototype);
    const fn = Object.defineProperty(function () {}, 'name', { value: 'Date' }) as {
      prototype: object;
    };
    const viaFunction = Object.setPrototypeOf(new globalThis.Date(7), fn.prototype);
    for (const fake of [viaClass, viaFunction]) {
      expect(dateTimeOf(fake)).toBeUndefined();
      expect(notADateMessage(fake)).toBe('a Date with a foreign prototype');
      expect(() => toReferenceDate(fake as never)).toThrow('a Date with a foreign prototype');
    }
    // No slot, no Date: a class named Date, without the slot, is a plain refusal.
    expect(dateTimeOf(Object.create(Date.prototype))).toBeUndefined();
    expect(hasDateSlot(Object.create(Date.prototype))).toBe(false);
  });

  it('only Date.prototype of this realm: not a subclass, not another realm', () => {
    expect(dateTimeOf(new globalThis.Date(7))).toBe(7);
    // The prototype alone is not a Date: the slot is what holds the time.
    expect(dateTimeOf(Object.create(globalThis.Date.prototype))).toBeUndefined();
    expect(hasDateSlot(Object.create(globalThis.Date.prototype))).toBe(false);
    class Sub extends globalThis.Date {}
    expect(dateTimeOf(new Sub(7))).toBeUndefined();
    expect(dateTimeOf(runInNewContext('new Date(7)'))).toBeUndefined();
  });
});

describe('Y5: one tzdata release, recorded by the engine', () => {
  it('a proof that records two releases is invalid, with or without rules', () => {
    const content = unsigned();
    content.versions.components = [engine('2025c'), engine('2026c')];
    const verdict = verifyProof(handSealed(content));
    expect(verdict.status).toBe('invalid');
    expect(verdict.issues).toContain(
      'tzdata recorded 2 times by the engine: one release is allowed',
    );
  });

  it('a tzdata declared by a plugin or a model is never used to decide', () => {
    for (const declaredBy of ['plugin:x', 'model:x']) {
      const other = { name: 'tzdata', version: '2025c', declaredBy };
      expect(run([paris], near, [other], '2025c').unchecked).toEqual([
        'window not checked: r1@1 (no tzdata in the proof)',
      ]);
    }
    // The engine's release decides even when a plugin names another.
    const plugin = { name: 'tzdata', version: '2026c', declaredBy: 'plugin:x' };
    expect(run([paris], near, [engine('2025c'), plugin], '2025c')).toEqual({
      invalid: [],
      unchecked: [],
    });
  });
});

describe('Y7: the sign of an offset is + , - or the true minus sign, nothing between', () => {
  it('reads the three signs', () => {
    expect(parseOffset('GMT+05:00')).toBe(18_000_000);
    expect(parseOffset('GMT-05:00')).toBe(-18_000_000);
    expect(parseOffset('GMT\u221205:00')).toBe(-18_000_000);
  });

  it.each(['.', ',', '0', '5', 'A', '/', '\u2211', '\u2210'])('%s is not a sign', (ch) => {
    expect(parseOffset(`GMT${ch}07:00`)).toBeUndefined();
  });
});

describe('Y8: what the two surviving mutants of round 4 needed', () => {
  it('a release in another letter case is another release (a notice)', () => {
    expect(run([paris], near, [engine('2026C')], '2026c').unchecked).toEqual([
      'window not checked: r1@1 (tzdata 2026C of the proof, 2026c here)',
    ]);
  });

  it.each(['tz', 'tzdata-extra', 'TZDATA', 'tzdat'])(
    'a component named %s is not the tzdata component',
    (name) => {
      const near = { name, version: '2025c', declaredBy: 'engine' };
      expect(run([paris], '2025-01-01T00:30:00.000Z', [near], '2025c').unchecked).toEqual([
        'window not checked: r1@1 (no tzdata in the proof)',
      ]);
    },
  );
});

describe('Y9: the bound of the notices is derived from the code', () => {
  const causes: [string, () => string[]][] = [
    [
      'effectiveOn is not the decision date',
      () => scenario({ ...paris, effectiveOn: '/$dates/born' }),
    ],
    [WINDOW_KINDS[1], () => scenario(paris, null)],
    [WINDOW_KINDS[2], () => scenario({ ...paris, timeZone: 'Mars/Olympus' })],
    [
      "tzdata of the proof differs from this runtime's",
      () => scenario(paris, near, [engine('2024a')], '2025c'),
    ],
    [WINDOW_KINDS[4], () => scenario(paris, near, [], '2025c')],
    [WINDOW_KINDS[5], () => scenario(paris, near, [engine('2025c')])],
    [
      'the day holds the bound of the window',
      () =>
        scenario(
          {
            ...paris,
            effectiveFrom: '2025-01-01T12:00:00.000Z',
            effectiveUntil: '2025-12-01T00:00:00.000Z',
          },
          '2025-01-01',
          [engine('2025c')],
          '2025c',
        ),
    ],
  ];
  function scenario(
    rule: object,
    at: string | null = near,
    components: object[] = [engine('2025c')],
    tz?: string,
  ): string[] {
    const definition = normalizeRuleDefinition(rule as RuleDefinitionInput);
    const view = {
      evaluatedAt: at,
      timeZone: 'UTC',
      ruleSets: [],
      versions: { components },
      applied: [{ ruleId: 'r1', version: 1, model: 'FLAT', output: 'value' }],
      pending: [],
      skipped: [],
    } as unknown as ProofView;
    const unchecked: string[] = [];
    definitionFindings(
      view,
      new Map([['r1@1', definition]]),
      { invalid: () => undefined, unchecked: (m) => unchecked.push(m) },
      undefined,
      { tzdata: tz },
    );
    return unchecked;
  }

  it('every cause that can be triggered is one of WINDOW_KINDS, and each kind is reached', () => {
    const reached = new Set<string>();
    const texts = [
      'effectiveOn is /$dates/born',
      '(no evaluatedAt)',
      'zone Mars/Olympus unknown to this verifier',
      'tzdata 2024a of the proof, 2025c here',
      '(no tzdata in the proof)',
      '(this runtime does not name its tzdata)',
      '(the day holds the bound of the window)',
    ];
    causes.forEach(([kind, make], i) => {
      const notices = make();
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(texts[i]);
      reached.add(kind);
    });
    expect(WINDOW_KINDS.filter((kind) => !reached.has(kind)).sort()).toEqual([
      'this runtime cannot read time zone offsets',
      'this runtime has no time zone data',
    ]);
    expect(causes.every(([kind]) => (WINDOW_KINDS as readonly string[]).includes(kind))).toBe(true);
  });

  it('a verdict that is not invalid stays under the 100-message limit by the kinds of the code', () => {
    const reasons = 20 + 1;
    const redactions = 3 + 1;
    const global = 2;
    const warnings = 3;
    const lifted = Object.keys(LIFTS).length;
    expect(WINDOW_KINDS.length + reasons + redactions + global + warnings + lifted).toBeLessThan(
      100,
    );
  });
});
