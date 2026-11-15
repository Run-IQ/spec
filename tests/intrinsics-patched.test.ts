/**
 * AC1 (round 6): spec gives the same verdict whatever the process does to built-ins AFTER it has
 * loaded. For each built-in captured in `src/intrinsics.ts` (`CAPTURED`, the table the module
 * itself exports), this test patches it to throw, runs a corpus of calls, restores it, and
 * checks that every result is the one of the unpatched run. The six probes of the audit
 * (a hijacked `Function.prototype.call`, `formatToParts`, `Array.prototype.find`, `JSON.parse`,
 * `Map.prototype.get`, `WeakSet.prototype.has`) are also run as LIES (a wrong answer, not a
 * throw), each with the verdict it would have changed.
 *
 * The corpus is prepared before any patch and only calls spec inside the patched window, so the
 * harness itself never runs under a patch.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAPTURED } from '../src/intrinsics.js';
import { VerifyOptionsError } from '../src/index.js';
import { run } from './corpus.js';

import { RFC_PUBLIC } from './proof-cases.js';
const define = Object.defineProperty;
const describeProperty = Object.getOwnPropertyDescriptor;

const baseline = run();

describe('the table covers the captures', () => {
  // Round 7, AF5: `mapIteratorNext` could be made live with no test failing, because `CAPTURED`
  // had no row for it. The rows expected are read from the source of the module, so a capture
  // added without its row fails here.
  const source = readFileSync(new URL('../src/intrinsics.ts', import.meta.url), 'utf8');
  const owners: Record<string, object> = {
    Array: Array.prototype,
    Map: Map.prototype,
    Set: Set.prototype,
    WeakSet: WeakSet.prototype,
    WeakMap: WeakMap.prototype,
    String: String.prototype,
    RegExp: RegExp.prototype,
    Object: Object.prototype,
    Function: Function.prototype,
    Number: Number.prototype,
    Uint8Array: Uint8Array.prototype,
    TextEncoder: TextEncoder.prototype,
    Date: Date.prototype,
    DataView: DataView.prototype,
  };
  const prototypeCaptures = [...source.matchAll(/uncurryThis\((\w+)\.prototype\.(\w+)\)/g)].map(
    (m) => [m[1]!, m[2]!] as const,
  );
  const staticCaptures = [
    ...source.matchAll(
      /^export const \w+(?::[^=]+)? = (Object|Math|Number|JSON|Reflect|Array|String)\.(\w+);$/gm,
    ),
  ]
    .map((m) => [m[1]!, m[2]!] as const)
    .filter(([, key]) => key !== 'prototype' && !/^[A-Z_]+$/.test(key));

  it('finds the captures it expects rows for', () => {
    expect(prototypeCaptures.length).toBeGreaterThan(30);
    expect(staticCaptures.length).toBeGreaterThan(5);
  });

  it.each(prototypeCaptures)('has a row for %s.prototype.%s', (name, key) => {
    const owner = owners[name];
    expect(owner, `no owner known for ${name}: add it to this test`).toBeDefined();
    expect(CAPTURED.some(([o, k]) => o === owner && k === key)).toBe(true);
  });

  it.each(staticCaptures)('has a row for %s.%s', (name, key) => {
    const owner = (globalThis as Record<string, unknown>)[name];
    expect(CAPTURED.some(([o, k]) => o === owner && k === key)).toBe(true);
  });

  it('has a row for the next of the Map and Set iterators', () => {
    for (const [owner, key] of [
      [Object.getPrototypeOf(new Map().keys()), 'next'],
      [Object.getPrototypeOf(new Set().values()), 'next'],
    ] as const) {
      expect(CAPTURED.some(([o, k]) => o === owner && k === key)).toBe(true);
    }
  });
});

describe('the corpus', () => {
  it('has the verdicts the patches must not change', () => {
    const [authentic, untrusted, parisVerdict] = [0, 1, 2].map(
      (i) => JSON.parse(baseline[i]!) as { status: string },
    );
    expect(authentic!.status).toBe('authentic');
    expect(untrusted!.status).toBe('consistent');
    expect(parisVerdict!.status).toBe('invalid');
    expect(baseline[4]).toContain('threw VerifyOptionsError INVALID_OPTIONS options.calender');
    expect(CAPTURED.length).toBeGreaterThan(100);
  });
});

// The patches lie only to code of `src/`: a call from a dependency (`@noble/*`, which uses the
// live built-ins; see the README, "Threat model") or from this test goes to the original. So
// the test measures what spec itself reads live, which `no-live-builtins` forbids.
const uncurry = Function.prototype.bind.bind(Function.prototype.call) as (fn: unknown) => never;
const split = uncurry(String.prototype.split) as (s: string, sep: string) => string[];
const includes = uncurry(String.prototype.includes) as (s: string, part: string) => boolean;
const applyFn = Reflect.apply;
const construct = Reflect.construct;
const NativeError = Error;
const SPEC_SRC = new URL('../src/', import.meta.url).pathname;

function calledFromSpec(): boolean {
  const stack = new NativeError().stack ?? '';
  // 0: "Error", 1: this function, 2: the wrapper, 3: the caller of the patched built-in.
  const caller = split(stack, '\n')[3] ?? '';
  return includes(caller, SPEC_SRC) && !includes(caller, '/node_modules/');
}

const getProto = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;

/** The object, on `start`'s chain, that owns `key` (a typed array method lives on the shared one). */
function ownerOf(start: object, key: string): object {
  let at: object | null = start;
  while (at !== null && describeProperty(at, key) === undefined) at = getProto(at) as object | null;
  if (at === null) throw new Error(`no ${key}`);
  return at;
}

