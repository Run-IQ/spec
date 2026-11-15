/**
 * AF3 (round 7): spec never reads an inherited property. Every property name `src/` uses is
 * defined, one at a time, on `Object.prototype` (with several kinds of value) and the corpus of
 * `tests/corpus.ts` is run again: no result may differ from the clean run. The indices of
 * `Array.prototype` get the same treatment. Heavy: about a thousand names times five values.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runPure as run } from '../corpus.js';

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (path.endsWith('.ts')) out.push(readFileSync(path, 'utf8'));
  }
  return out;
}

// What the harness itself reads while it runs (it must not be the thing that changes).
const HARNESS = new Set([
  'toJSON',
  'toString',
  'valueOf',
  'constructor',
  '__proto__',
  'then',
  'hasOwnProperty',
  'toLocaleString',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'prototype',
]);

const text = sources(new URL('../../src', import.meta.url).pathname).join('\n');
const NAMES = [
  ...new Set(
    [
      ...text.matchAll(
        /(?:\.|\?\.|\['|\b)([A-Za-z_][A-Za-z0-9_]*)(?:'\])?(?=\s*[:)\],;.}]|\s*\?)/g,
      ),
    ].map((m) => m[1]!),
  ),
]
  .filter((n) => !HARNESS.has(n))
  // `POLLUTE_ONLY=a,b` restricts a run to those names (to iterate on a fix).
  .filter(
    (n) =>
      process.env.POLLUTE_ONLY === undefined || process.env.POLLUTE_ONLY.split(',').includes(n),
  )
  .sort();

const VALUES: [string, unknown][] = [
  ['string', '1970-01-01'],
  ['number', 7],
  ['true', true],
  ['object', {}],
  ['array', []],
];

// What a buggy merge or a frozen prototype leaves: a plain data value, writable or read-only (the
// attacker of the round-8 ruling has data only: no setter, no Proxy, no patched built-in).
const KINDS: [string, unknown, boolean][] = [
  ...VALUES.map(([kind, value]): [string, unknown, boolean] => [kind, value, true]),
  ['read-only string', '1970-01-01', false],
  ['read-only object', {}, false],
];

const baseline = run();
const define = Object.defineProperty;
const remove = Reflect.deleteProperty;
const bareDescriptor = (fields: PropertyDescriptor): PropertyDescriptor =>
  Object.setPrototypeOf(fields, null) as PropertyDescriptor;

describe('Object.prototype polluted', () => {
  it('has a clean baseline and a name list', () => {
    expect(NAMES.length).toBeGreaterThan(500);
    expect(baseline.length).toBeGreaterThan(10);
  });

  it('changes no result of the corpus, whatever name and value', () => {
    const changed: string[] = [];
    for (const name of NAMES) {
      for (const [kind, value, writable] of KINDS) {
        define(
          Object.prototype,
          name,
          bareDescriptor({ value, configurable: true, writable, enumerable: false }),
        );
        let got: string[];
        try {
          got = run();
        } finally {
          remove(Object.prototype, name);
        }
        for (let i = 0; i < baseline.length; i++) {
          if (got[i] !== baseline[i])
            changed.push(`${name}=${kind} call#${i}: ${got[i]?.slice(0, 100)}`);
        }
      }
    }
    expect(changed).toEqual([]);
  }, 900_000);
});

describe('Array.prototype polluted', () => {
  it('changes no result of the corpus with an accessor or a value at an index', () => {
    const changed: string[] = [];
    for (const index of ['0', '1', '2', '3']) {
      for (const [kind, descriptor] of [
        ['value', { value: 'x', configurable: true, writable: true }],
        ['getter', { get: () => 'x', set: () => undefined, configurable: true }],
        [
          'thrower',
          {
            get: () => {
              throw new Error('inherited');
            },
            configurable: true,
          },
        ],
      ] as const) {
        define(Array.prototype, index, bareDescriptor({ ...descriptor }));
        let got: string[];
        try {
          got = run();
        } finally {
          remove(Array.prototype, index);
        }
        for (let i = 0; i < baseline.length; i++) {
          if (got[i] !== baseline[i])
            changed.push(`[${index}] ${kind} call#${i}: ${got[i]?.slice(0, 100)}`);
        }
      }
    }
    expect(changed).toEqual([]);
  }, 300_000);
});

describe('read-only data on the prototypes (a frozen or merged-into prototype)', () => {
  const holders: [string, object, string[]][] = [
    ['Object.prototype index', Object.prototype, ['0', '1', '2', '3']],
    ['Array.prototype index', Array.prototype, ['0', '1', '2', '3']],
    ['Set.prototype', Set.prototype, ['ledger']],
    ['Map.prototype', Map.prototype, ['ledger']],
    ['Error.prototype', Error.prototype, ['name', 'code', 'path', 'option', 'cause']],
  ];
  it.each(holders)(
    '%s changes no result, writable or not',
    (_label, holder, keys) => {
      const changed: string[] = [];
      for (const key of keys) {
        for (const writable of [true, false]) {
          const original = Object.getOwnPropertyDescriptor(holder, key);
          define(holder, key, bareDescriptor({ value: 'x', configurable: true, writable }));
          let got: string[];
          try {
            got = run();
          } finally {
            if (original === undefined) remove(holder, key);
            else define(holder, key, original);
          }
          for (let i = 0; i < baseline.length; i++) {
            if (got[i] !== baseline[i])
              changed.push(`${key} writable=${writable} call#${i}: ${got[i]?.slice(0, 100)}`);
          }
        }
      }
      expect(changed).toEqual([]);
    },
    300_000,
  );
});
