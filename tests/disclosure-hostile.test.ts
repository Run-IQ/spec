import { describe, expect, it } from 'vitest';
import {
  computeInputDigest,
  deriveInputSeed,
  discloseFacts,
  verifyFactDisclosure,
} from '../src/index.js';
import type { FactDisclosure, FactDisclosureVerification, ProofInput } from '../src/index.js';
import { lastValuesSpent } from '../src/values.js';
import {
  countValues,
  fromHex,
  hashWorkOf,
  jsonCopy,
  loose,
  nested,
  proofInput,
  specError,
} from './helpers.js';
import first from './vectors/input-v1.json';

const X: ProofInput = first.input;
const SEED = deriveInputSeed(fromHex(first.secret), first.requestId);
const DIGEST = computeInputDigest(X, SEED);
const VALID: FactDisclosure = discloseFacts(
  X,
  SEED,
  ['/data/a', '/data/b'],
  ['/data/d/x', '/meta/z'],
);

/** A JSON copy of the valid disclosure, changed by `change`. */
function changed(change: (copy: Record<string, unknown>) => void): Record<string, unknown> {
  const copy = jsonCopy(VALID) as unknown as Record<string, unknown>;
  change(copy);
  return copy;
}

/** The first fact of `copy` as a plain record. */
function firstFact(copy: Record<string, unknown>): Record<string, unknown> {
  const facts = copy.facts as Record<string, unknown>[];
  const [fact] = facts;
  if (fact === undefined) throw new Error('no fact');
  return fact;
}

/** `verifyFactDisclosure(value, digest)`, failing the test if it throws. */
function verify(value: unknown, digest: unknown = DIGEST): FactDisclosureVerification {
  return verifyFactDisclosure(value, loose<string>(digest));
}

/** What a refused disclosure gives. */
function refused(issues: string[]): FactDisclosureVerification {
  return { valid: false, issues, facts: {}, lists: {}, absent: [] };
}

/** Replaces `key` of `target` by a getter that throws `Error('boom')`. */
function throwAt(target: Record<string, unknown>, key: string): void {
  Object.defineProperty(target, key, {
    enumerable: true,
    get(): never {
      throw new Error('boom');
    },
  });
}

/** A Proxy whose every trap throws `Error('boom')`. */
function throwingProxy(target: object): object {
  const fail = (): never => {
    throw new Error('boom');
  };
  return new Proxy(target, {
    get: fail,
    has: fail,
    ownKeys: fail,
    getOwnPropertyDescriptor: fail,
    getPrototypeOf: fail,
  });
}

/** Element reads of `claiming` lists. */
let elementReads = 0;

/** A Proxy over an array that claims `length` elements, counting each element read. */
function claiming(length: number): unknown[] {
  return new Proxy<unknown[]>([], {
    get(target, key) {
      if (key === 'length') return length;
      if (typeof key === 'string' && /^\d+$/.test(key)) elementReads += 1;
      return Reflect.get(target, key);
    },
  });
}