function patch(start: object, key: string, lie: (original: unknown) => unknown): () => void {
  const owner = ownerOf(start, key);
  const saved = describeProperty(owner, key);
  if (saved === undefined) throw new Error(`no ${key}`);
  const original = saved.value ?? saved.get;
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    if (!calledFromSpec()) {
      return new.target === undefined
        ? applyFn(original as (...a: unknown[]) => unknown, this, args)
        : construct(original as new (...a: unknown[]) => object, args, new.target);
    }
    return (lie(original) as (...a: unknown[]) => unknown).apply(this, args);
  };
  if (typeof original === 'function') {
    // A constructor replaced by a wrapper keeps its prototype and its statics for the others.
    define(wrapper, 'prototype', { value: (original as { prototype: unknown }).prototype });
    for (const own of ownKeys(original)) {
      if (own === 'length' || own === 'name' || own === 'prototype') continue;
      define(wrapper, own, describeProperty(original, own) as PropertyDescriptor);
    }
  }
  if ('value' in saved) {
    define(owner, key, { ...saved, value: wrapper });
  } else {
    define(owner, key, { ...saved, get: wrapper as () => unknown });
  }
  return () => {
    define(owner, key, saved);
  };
}
const throws = () => () => {
  throw new Error('patched');
};

// The global `Uint8Array` cannot be wrapped for the test: `@noble/curves` checks the constructor of
// its inputs against it, so even a wrapper that delegates breaks key decoding. Spec itself never
// reads that global (`no-restricted-globals`), and the lint rule is the check for it.
const NOT_WRAPPABLE = new Set<unknown>([Uint8Array]);

describe('every captured built-in, patched after load to throw: no verdict changes', () => {
  it.each(
    CAPTURED.map(([, key], index) => [index, key] as const).filter(
      ([index]) =>
        !NOT_WRAPPABLE.has(describeProperty(CAPTURED[index]![0], CAPTURED[index]![1])?.value),
    ),
  )('built-in #%i (%s)', (index) => {
    const [owner, key] = CAPTURED[index]!;
    const restore = patch(owner, key, throws);
    let results: string[];
    try {
      results = run();
    } finally {
      restore();
    }
    expect(results).toEqual(baseline);
  });
});

describe('the six probes of the audit, as lies', () => {
  const lie = (owner: object, key: string, answer: (original: never) => unknown) => {
    const restore = patch(owner, key, (original) => answer(original as never));
    try {
      return run();
    } finally {
      restore();
    }
  };

  it('Function.prototype.call returning 0 for getTime', () => {
    const results = lie(
      Function.prototype,
      'call',
      () =>
        function () {
          return 0;
        },
    );
    expect(results).toEqual(baseline);
  });

  it('Intl.DateTimeFormat.prototype.formatToParts printing GMT+02:00', () => {
    const results = lie(Intl.DateTimeFormat.prototype, 'formatToParts', () => () => [
      { type: 'timeZoneName', value: 'GMT+02:00' },
    ]);
    expect(results).toEqual(baseline);
  });

  it('Array.prototype.find returning a forged part', () => {
    const results = lie(Array.prototype, 'find', () => () => ({
      type: 'timeZoneName',
      value: 'GMT+02:00',
    }));
    expect(results).toEqual(baseline);
  });

  it('JSON.parse widening the window of r1', () => {
    const results = lie(JSON, 'parse', (original: (t: string) => unknown) => (text: string) => {
      const value = original(text) as { effectiveFrom?: unknown };
      if (value && typeof value === 'object' && value.effectiveFrom === '2025-01-01') {
        value.effectiveFrom = '1970-01-01';
      }
      return value;
    });
    expect(results).toEqual(baseline);
  });

  it('Map.prototype.get returning an attacker key', () => {
    const results = lie(Map.prototype, 'get', () => () => RFC_PUBLIC);
    expect(results).toEqual(baseline);
  });

  it('WeakSet.prototype.has answering true', () => {
    const results = lie(WeakSet.prototype, 'has', () => () => true);
    expect(results).toEqual(baseline);
  });

  it('a caller-built VerifyOptionsError stays foreign', () => {
    expect(new VerifyOptionsError('x', 'y')).toBeInstanceOf(VerifyOptionsError);
  });
});
