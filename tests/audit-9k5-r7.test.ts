/**
 * Round 7 of the audit of 9K5 (AF1 to AF5): what a process can do to the built-ins and to the
 * prototypes AFTER spec has loaded changes no verdict of spec's own code.
 *
 * - AF1: the `TextEncoder` that hashes, the tzdata release, `instanceof` on an error class.
 * - AF3: `Object.prototype` and `Array.prototype` never feed a field or an element.
 * - AF4: the iteration protocol is never run on data.
 * - AF2: the `@noble` dependencies are out of scope (README, "Threat model"): two forgeries are
 *   kept as `it.fails`, so that the limit is visible and the day it closes shows up.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  computeRuleChecksum,
  createSigningKeyPair,
  normalizeRuleDefinition,
  sealProof,
  signProof,
  verifyProof,
  VerifyOptionsError,
} from '../src/index.js';
import { PURE_CORPUS, paris, parisUnsigned, run, runPure } from './corpus.js';
import { withRuntimeTzdata } from './notices.js';
import { RFC_PUBLIC, RFC_SECRET, ruleA, ruleB, sealed, unsalted, unsigned } from './proof-cases.js';

const define = Object.defineProperty;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const bareDescriptor = (fields: PropertyDescriptor): PropertyDescriptor =>
  Object.setPrototypeOf(fields, null) as PropertyDescriptor;

/** Runs `body` with `holder[key]` replaced, and puts the original back. */
function patched<T>(
  holder: object,
  key: PropertyKey,
  replacement: PropertyDescriptor,
  body: () => T,
): T {
  const original = ownDescriptor(holder, key);
  define(holder, key, bareDescriptor({ configurable: true, ...replacement }));
  try {
    return body();
  } finally {
    if (original === undefined) Reflect.deleteProperty(holder, key);
    else define(holder, key, original);
  }
}

const baseline = runPure();

describe('the corpus before any patch', () => {
  it('holds a forged window (Paris) as invalid and a tampered rule as a checksum mismatch', () => {
    const verdict = (name: string): string =>
      baseline[PURE_CORPUS.findIndex((c) => c[0] === name)]!;
    expect(verdict('verifyProof Paris unsigned')).toContain(
      'rule applied outside its window: r1@1',
    );
    expect(verdict('verifyProof unsigned, rules')).toContain('"status"');
  });
});

describe('AF1: the host built-ins spec reads are captured', () => {
  it('a TextEncoder.prototype.encodeInto that rewrites a date changes no checksum and no verdict', () => {
    const real = TextEncoder.prototype.encodeInto;
    const lie = function (this: InstanceType<typeof TextEncoder>, text: string, into: Uint8Array) {
      return real.call(this, text.replaceAll('2024-01-01', '2025-01-01'), into);
    };
    const rule = { ...ruleA, effectiveFrom: '2024-01-01' };
    const clean = computeRuleChecksum(rule);
    const lied = patched(
      TextEncoder.prototype,
      'encodeInto',
      { value: lie, writable: true },
      () => ({
        checksum: computeRuleChecksum(rule),
        results: runPure(),
      }),
    );
    expect(lied.checksum).toBe(clean);
    expect(lied.results).toEqual(baseline);
  });

  it('a TextEncoder.prototype.encode that rewrites a date changes no verdict', () => {
    const real = TextEncoder.prototype.encode;
    const lie = function (this: InstanceType<typeof TextEncoder>, text?: string) {
      return real.call(this, text === undefined ? text : text.replaceAll('a', 'b'));
    };
    const results = patched(
      TextEncoder.prototype,
      'encode',
      { value: lie, writable: true },
      runPure,
    );
    expect(results).toEqual(baseline);
  });

  it('a redefined process.versions.tz changes neither the verdict nor the notice', () => {
    const versions = process.versions as unknown as Record<string, unknown>;
    const results = patched(versions, 'tz', { value: '1999a', writable: true }, runPure);
    expect(results).toEqual(baseline);
  });

  it('a RangeError whose Symbol.hasInstance lies changes neither the verdict nor the notice', () => {
    const results = patched(
      RangeError,
      Symbol.hasInstance,
      { value: () => false, writable: true },
      runPure,
    );
    expect(results).toEqual(baseline);
  });

  it('an Error whose Symbol.hasInstance lies still has its message cited', () => {
    const calendar = {
      toCivilDate: () => {
        throw new Error('boom');
      },
      startOfDay: () => '2025-01-01T00:00:00.000Z',
    };
    const proof = sealProof(unsalted(withParisContent()));
    const call = (): string => {
      try {
        return JSON.stringify(verifyProof(proof, { rules: [paris, ruleB], calendar }));
      } catch (error) {
        return (error as Error).message;
      }
    };
    const clean = call();
    expect(clean).toContain('boom');
    const lied = patched(Error, Symbol.hasInstance, { value: () => false, writable: true }, call);
    expect(lied).toBe(clean);
  });

  it('an Error whose Symbol.hasInstance lies changes nothing', () => {
    const results = patched(
      Error,
      Symbol.hasInstance,
      { value: () => false, writable: true },
      runPure,
    );
    expect(results).toEqual(baseline);
  });
});

