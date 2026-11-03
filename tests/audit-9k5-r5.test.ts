/**
 * Task 9K5, round 5 of the audit: the options have a budget of their own (AA1); the intrinsics
 * are captured at load (AA2); only errors this package created are trusted (AA3); an error of
 * any copy of the package is recognised (AA4); a runtime with a database that cannot read one
 * zone is not "without data" (AA5); the engine's tzdata is named (AA6); hidden keys of
 * `trustedKeys` are refused (AA7); `isEffectiveAt` names a Date under another prototype (AA9);
 * the calendar message and the generic rethrow are held (AA10); `verifyAttestation` throws for
 * the caller's mistakes (AA11).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalize,
  computeRuleChecksum,
  createAttestation,
  isEffectiveAt,
  sealProof,
  signProof,
  toReferenceDate,
  verifyAttestation,
  verifyProof,
  VerifyOptionsError,
} from '../src/index.js';
import { definitionFindings } from '../src/proof/definition-checks.js';
import { clearIntlCaches, intlRuntime } from '../src/proof/intl-calendar.js';
import * as windowModule from '../src/rule/window.js';
import { lastValuesSpent } from '../src/values.js';
import { isOwnOptionsError, newOptionsError, withOptionsScope } from '../src/errors.js';
import type { ProofView } from '../src/proof/types.js';
import { normalizeRuleDefinition } from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';
import { optionError } from './helpers.js';
import { withRuntimeTzdata } from './notices.js';
import { RFC_PUBLIC, RFC_SECRET, ruleA, ruleB, signed, unsalted, unsigned } from './proof-cases.js';

const TRUSTED = { 'executor-1': RFC_PUBLIC };
type Options = Parameters<typeof verifyProof>[1];
const boom = (message: string): never => {
  throw new Error(message);
};

describe('AA1: the options have a budget of their own', () => {
  it('the proof spends the same values whatever the options hold', () => {
    verifyProof(signed(), { trustedKeys: TRUSTED });
    const alone = lastValuesSpent();
    verifyProof(signed(), { trustedKeys: TRUSTED, rules: [ruleA, ruleB] });
    expect(lastValuesSpent()).toBe(alone);
    expect(alone).toBeGreaterThan(0);
  });
});

describe('AA2: the intrinsics are captured at load', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fake timers replacing globalThis.Date change nothing', () => {
    const before = new Date(5);
    vi.useFakeTimers();
    try {
      expect(canonicalize({ at: before })).toBe('{"at":"1970-01-01T00:00:00.005Z"}');
      expect(toReferenceDate(before)).toBe('1970-01-01T00:00:00.005Z');
      expect(isEffectiveAt({ effectiveFrom: before }, before)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a forged globalThis.Date does not make a plain object a Date', () => {
    const real = globalThis.Date;
    const before = new real(5);
    function Fake() {}
    Fake.prototype = { getTime: () => 86_400_000 };
    (globalThis as { Date: unknown }).Date = Fake;
    try {
      expect(canonicalize({ a: {} })).toBe('{"a":{}}');
      expect(() => canonicalize({ a: Object.create(Fake.prototype) as object })).toThrow(
        'an instance of Object',
      );
      expect(canonicalize({ a: before })).toBe('{"a":"1970-01-01T00:00:00.005Z"}');
      expect(toReferenceDate(before)).toBe('1970-01-01T00:00:00.005Z');
    } finally {
      (globalThis as { Date: unknown }).Date = real;
    }
  });

  it('a real Date under the forged prototype is still not a Date, and is named', () => {
    const real = globalThis.Date;
    function Fake() {}
    Fake.prototype = {};
    const odd = Object.setPrototypeOf(new real(5), Fake.prototype) as Date;
    (globalThis as { Date: unknown }).Date = Fake;
    try {
      expect(() => canonicalize({ a: odd })).toThrow('a Date with a foreign prototype');
      expect(() => toReferenceDate(odd)).toThrow('a Date with a foreign prototype');
    } finally {
      (globalThis as { Date: unknown }).Date = real;
    }
  });

  it('a replaced Date.prototype.getTime changes nothing', () => {
    const real = Date.prototype.getTime;
    Date.prototype.getTime = function () {
      return 0;
    };
    try {
      expect(canonicalize({ at: new Date(5) })).toBe('{"at":"1970-01-01T00:00:00.005Z"}');
    } finally {
      Date.prototype.getTime = real;
    }
  });

  it('a reassigned Intl.DateTimeFormat does not reach the verifier', () => {
    const paris = { ...ruleA, timeZone: 'Europe/Paris', effectiveFrom: '2025-01-01' };
    const content = withRuntimeTzdata(unsigned());
    content.evaluatedAt = '2024-12-31T22:30:00.000Z';
    content.rules = content.rules.map((r) =>
      r.id === 'r1' ? { ...r, checksum: computeRuleChecksum(paris) } : r,
    );
    const sealed = signProof(sealProof(unsalted(content)), RFC_SECRET, 'executor-1');
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
      throw new Error('replaced after load');
    } as never);
    const out = verifyProof(sealed, { trustedKeys: TRUSTED, rules: [paris, ruleB] });
    // 22:30Z on 31 December is 23:30 in Paris: before the window, decided by the real Intl.
    expect(out.status).toBe('invalid');
    expect(out.issues).toContain('rule applied outside its window: r1@1');
    expect(out.issues.some((m) => m.includes('replaced after load'))).toBe(false);
  });
});

describe('AA3: only the errors this package created are trusted', () => {
  const forged = () => new VerifyOptionsError('x', `raw\nuncited ${'z'.repeat(3000)}`);

  it('a caller-built VerifyOptionsError is not an own error', () => {
    expect(isOwnOptionsError(forged())).toBe(false);
    // Own only for the call that raised it, and only while that call runs.
    const [during, raised] = withOptionsScope(() => {
      const made = newOptionsError('o', 'm');
      return [isOwnOptionsError(made), made] as const;
    });
    expect(during).toBe(true);
    expect(isOwnOptionsError(raised)).toBe(false);
    expect(isOwnOptionsError(optionError(() => verifyProof(signed(), 5 as never)))).toBe(false);
  });

  it('the factory cuts the message and the option like an issue text', () => {
    const error = newOptionsError('o'.repeat(3000), `m${'x'.repeat(5000)}`);
    expect(error.option).toHaveLength(1025);
    expect(error.message).toHaveLength(1025);
    expect(error.message.endsWith('…')).toBe(true);
  });

  it('thrown from a getter of the proof: cited and cut, the verdict stays invalid', () => {
    const proof = signed() as unknown as Record<string, unknown>;
    const hostile = {
      ...proof,
      get requestId(): never {
        throw forged();
      },
    };
    const out = verifyProof(hostile);
    expect(out.status).toBe('invalid');
    for (const issue of out.issues) {
      expect(issue.length).toBeLessThanOrEqual(1025);
      expect(issue).not.toContain('\n');
    }
  });

  it('thrown by a calendar: wrapped, cited and cut, the option named', () => {
    const rule = { ...ruleA, timeZone: 'Atlantis/Poseidon', effectiveFrom: '2025-01-01' };
    const content = unsigned();
    content.evaluatedAt = '2025-01-01T00:30:00.000Z';
    content.rules = content.rules.map((r) =>
      r.id === 'r1' ? { ...r, checksum: computeRuleChecksum(rule) } : r,
    );
    const sealed = signProof(sealProof(unsalted(content)), RFC_SECRET, 'executor-1');
    const call = (thrown: () => never) => () =>
      verifyProof(sealed, {
        trustedKeys: TRUSTED,
        rules: [rule, ruleB],
        calendar: { toCivilDate: () => thrown(), startOfDay: () => '2025-01-01T00:00:00.000Z' },
      });
    const error = optionError(call(() => boom(`long ${'q'.repeat(5000)}`)));
    expect(error.option).toBe('options.calendar');
    expect(error.message.startsWith('options.calendar is not usable: ')).toBe(true);
    expect(error.message.length).toBeLessThanOrEqual(1025);
    expect(error.message.endsWith('…')).toBe(true);
    // A caller-built error from the calendar is wrapped too, never passed on as it is.
    const wrapped = optionError(
      call(() => {
        throw forged();
      }),
    );
    expect(wrapped.option).toBe('options.calendar');
    expect(wrapped.message).not.toContain('\n');
    expect(wrapped.message.length).toBeLessThanOrEqual(1025);
    // An error of this package thrown inside the calendar is the caller's too.
    const own = optionError(call(() => canonicalize({ a: Number.NaN }) as never));
    expect(own.option).toBe('options.calendar');
    expect(own.message).toBe(
      'options.calendar is not usable: Value at "a" cannot be serialized to canonical JSON: NaN',
    );
  });
});

describe('AA4: an error of any copy of the package is recognised', () => {
  it('a brand, like SpecError', () => {
    const other = Object.create(Error.prototype) as object;
    Object.defineProperty(other, Symbol.for('@run-iq/spec/VerifyOptionsError'), { value: true });
    expect(other instanceof VerifyOptionsError).toBe(true);
    expect(new Error('x') instanceof VerifyOptionsError).toBe(false);
    class Mine extends VerifyOptionsError {}
    expect(new VerifyOptionsError('o', 'm') instanceof Mine).toBe(false);
    expect(new Mine('o', 'm') instanceof Mine).toBe(true);
  });
});

/** `definitionFindings` of `paris` near its bound, the proof recording `components`. */
const paris = { ...ruleA, timeZone: 'Europe/Paris', effectiveFrom: '2025-01-01' };
const near = '2025-01-01T00:30:00.000Z';
const engine = { name: 'tzdata', version: '2025c', declaredBy: 'engine' };
function findings(definition: object = paris): { invalid: string[]; unchecked: string[] } {
  const view = {
    evaluatedAt: near,
    timeZone: 'UTC',
    ruleSets: [],
    versions: { components: [engine] },
    applied: [{ ruleId: 'r1', version: 1, model: 'FLAT', output: 'value' }],
    pending: [],
    skipped: [],
  } as unknown as ProofView;
  const out = { invalid: [] as string[], unchecked: [] as string[] };
  definitionFindings(
    view,
    new Map([['r1@1', normalizeRuleDefinition(definition as RuleDefinitionInput)]]),
    { invalid: (m) => out.invalid.push(m), unchecked: (m) => out.unchecked.push(m) },
    undefined,
    { tzdata: '2025c' },
  );
  return out;
}