describe('verifyFactDisclosure never throws: a hostile value is a named problem', () => {
  it('a getter that throws, at every place it is read', () => {
    const top = changed((copy) => throwAt(copy, 'size'));
    expect(verify(top)).toEqual(refused(['/size could not be read: boom']));
    const leaf = changed((copy) => throwAt(firstFact(copy), 'salt'));
    expect(verify(leaf)).toEqual(refused(['/facts/0/salt could not be read: boom']));
    const entry = changed((copy) => {
      const [absence] = copy.absent as Record<string, unknown>[];
      if (absence) throwAt(absence, 'before');
    });
    expect(verify(entry)).toEqual(refused(['/absent/0/before could not be read: boom']));
  });

  it('a Proxy whose traps throw, a revoked Proxy', () => {
    expect(verify(throwingProxy({}))).toEqual(refused(['disclosure could not be read: boom']));
    expect(verify(changed((copy) => (copy.facts = throwingProxy([]))))).toEqual(
      refused(['/facts could not be read: boom']),
    );
    expect(verify(changed((copy) => (firstFact(copy).path = throwingProxy([]))))).toEqual(
      refused(['/facts/0/path could not be read: boom']),
    );
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const result = verify(proxy);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      "disclosure could not be read: Cannot perform 'IsArray' on a proxy that has been revoked",
    ]);
  });

  it('nesting 10 000 levels deep, wherever a scalar, a leaf or a list is expected', () => {
    const deep = nested(10_000);
    expect(verify(changed((copy) => (firstFact(copy).value = deep)))).toEqual(
      refused(['/facts/0/value must be a JSON scalar']),
    );
    let list: unknown = 1;
    for (let i = 0; i < 10_000; i++) list = [list];
    expect(verify(changed((copy) => (copy.facts = [list])))).toEqual(
      refused(['/facts/0 must be an object { pointer, kind, value or length, salt, index, path }']),
    );
    expect(verify(changed((copy) => (copy.absent = [{ pointer: deep }])))).toEqual(
      refused(['/absent/0/pointer must be a string']),
    );
    expect(verify(deep)).toEqual(
      refused([
        'disclosure has an unknown key "a"',
        '/format is required',
        '/inputDigest is required',
        '/size is required',
        '/facts is required',
        '/absent is required',
      ]),
    );
  });

  it.each([-1, 1e300, Number.NaN, Number.POSITIVE_INFINITY, 2.5, 10_000_001, '10', null])(
    'a size of %s',
    (size) => {
      expect(verify(changed((copy) => (copy.size = size)))).toEqual(
        refused(['/size must be an integer from 0 to 10000000']),
      );
    },
  );

  it('an expected digest that is not one', () => {
    for (const digest of [undefined, 1, DIGEST.toUpperCase(), throwingProxy({})]) {
      expect(verifyFactDisclosure(VALID, loose<string>(digest))).toEqual(
        refused(['the expected input digest must be 64 lowercase hex characters']),
      );
    }
  });

  it('reads each property exactly once', () => {
    const reads = new Map<string, number>();
    const count = (path: string): void => {
      reads.set(path, (reads.get(path) ?? 0) + 1);
    };
    const counted = (value: unknown, path: string): unknown => {
      if (Array.isArray(value)) {
        const items = value.map((item, i) => counted(item, `${path}/${i}`));
        return new Proxy(items, {
          get(target, key) {
            if (typeof key === 'string') count(`${path}[${key}]`);
            return Reflect.get(target, key);
          },
        });
      }
      if (value === null || typeof value !== 'object') return value;
      const out = {};
      for (const [key, member] of Object.entries(value)) {
        const inner = counted(member, `${path}/${key}`);
        Object.defineProperty(out, key, {
          enumerable: true,
          get() {
            count(`${path}/${key}`);
            return inner;
          },
        });
      }
      return out;
    };
    const result = verify(counted(jsonCopy(VALID), ''));
    expect(result.valid).toBe(true);
    expect(reads.size).toBeGreaterThan(50);
    expect([...reads].filter(([, n]) => n !== 1)).toEqual([]);
  });

  it('a path of 10^6 entries is refused by its length, before any read or hash', () => {
    elementReads = 0;
    const d = changed((copy) => {
      copy.absent = [];
      copy.facts = [{ ...firstFact(copy), path: claiming(1_000_000) }];
    });
    let result: FactDisclosureVerification | undefined;
    const work = hashWorkOf(() => (result = verify(d)));
    expect(result).toEqual(
      refused(['/facts/0/path must hold 4 hashes (the audit path of leaf 0 of 10)']),
    );
    expect(elementReads).toBe(0);
    expect(work.calls).toBe(0);
  });

  it('more facts than leaves, or more values than the budget, before any element is read', () => {
    elementReads = 0;
    expect(verify(changed((copy) => (copy.facts = claiming(1e9))))).toEqual(
      refused(['/facts holds 1000000000 leaves, more than the size of the tree (10)']),
    );
    expect(verify(changed((copy) => (copy.absent = claiming(2 ** 32 - 1))))).toEqual(
      refused(['/absent is too large: more than 10000000 values']),
    );
    expect(elementReads).toBe(0);
  });

  it('counts each value of the disclosure once', () => {
    const d = jsonCopy(VALID);
    expect(verify(d).valid).toBe(true);
    expect(lastValuesSpent()).toBe(countValues(d));
  });

  it('lists at most 100 problems, each bounded', () => {
    const d = changed((copy) => {
      copy.absent = Array.from({ length: 300 }, (_, i) => ({ pointer: `x${i}` }));
    });
    const { issues } = verify(d);
    expect(issues).toHaveLength(101);
    expect(issues[0]).toBe(
      '/absent/0/pointer: invalid JSON pointer "x0": must be empty or start with "/"',
    );
    expect(issues[100]).toBe('further problems not listed (limit 100)');
    const long = `/${'a'.repeat(1_000_000)}`;
    const cut = verify(changed((copy) => (copy.absent = [{ pointer: long }]))).issues;
    expect(cut).toEqual([
      `absence not proven: /${'a'.repeat(255)}… (no neighbour leaf, and the tree is not empty)`,
    ]);
  });

  it('a lone surrogate in a pointer', () => {
    const d = changed((copy) => (copy.absent = [{ pointer: '/\uD800' }]));
    expect(verify(d)).toEqual(
      refused([
        '/absent/0/pointer: invalid JSON pointer "/\\ud800": contains a lone UTF-16 surrogate',
      ]),
    );
  });
});

describe('discloseFacts: a hostile argument is an own SpecError', () => {
  it('requests that throw, or claim too many elements', () => {
    expect(specError(() => discloseFacts(X, SEED, loose(throwingProxy([])), []))).toMatchObject({
      code: 'INVALID_DISCLOSURE',
      message: 'present could not be read: boom',
    });
    elementReads = 0;
    expect(specError(() => discloseFacts(X, SEED, [], loose(claiming(2 ** 32 - 1))))).toMatchObject(
      { code: 'INVALID_DISCLOSURE', message: 'absent is too large: more than 10000000 values' },
    );
    expect(elementReads).toBe(0);
  });

  it('an input with a getter that throws', () => {
    const data: Record<string, unknown> = {};
    throwAt(data, 'a');
    expect(
      specError(() => discloseFacts(loose(proofInput({}, loose(data))), SEED, [], ['/x'])),
    ).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'invalid input: /data/a could not be read: boom',
    });
  });

  it('counts each value of the input and of the requests once', () => {
    discloseFacts(X, SEED, ['/data/a', '/data/b'], ['/data/z']);
    expect(lastValuesSpent()).toBe(countValues(X) + 3);
  });
});