describe('AF3: no inherited property is read', () => {
  const polluted = (holder: object, key: PropertyKey, value: unknown): string[] =>
    patched(holder, key, { value, writable: true, enumerable: false }, runPure);

  it.each(['output', 'ruleSet', 'sourceRef', 'dominanceGroup', 'timeZone', 'condition', 'tags'])(
    'Object.prototype.%s leaves the checksum and the normal form of a rule as they are',
    (name) => {
      const clean = [computeRuleChecksum(ruleA), JSON.stringify(normalizeRuleDefinition(ruleA))];
      const dirty = patched(Object.prototype, name, { value: 'x', writable: true }, () => [
        computeRuleChecksum(ruleA),
        JSON.stringify(normalizeRuleDefinition(ruleA)),
      ]);
      expect(dirty).toEqual(clean);
    },
  );

  it.each(['day', 'month', 'year', 'minute', 'second', 'hour', 'timeZone', 'timeZoneName'])(
    'Object.prototype.%s does not reach the Intl options: the Paris proof stays invalid',
    (name) => {
      expect(polluted(Object.prototype, name, 'numeric')).toEqual(baseline);
    },
  );

  it.each(['get', 'set'])(
    'Object.prototype.%s does not turn a data descriptor into an accessor',
    (name) => {
      const results = polluted(Object.prototype, name, () => 1);
      expect(results).toEqual(baseline);
    },
  );

  it('verifyProof still throws VerifyOptionsError for a misspelled option when get is polluted', () => {
    // The harness reads no descriptor while `get` is polluted: the error is caught inside.
    const proof = sealed();
    const caught = patched(Object.prototype, 'get', { value: 'x', writable: true }, () => {
      try {
        verifyProof(proof, { calender: 1 } as never);
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(caught).toBeInstanceOf(VerifyOptionsError);
  });

  it.each<[string, PropertyDescriptor]>([
    ['a value', { value: 'x', writable: true, configurable: true }],
    ['a getter', { get: () => 'x', set: () => undefined }],
    [
      'a getter that throws',
      {
        get: () => {
          throw new Error('inherited');
        },
      },
    ],
  ])('Array.prototype[0] and [1] as %s change no result', (_name, descriptor) => {
    const dirty = patched(Array.prototype, 0, descriptor, () =>
      patched(Array.prototype, 1, descriptor, runPure),
    );
    expect(dirty).toEqual(baseline);
  });

  it('canonicalize and the checksum of a rule are the same under an accessor at Array.prototype[0]', () => {
    const value = { a: [1, 2, { b: 'x' }], c: 'y' };
    const rule = { ...ruleA, params: { rates: [1, 2, { x: 'y' }] } };
    const clean = [canonicalize(value), computeRuleChecksum(rule)];
    const dirty = patched(Array.prototype, 0, { get: () => 'x', set: () => undefined }, () => [
      canonicalize(value),
      computeRuleChecksum(rule),
    ]);
    expect(dirty).toEqual(clean);
  });

  it('canonicalize refuses an array with a hole, naming it, and never returns partial text', () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
    const holed = { a: [1, , 3] };
    expect(() => canonicalize(holed)).toThrow(/a has a hole at index 1/);
    patched(Array.prototype, 1, { get: () => 2, set: () => undefined }, () => {
      expect(() => canonicalize(holed)).toThrow(/a has a hole at index 1/);
    });
  });

  it('canonicalize refuses an array element that is an accessor, naming it', () => {
    const list: unknown[] = [1, 2, 3];
    define(list, 1, bareDescriptor({ get: () => 2, enumerable: true }));
    expect(() => canonicalize({ a: list })).toThrow(/a has an accessor at index 1/);
  });
});

describe('AF4: the iteration protocol is never run on data', () => {
  // The lies reach only code of `src/` (the frame that calls the patched function is read from the
  // stack): the hash dependency (`@noble/hashes`, `sha2.js`) iterates arrays itself, and a process
  // that patches that is the attacker of the AF2 limit below, which the phase 3 sandbox answers.
  const SPEC_SRC = new URL('../src/', import.meta.url).pathname;
  const fromSpec = (): boolean => {
    const caller = (new Error().stack ?? '').split('\n')[3] ?? '';
    return caller.includes(SPEC_SRC);
  };
  const ArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]()) as object;

  it('an array iterator that skips elements changes no verdict and throws no raw TypeError', () => {
    const real = (ArrayIteratorPrototype as { next: () => IteratorResult<unknown> }).next;
    const lie = function (this: Iterator<unknown>): IteratorResult<unknown> {
      const first = real.call(this) as IteratorResult<unknown>;
      if (!fromSpec() || first.done === true) return first;
      return real.call(this) as IteratorResult<unknown>;
    };
    const results = patched(
      ArrayIteratorPrototype,
      'next',
      { value: lie, writable: true },
      runPure,
    );
    expect(results).toEqual(baseline);
    for (const text of results) expect(text).not.toMatch(/is not a function|TypeError/);
  });

  it('an Array.prototype[Symbol.iterator] that yields nothing changes no verdict', () => {
    const real = Array.prototype[Symbol.iterator];
    const lie = function* (this: unknown[]): Generator<unknown> {
      if (!fromSpec()) yield* real.call(this);
    };
    const results = patched(
      Array.prototype,
      Symbol.iterator,
      { value: lie, writable: true },
      runPure,
    );
    expect(results).toEqual(baseline);
  });

  it('a Map and a Set whose iterators lie change no verdict', () => {
    const mapProto = Object.getPrototypeOf(new Map().keys()) as {
      next: () => IteratorResult<unknown>;
    };
    const setProto = Object.getPrototypeOf(new Set().values()) as {
      next: () => IteratorResult<unknown>;
    };
    const lieFor = (real: () => IteratorResult<unknown>) =>
      function (this: Iterator<unknown>): IteratorResult<unknown> {
        return fromSpec() ? { done: true, value: undefined } : real.call(this);
      };
    const results = patched(
      mapProto,
      'next',
      { value: lieFor(mapProto.next), writable: true },
      () => patched(setProto, 'next', { value: lieFor(setProto.next), writable: true }, runPure),
    );
    expect(results).toEqual(baseline);
  });

  it('a String.prototype[Symbol.iterator] that yields nothing changes no verdict', () => {
    const real = String.prototype[Symbol.iterator];
    const lie = function* (this: string): Generator<string> {
      if (!fromSpec()) yield* real.call(this);
    };
    const results = patched(
      String.prototype,
      Symbol.iterator,
      { value: lie, writable: true },
      runPure,
    );
    expect(results).toEqual(baseline);
  });
});

