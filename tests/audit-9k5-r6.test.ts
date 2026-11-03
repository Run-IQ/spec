/**
 * Task 9K5, round 6 of the audit: the total bound of the options is held (AC2, AC5); the capture
 * sites that no other test reached (AC2); a throw from a proof getter or trap names its pointer
 * (AC3); an error of another call is foreign (AC4); `verifyAttestation` needs its trusted keys
 * (AC6); a `Date` built under fake timers is refused, and `createAttestation` reads the real
 * clock (AC8).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalize,
  createAttestation,
  isEffectiveAt,
  normalizeRuleDefinition,
  toExecutableRule,
  toReferenceDate,
  validateProof,
  verifyAttestation,
  verifyProof,
} from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';
import { optionsLimits } from '../src/values.js';
import { optionError, specError } from './helpers.js';
import { RFC_PUBLIC, RFC_SECRET, ruleA, ruleB, signed, TRUSTED } from './proof-cases.js';

type Options = Parameters<typeof verifyProof>[1];

describe('AC2, AC5: the total bound of the options', () => {
  const original = optionsLimits.nodes;
  afterEach(() => {
    optionsLimits.nodes = original;
  });
  const numbers = (n: number): RuleDefinitionInput => ({
    ...ruleA,
    id: `big${n}`,
    version: 3,
    params: { big: new Array<number>(n).fill(0) },
  });

  it('two rules that are each valid together exceed the total together: the call throws, naming the bound', () => {
    optionsLimits.nodes = 1000;
    // Each alone fits (a rule is about 15 values and 480 numbers), both together do not.
    const call = (rules: RuleDefinitionInput[]) =>
      verifyProof(signed(), { trustedKeys: TRUSTED, rules });
    expect(() => call([ruleA, ruleB, numbers(480)])).not.toThrow();
    const error = optionError(() =>
      call([ruleA, ruleB, numbers(480), { ...numbers(480), id: 'b2' }]),
    );
    expect(error.option).toBe('options');
    expect(error.message).toMatch(
      /^options are too large: more than 1000 values \(at options\.rules\[\d\]\)$/,
    );
  });

  it('the bound is the declared one: lowering it lowers the room, raising it raises it', () => {
    const rules = [ruleA, ruleB, numbers(600)];
    optionsLimits.nodes = 500;
    expect(optionError(() => verifyProof(signed(), { rules })).message).toContain(
      'more than 500 values',
    );
    optionsLimits.nodes = 5000;
    expect(() => verifyProof(signed(), { rules })).not.toThrow();
  });

  it('every trustedKeys entry counts, for verifyProof and verifyAttestation', () => {
    optionsLimits.nodes = 20;
    const keys: Record<string, string> = {};
    for (let i = 0; i < 40; i++) keys[`k${i}`] = RFC_PUBLIC;
    const proofError = optionError(() => verifyProof(signed(), { trustedKeys: keys }));
    expect(proofError.option).toBe('options');
    expect(proofError.message).toBe(
      'options are too large: more than 20 values (at options.trustedKeys)',
    );
    const digest = 'a'.repeat(64);
    const attestation = createAttestation(digest, RFC_SECRET, 'k1');
    const attError = optionError(() => verifyAttestation(attestation, digest, keys));
    expect(attError.option).toBe('trustedKeys');
    expect(attError.message).toBe(
      'trustedKeys are too large: more than 20 values (at trustedKeys)',
    );
    optionsLimits.nodes = 200;
    expect(verifyAttestation(attestation, digest, keys).status).toBe('authentic');
  });
});

describe('AC2, AC8: the capture sites under a forged or a fake Date', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('createAttestation reads the real clock for its default `at`, whatever the fake one says', () => {
    const real = new Date().getUTCFullYear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('1970-01-01T00:00:00.000Z'));
    try {
      const at = createAttestation('a'.repeat(64), RFC_SECRET, 'k1').at;
      expect(at.startsWith('1970')).toBe(false);
      expect(Number(at.slice(0, 4))).toBeGreaterThanOrEqual(real);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a forged Date does not change the clock, the parsing of a string date or the bounds', () => {
    const real = globalThis.Date;
    function Fake() {
      return { toISOString: () => '1999-01-01T00:00:00.000Z' };
    }
    Fake.UTC = () => 0;
    Fake.parse = () => 0;
    Fake.prototype = {};
    (globalThis as { Date: unknown }).Date = Fake;
    try {
      expect(createAttestation('a'.repeat(64), RFC_SECRET, 'k1').at.startsWith('1999')).toBe(false);
      expect(toReferenceDate('2025-01-01T00:00:00+01:00')).toBe('2024-12-31T23:00:00.000Z');
      const rule = toExecutableRule({
        ...ruleA,
        effectiveFrom: '2025-01-01T00:00:00Z',
      } as RuleDefinitionInput);
      expect(rule.effectiveFrom).toBeInstanceOf(real);
      expect(canonicalize({ at: rule.effectiveFrom })).toBe('{"at":"2025-01-01T00:00:00.000Z"}');
    } finally {
      (globalThis as { Date: unknown }).Date = real;
    }
  });

  it('a Date built under fake timers is refused (a subclass), and says so; strings and real Dates work', () => {
    const before = new Date(5);
    vi.useFakeTimers();
    try {
      const faked = new Date(5);
      for (const call of [
        () => canonicalize({ at: faked }),
        () => isEffectiveAt({ effectiveFrom: '2025-01-01' }, faked),
        () => normalizeRuleDefinition({ ...ruleA, effectiveFrom: faked } as RuleDefinitionInput),
      ]) {
        expect(specError(call).message).toContain('a Date with a foreign prototype');
      }
      // The ways out the README names: a Date made before the clock, or a string.
      expect(canonicalize({ at: before })).toBe('{"at":"1970-01-01T00:00:00.005Z"}');
      expect(toReferenceDate('1970-01-01T00:00:00.005Z')).toBe('1970-01-01T00:00:00.005Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AC3: a throw from the proof names its pointer', () => {
  const proof = (): Record<string, unknown> => JSON.parse(JSON.stringify(signed())) as never;

  it('a getter at the top level, a getter in a nested entry, a trap on an object', () => {
    const top = Object.defineProperty(proof(), 'requestId', {
      enumerable: true,
      get() {
        throw new Error('top boom');
      },
    });
    expect(verifyProof(top).issues).toEqual(['requestId could not be read: top boom']);

    const nested = proof() as { applied: object[] };
    Object.defineProperty(nested.applied[0]!, 'model', {
      enumerable: true,
      get() {
        throw new Error('deep boom');
      },
    });
    expect(verifyProof(nested).issues).toEqual(['applied[0].model could not be read: deep boom']);
    expect(validateProof(nested).issues).toEqual([
      { path: 'applied[0].model', message: 'applied[0].model could not be read: deep boom' },
    ]);

    const trap = {
      ...proof(),
      versions: new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('trap boom');
          },
        },
      ),
    };
    expect(verifyProof(trap).issues).toEqual(['versions could not be read: trap boom']);
  });

  it('the text is cut like any issue, with a marker', () => {
    const top = Object.defineProperty(proof(), 'requestId', {
      enumerable: true,
      get() {
        throw new Error(`long ${'q'.repeat(5000)}`);
      },
    });
    const [issue] = verifyProof(top).issues;
    expect(issue!.startsWith('requestId could not be read: long ')).toBe(true);
    expect(issue!.length).toBeLessThanOrEqual(1025);
  });
});

describe('AC4: an error raised by another call is foreign', () => {
  const own = optionError(() => verifyProof(signed(), { calender: 1 } as never));

  it('replayed from a trap or a getter, it is cited like any other value, at the place read', () => {
    const throwsOwn = () => {
      throw own;
    };
    const run = (options: unknown) => optionError(() => verifyProof(signed(), options as Options));
    const trapped = run(new Proxy({}, { ownKeys: throwsOwn }));
    expect(trapped.option).toBe('options');
    expect(trapped.message).toMatch(/^options could not be read: /);
    const keys = run({ trustedKeys: new Proxy({}, { ownKeys: throwsOwn }) });
    expect(keys.option).toBe('options.trustedKeys');
    const rule = {
      ...ruleA,
      get id(): never {
        return throwsOwn();
      },
    };
    expect(run({ rules: [rule] }).option).toBe('options.rules[0]');
    // And from verifyAttestation: its own path, never one of verifyProof.
    const digest = 'a'.repeat(64);
    const attestation = createAttestation(digest, RFC_SECRET, 'k1');
    const att = optionError(() =>
      verifyAttestation(attestation, digest, new Proxy({}, { ownKeys: throwsOwn }) as never),
    );
    expect(att.option).toBe('trustedKeys');
  });
});

describe('AC4: a nested call has a scope of its own', () => {
  it('an options error raised by a call made inside a trap is foreign to the outer call', () => {
    const trap = new Proxy(
      {},
      {
        ownKeys() {
          // A call of the package made by the caller's own code: its error, in its own scope.
          return verifyProof({}, { calender: 1 } as never) as never;
        },
      },
    );
    const error = optionError(() => verifyProof(signed(), { trustedKeys: trap } as never));
    expect(error.option).toBe('options.trustedKeys');
    expect(error.message.startsWith('options.trustedKeys could not be read: ')).toBe(true);
  });
});

describe('AC6: verifyAttestation needs its trusted keys', () => {
  it('undefined throws; an empty object trusts none', () => {
    const digest = 'a'.repeat(64);
    const attestation = createAttestation(digest, RFC_SECRET, 'k1');
    expect(
      optionError(() => verifyAttestation(attestation, digest, undefined as never)),
    ).toMatchObject({
      option: 'trustedKeys',
      message: 'trustedKeys is required: an object of hex public keys ({} trusts none)',
    });
    expect(verifyAttestation(attestation, digest, {})).toEqual({
      status: 'consistent',
      issues: ['untrusted key'],
    });
  });
});
