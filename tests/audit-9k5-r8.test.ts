/**
 * Round 8 of the audit of 9K5 (AG1 to AG7): the line between the two attackers.
 *
 * - Data only (proofs, rules, JSON, a prototype polluted with plain values, writable or
 *   read-only): in scope, and held by the tests below and by `tests/heavy/prototype-pollution`.
 * - Code in the same realm after load (a swapped prototype of `Array.prototype`, a Proxy on the
 *   chain, a setter): out of scope for phase 2 (ruling of round 8). The probes that show it are
 *   `it.fails`, so that the limit is visible and the day it closes shows up (phase 3: isolation).
 */
import { describe, expect, it } from 'vitest';
import {
  fromStoredRecord,
  normalizeOutputDeclaration,
  normalizeReferential,
  computeReferentialDigest,
  toExecutableRule,
  validateReferential,
  canonicalRulePayload,
} from '../src/index.js';
import { createHash } from 'node:crypto';
import { runPure } from './corpus.js';
import { ueReferential } from './helpers.js';
import { ruleA } from './proof-cases.js';

const define = Object.defineProperty;
const bare = (fields: PropertyDescriptor): PropertyDescriptor =>
  Object.setPrototypeOf(fields, null) as PropertyDescriptor;

/** Runs `body` with `holder[key]` replaced by `descriptor`, then restores it. */
function planted<T>(
  holder: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
  body: () => T,
): T {
  const original = Object.getOwnPropertyDescriptor(holder, key);
  define(holder, key, bare({ configurable: true, ...descriptor }));
  try {
    return body();
  } finally {
    if (original === undefined) Reflect.deleteProperty(holder, key);
    else define(holder, key, original);
  }
}

const baseline = runPure();
const SPEC_SRC = new URL('../src/', import.meta.url).pathname;
const fromSpec = (): boolean =>
  (new Error().stack ?? '')
    .split('\n')
    .slice(1, 8)
    .some((l) => l.includes(SPEC_SRC));

describe('data only: a read-only or writable plain value on the prototypes changes no write spec makes', () => {
  const stored = () => {
    const payload = canonicalRulePayload(ruleA);
    return {
      id: ruleA.id,
      version: ruleA.version,
      checksum: createHash('sha256').update(payload, 'utf8').digest('hex'),
      payload,
    };
  };

  it.each([true, false])(
    'checksum on Object.prototype (writable: %s): the rule keeps its own',
    (writable) => {
      const expected = toExecutableRule(ruleA).checksum;
      const got = planted(Object.prototype, 'checksum', { value: 'EVIL', writable }, () => ({
        direct: toExecutableRule(ruleA),
        stored: fromStoredRecord(stored()),
      }));
      expect(Object.prototype.hasOwnProperty.call(got.direct, 'checksum')).toBe(true);
      expect(got.direct.checksum).toBe(expected);
      expect(got.stored.checksum).toBe(expected);
    },
  );

  it.each(['from', 'until', 'sourceRef'])(
    '%s on Object.prototype, read-only: a referential keeps its periods',
    (key) => {
      const clean = [
        computeReferentialDigest(ueReferential()),
        JSON.stringify(normalizeReferential(ueReferential())),
      ];
      const dirty = planted(Object.prototype, key, { value: 'EVIL', writable: false }, () => [
        computeReferentialDigest(ueReferential()),
        JSON.stringify(normalizeReferential(ueReferential())),
      ]);
      expect(dirty).toEqual(clean);
    },
  );

  it('ledger read-only on Set.prototype and Object.prototype: a proof is judged as before', () => {
    for (const holder of [Set.prototype, Object.prototype]) {
      const results = planted(holder, 'ledger', { value: 'EVIL', writable: false }, runPure);
      expect(results).toEqual(baseline);
    }
  });

  it('name read-only on Error.prototype (a frozen Error.prototype): an error still carries its name', () => {
    const results = planted(Error.prototype, 'name', { value: 'Error', writable: false }, runPure);
    expect(results).toEqual(baseline);
  });

  it('a cycle is named from the path, with Array.prototype[0] and [1] read-only', () => {
    const cycle = () =>
      JSON.stringify(
        validateReferential({
          format: 'run-iq.referential/1',
          id: 'cycle',
          version: '1',
          dimension: 'd',
          groups: {
            A: { exhaustive: true, members: [{ value: 'B' }] },
            B: { exhaustive: true, members: [{ value: 'C' }] },
            C: { exhaustive: true, members: [{ value: 'A' }] },
          },
        }),
      );
    const clean = cycle();
    expect(clean).toContain('A > B > C > A');
    const dirty = planted(Array.prototype, 0, { value: 'EVIL', writable: false }, () =>
      planted(Array.prototype, 1, { value: 'EVIL', writable: false }, cycle),
    );
    expect(dirty).toBe(clean);
  });

  it('an array is built whatever an index of Object.prototype or Array.prototype holds', () => {
    for (const holder of [Object.prototype, Array.prototype]) {
      for (const index of ['0', '1', '2']) {
        const results = planted(holder, index, { value: 'EVIL', writable: false }, () =>
          JSON.stringify(
            normalizeOutputDeclaration({ type: 'enum', combine: 'max', values: ['a', 'b'] }),
          ),
        );
        expect(results).toBe('{"type":"enum","combine":"max","values":["a","b"]}');
      }
    }
  });
});

describe('code in the same realm: out of scope for phase 2 (ruling of round 8), kept as it.fails', () => {
  it.fails('AG1: a prototype of Array.prototype with index setters swallows spec writes', () => {
    const evil = Object.create(Object.prototype) as object;
    for (let i = 0; i < 64; i++) {
      define(
        evil,
        String(i),
        bare({
          configurable: true,
          get: () => undefined,
          set(this: object, value: unknown) {
            if (!fromSpec())
              define(
                this,
                String(i),
                bare({ value, writable: true, configurable: true, enumerable: true }),
              );
          },
        }),
      );
    }
    const original = Object.getPrototypeOf(Array.prototype) as object;
    Object.setPrototypeOf(Array.prototype, evil);
    let results: string[];
    try {
      results = runPure();
    } finally {
      Object.setPrototypeOf(Array.prototype, original);
    }
    expect(results).toEqual(baseline);
  });

  it.fails('AG2: a Proxy on the chain answers "not here" and swallows the write', () => {
    const proxy = new Proxy(Object.create(Object.prototype) as object, {
      set(target, key, value, receiver) {
        if (fromSpec()) return true;
        return Reflect.set(target, key, value, receiver);
      },
    });
    const original = Object.getPrototypeOf(Array.prototype) as object;
    Object.setPrototypeOf(Array.prototype, proxy);
    let results: string[];
    try {
      results = runPure();
    } finally {
      Object.setPrototypeOf(Array.prototype, original);
    }
    expect(results).toEqual(baseline);
  });
});