describe('AA5, AA10: what the runtime cannot do, and the rethrow', () => {
  beforeEach(() => clearIntlCaches());
  afterEach(() => {
    vi.restoreAllMocks();
    clearIntlCaches();
  });
  const stub = (build: (zone: string) => object) =>
    vi.spyOn(intlRuntime, 'DateTimeFormat').mockImplementation(function (
      _l: unknown,
      options: unknown,
    ) {
      return build((options as { timeZone: string }).timeZone) as never;
    } as never);
  const text = (zone: string, value: string) => ({
    resolvedOptions: () => ({ timeZone: zone }),
    formatToParts: () => [{ type: 'timeZoneName', value }],
  });

  it('an unreadable offset text for every zone but UTC is not "no time zone data"', () => {
    stub((zone) => text(zone, zone === 'UTC' ? 'GMT+00:00' : '???'));
    expect(findings().unchecked).toEqual([
      'window not checked: r1@1 (this runtime cannot read time zone offsets)',
    ]);
  });

  it('a throw other than a RangeError on the probe zone is a limit, not "no data"', () => {
    stub((zone) => {
      if (zone === 'America/New_York') throw new TypeError('icu broke');
      return text(zone, 'GMT+01:00');
    });
    expect(findings().unchecked).toEqual([
      'window not checked: r1@1 (this runtime cannot read time zone offsets)',
    ]);
  });

  it('a RangeError on the probe zone only is "no time zone data"', () => {
    stub((zone) => {
      if (zone === 'America/New_York') throw new RangeError('Invalid time zone specified');
      return text(zone, 'GMT+01:00');
    });
    expect(findings().unchecked).toEqual([
      'window not checked: r1@1 (this runtime has no time zone data)',
    ]);
  });

  it('a failure of windowContains that is not the calendar is a failed check, never a notice', () => {
    vi.spyOn(windowModule, 'windowContains').mockImplementation(() => boom('window broke'));
    expect(findings()).toEqual({
      invalid: ['window check failed: window broke (r1@1)'],
      unchecked: [],
    });
  });
});