describe('AF2: the signature and hash dependencies read live built-ins (the known limit)', () => {
  // A process that patches built-ins after load can make `@noble` accept a forged proof. This is
  // the same attacker as a hostile plugin: the phase 3 sandbox answers it (verification in a
  // fresh realm), see the ruling of round 7 and the README, "Threat model". Each probe is written
  // as the verdict the day the limit closes should give, and marked `it.fails` until then.
  const attacker = createSigningKeyPair();

  it.fails('a key swapped by a patched charCodeAt: an untrusted signer is still invalid', () => {
    const proof = signProof(sealed(), attacker.privateKey, 'executor-1');
    const real = String.prototype.charCodeAt;
    const lie = function (this: string, index: number): number {
      const text = String(this);
      return text === RFC_PUBLIC ? real.call(attacker.publicKey, index) : real.call(text, index);
    };
    const status = patched(
      String.prototype,
      'charCodeAt',
      { value: lie, writable: true },
      () => verifyProof(proof, { trustedKeys: { 'executor-1': RFC_PUBLIC } }).status,
    );
    expect(status).toBe('invalid');
  });

  it.fails('a digest text swapped by a patched encode: a resealed forgery is still invalid', () => {
    const original = signProof(sealed(), RFC_SECRET, 'executor-1');
    const forgedContent = { ...unsalted(unsigned()), requestId: 'forged-request' };
    const resealed = sealProof(forgedContent as never);
    const forged = { ...resealed, signature: original.signature };
    const real = TextEncoder.prototype.encode;
    const lie = function (this: InstanceType<typeof TextEncoder>, text?: string): Uint8Array {
      return real.call(this, text === forged.digest ? original.digest : text);
    };
    const status = patched(
      TextEncoder.prototype,
      'encode',
      { value: lie, writable: true },
      () => verifyProof(forged as never, { trustedKeys: { 'executor-1': RFC_PUBLIC } }).status,
    );
    expect(status).toBe('invalid');
  });

  it('the honest verdict of the swapped-key forgery, unpatched, is invalid', () => {
    const proof = signProof(sealed(), attacker.privateKey, 'executor-1');
    const verdict = verifyProof(proof, { trustedKeys: { 'executor-1': RFC_PUBLIC } });
    expect(verdict.status).toBe('invalid');
    expect(verdict.issues).toContain('signature invalid');
  });

  it('the honest verdict of the resealed-digest forgery, unpatched, is invalid', () => {
    const original = signProof(sealed(), RFC_SECRET, 'executor-1');
    const forgedContent = { ...unsalted(unsigned()), requestId: 'forged-request' };
    const resealed = sealProof(forgedContent as never);
    const forged = { ...resealed, signature: original.signature };
    expect(forged.digest).not.toBe(original.digest);
    const verdict = verifyProof(forged as never, { trustedKeys: { 'executor-1': RFC_PUBLIC } });
    expect(verdict.status).toBe('invalid');
    expect(verdict.issues).toContain('signature invalid');
  });
});

function withParisContent() {
  const content = withRuntimeTzdata(unsigned());
  content.evaluatedAt = '2024-12-31T22:30:00.000Z';
  content.rules = content.rules.map((r) =>
    r.id === 'r1' ? { ...r, checksum: computeRuleChecksum(paris) } : r,
  );
  return content;
}
void [parisUnsigned, run];