describe("AA7: every own key of trustedKeys is the caller's", () => {
  const call = (trustedKeys: unknown) => () => verifyProof(signed(), { trustedKeys } as Options);

  it('a non-enumerable key with a malformed value throws', () => {
    const keys = {};
    Object.defineProperty(keys, 'executor-1', { value: 'zz-not-a-key', enumerable: false });
    expect(optionError(call(keys))).toMatchObject({
      option: 'options.trustedKeys.executor-1',
      message: 'options.trustedKeys.executor-1 is not enumerable: it would not be read',
    });
  });

  it('a symbol key throws', () => {
    const keys = { [Symbol('k')]: 'zz' };
    expect(optionError(call(keys))).toMatchObject({
      option: 'options.trustedKeys.Symbol(k)',
      message: 'options.trustedKeys.Symbol(k) is not a key id: a symbol',
    });
  });

  it('an ownKeys that throws throws, never "no keys"', () => {
    const keys = new Proxy({}, { ownKeys: () => boom('ownKeys boom') });
    // A Proxy is read as a plain object only if its prototype is plain: it is.
    expect(optionError(call(keys))).toMatchObject({
      option: 'options.trustedKeys',
      message: 'options.trustedKeys could not be read: ownKeys boom',
    });
  });
});

describe('AA9: isEffectiveAt names a Date under another prototype', () => {
  it.each([
    ['a subclass', () => new (class Sub extends Date {})(5), 'a Date with a foreign prototype'],
    [
      'Object.prototype',
      () => Object.setPrototypeOf(new Date(5), Object.prototype) as Date,
      'a Date with a plain prototype',
    ],
    [
      'null',
      () => Object.setPrototypeOf(new Date(5), null) as Date,
      'a Date with a plain prototype',
    ],
  ])('%s', (_name, make, message) => {
    expect(() => isEffectiveAt({ effectiveFrom: '2025-01-01' }, make())).toThrow(message);
  });

  it('a value that is no Date at all keeps the generic text', () => {
    expect(() => isEffectiveAt({ effectiveFrom: '2025-01-01' }, 'x' as never)).toThrow(
      'at must be a valid Date',
    );
  });
});

describe("AA11: verifyAttestation throws for the caller's mistakes", () => {
  const digest = 'a'.repeat(64);
  const attestation = () => createAttestation(digest, RFC_SECRET, 'reviewer');
  const ok = { reviewer: RFC_PUBLIC };

  it('a digest that is not 64 lowercase hex characters', () => {
    for (const bad of ['abc', `${digest}0`, 5, undefined]) {
      expect(optionError(() => verifyAttestation(attestation(), bad as never, ok))).toMatchObject({
        code: 'INVALID_OPTIONS',
        option: 'proofDigest',
      });
    }
  });

  it('trustedKeys that are not an object, unreadable, hidden or malformed', () => {
    const run = (keys: unknown) => () => verifyAttestation(attestation(), digest, keys as never);
    expect(optionError(run('keys')).option).toBe('trustedKeys');
    expect(optionError(run(new Proxy({}, { ownKeys: () => boom('x') }))).option).toBe(
      'trustedKeys',
    );
    const hidden = {};
    Object.defineProperty(hidden, 'reviewer', { value: 'zz', enumerable: false });
    expect(optionError(run(hidden)).option).toBe('trustedKeys.reviewer');
    expect(optionError(run({ [Symbol('k')]: 'zz' })).option).toBe('trustedKeys.Symbol(k)');
    expect(optionError(run({ reviewer: 'zz' })).option).toBe('trustedKeys.reviewer');
    expect(optionError(run({ ...ok, other: 'q' })).option).toBe('trustedKeys.other');
  });

  it("the attestation's own faults stay verdicts, and the arguments are read first", () => {
    const body = { ...attestation(), signature: 'A'.repeat(86) };
    expect(verifyAttestation(body, digest, ok).status).toBe('invalid');
    expect(verifyAttestation(5, digest, ok).status).toBe('invalid');
    // A mistake in the arguments is reported even when the attestation is also wrong.
    expect(() => verifyAttestation(5, 'abc', ok)).toThrow(VerifyOptionsError);
    expect(verifyAttestation(attestation(), digest, ok)).toEqual({
      status: 'authentic',
      issues: [],
    });
  });
});
