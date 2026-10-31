import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  comparePointers,
  computeIdempotencyDigest,
  computeInputDigest,
  deriveInputSeed,
  inclusionPath,
  INPUT_TREE_TAG,
  inputLeafHash,
  inputLeaves,
  merkleRoot,
  sha256Hex,
  UNSALTED_SEED,
  validateProofInput,
  verifyInclusion,
  verifyInputInclusion,
} from '../src/index.js';
import type { InputLeaf, JsonValue, ProofInput } from '../src/index.js';
import { hashWorkDone } from '../src/merkle.js';
import { lastValuesSpent, MAX_INPUT_LEAF_TEXT } from '../src/values.js';
import {
  countValues,
  expectedHashWork,
  leafBytes,
  fromHex,
  hex,
  HUMAN_ASSERTION,
  nested,
  nodeHmac,
  nodeInputDigest,
  nodeInputSeed,
  nodeSha256,
  proofInput,
  referenceRoot,
  pointerText,
  sharedPointerText,
  specError,
  tooDeepIssue,
} from './helpers.js';

const SECRET = new Uint8Array(32).fill(0x42);
/** The problem of an input whose leaf pointers hold too many code units. */
const POINTER_TEXT =
  'the leaf pointers of the input hold more than ' + `${MAX_INPUT_LEAF_TEXT} code units`;
const SEED = nodeInputSeed(SECRET, 'r1');
/** The leaves of the `meta` of `proofInput()`: its six members, `dates` holding one date. */
const META_LEAVES = 6;

/** The input of the D-15 example and of the frozen vector `input-v1`. */
const EXAMPLE: ProofInput = {
  data: { a: 1, b: [], c: {}, d: { e: null } },
  meta: { tenantId: 't', dates: {}, tags: [], dimensions: {}, context: {}, assertions: {} },
};

/** The salt of the leaf at `pointer` under `seed`, by `node:crypto`. */
const saltOf = (seed: Uint8Array, pointer: string): string =>
  hex(nodeHmac(seed, `input:${pointer}`));

/** The leaf hash of D-15, by `node:crypto`: what `inputLeafHash` must give. */
function nodeLeafHash(leaf: InputLeaf): Uint8Array {
  const content: JsonValue[] = [leaf.pointer, leaf.kind];
  if (leaf.kind === 'value') content.push(leaf.value ?? null);
  if (leaf.kind === 'array') content.push(leaf.length ?? 0);
  return nodeSha256(
    Uint8Array.of(0),
    'run-iq.input/1',
    Uint8Array.of(0),
    fromHex(leaf.salt),
    canonicalize(content),
  );
}

/** The pointers of the leaves of `input`, in order. */
const pointers = (input: ProofInput, seed: Uint8Array = SEED): string[] =>
  inputLeaves(input, seed).map((leaf) => leaf.pointer);

/** `value` typed as what a JavaScript caller may pass. */
function loose<T>(value: unknown): T {
  return value as T;
}

describe('deriveInputSeed (D-14)', () => {
  it('is HKDF-SHA256(secret, salt run-iq.input-seed/1, info requestId), 32 bytes', () => {
    const seed = deriveInputSeed(SECRET, 'r1');
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(hex(seed)).toBe(hex(nodeInputSeed(SECRET, 'r1')));
    expect(hex(deriveInputSeed(SECRET, 'r2'))).toBe(hex(nodeInputSeed(SECRET, 'r2')));
    expect(hex(deriveInputSeed(SECRET, 'r2'))).not.toBe(hex(seed));
    const long = new Uint8Array(100).map((_, i) => i);
    expect(hex(deriveInputSeed(long, 'é-\u{1F600}'))).toBe(hex(nodeInputSeed(long, 'é-\u{1F600}')));
  });

  it('accepts a Buffer and a Uint8Array of another realm', () => {
    const foreign = runInNewContext('new Uint8Array(32).fill(0x42)') as Uint8Array;
    expect(hex(deriveInputSeed(foreign, 'r1'))).toBe(hex(SEED));
    expect(hex(deriveInputSeed(Buffer.from(SECRET), 'r1'))).toBe(hex(SEED));
  });

  it('refuses a secret shorter than 32 bytes, or not bytes, with INVALID_KEY', () => {
    const cases: [unknown, string][] = [
      [new Uint8Array(31), 'got 31 bytes'],
      [new Uint8Array(0), 'got 0 bytes'],
      ['x'.repeat(32), 'got a value of type string'],
      [Array.from(SECRET), 'got a value of type array'],
      [new Uint16Array(32), 'got a value of type object'],
      [new Proxy(SECRET, {}), 'got a value of type object'],
      [null, 'got a value of type null'],
    ];
    for (const [secret, got] of cases) {
      expect(specError(() => deriveInputSeed(loose(secret), 'r1'))).toMatchObject({
        code: 'INVALID_KEY',
        message: `the input secret must be a Uint8Array of at least 32 bytes, ${got}`,
      });
    }
  });

  it('refuses a requestId that is not a non-empty text, with INVALID_KEY', () => {
    const notText = 'requestId must be a non-empty string';
    const cases: [unknown, string][] = [
      ['', notText],
      [1, notText],
      [null, notText],
      [`a${String.fromCharCode(0xd800)}`, 'requestId contains a lone UTF-16 surrogate'],
    ];
    for (const [requestId, message] of cases) {
      expect(specError(() => deriveInputSeed(SECRET, loose(requestId)))).toMatchObject({
        code: 'INVALID_KEY',
        message,
      });
    }
  });

  it('UNSALTED_SEED is 32 zero bytes', () => {
    expect(UNSALTED_SEED).toBeInstanceOf(Uint8Array);
    expect(hex(UNSALTED_SEED)).toBe('00'.repeat(32));
  });
});

describe('inputLeaves (D-15)', () => {
  it('lists the example leaves in order, each salted by HMAC-SHA256(seed, input:<ptr>)', () => {
    const leaf = (pointer: string, rest: Omit<InputLeaf, 'pointer' | 'salt'>): InputLeaf => ({
      pointer,
      ...rest,
      salt: saltOf(SEED, pointer),
    });
    expect(inputLeaves(EXAMPLE, SEED)).toEqual([
      leaf('/data/a', { kind: 'value', value: 1 }),
      leaf('/data/b', { kind: 'array', length: 0 }),
      leaf('/data/c', { kind: 'object' }),
      leaf('/data/d/e', { kind: 'value', value: null }),
      leaf('/meta/assertions', { kind: 'object' }),
      leaf('/meta/context', { kind: 'object' }),
      leaf('/meta/dates', { kind: 'object' }),
      leaf('/meta/dimensions', { kind: 'object' }),
      leaf('/meta/tags', { kind: 'array', length: 0 }),
      leaf('/meta/tenantId', { kind: 'value', value: 't' }),
    ]);
  });

  it('a leaf has exactly the members of its kind', () => {
    const leaves = inputLeaves(EXAMPLE, SEED);
    expect(leaves.map((leaf) => Object.keys(leaf))).toEqual([
      ['pointer', 'kind', 'value', 'salt'],
      ['pointer', 'kind', 'length', 'salt'],
      ['pointer', 'kind', 'salt'],
      ['pointer', 'kind', 'value', 'salt'],
      ['pointer', 'kind', 'salt'],
      ['pointer', 'kind', 'salt'],
      ['pointer', 'kind', 'salt'],
      ['pointer', 'kind', 'salt'],
      ['pointer', 'kind', 'length', 'salt'],
      ['pointer', 'kind', 'value', 'salt'],
    ]);
  });

  it('escapes keys as RFC 6901 does, and lists a list before its elements', () => {
    const input = proofInput({}, { 'a/b': 1, x: [5, 6] });
    const leaves = inputLeaves(input, SEED).filter((leaf) => leaf.pointer.startsWith('/data'));
    expect(leaves).toEqual([
      { pointer: '/data/a~1b', kind: 'value', value: 1, salt: saltOf(SEED, '/data/a~1b') },
      { pointer: '/data/x', kind: 'array', length: 2, salt: saltOf(SEED, '/data/x') },
      { pointer: '/data/x/0', kind: 'value', value: 5, salt: saltOf(SEED, '/data/x/0') },
      { pointer: '/data/x/1', kind: 'value', value: 6, salt: saltOf(SEED, '/data/x/1') },
    ]);
  });

  it('orders by decoded segments: ~ escapes and list indices as comparePointers does', () => {
    const input = proofInput({}, { '~': 1, a: 2, '/': 3 });
    expect(pointers(input).filter((p) => p.startsWith('/data'))).toEqual([
      '/data/~1',
      '/data/a',
      '/data/~0',
    ]);
    const list = proofInput({}, { l: Array.from({ length: 12 }, (_, i) => i) });
    expect(pointers(list).filter((p) => p.startsWith('/data/l/'))).toEqual(
      ['0', '1', '10', '11', '2', '3', '4', '5', '6', '7', '8', '9'].map((i) => `/data/l/${i}`),
    );
  });

  it('is sorted by comparePointers, without duplicates, for a rich input', () => {
    const input = proofInput(
      {
        dates: { effective: '2026-01-01', facture: '2026-01-01T10:00:00.000Z' },
        tags: ['a', 'b'],
        dimensions: { pays: ['FR', 'US'], secteur: 'C' },
        context: { 'z~': { '': [] }, a: 'é\u{1F600}' },
        assertions: { '/revenue': HUMAN_ASSERTION, '': { ...HUMAN_ASSERTION, by: 'x' } },
      },
      { revenue: 1000, 'a-c': true, a: { b: [{}, [], [[null]]] }, é: 'x', '\u{1F600}': 0 },
    );
    const list = pointers(input);
    expect(list).toEqual([...list].sort(comparePointers));
    expect(new Set(list).size).toBe(list.length);
    expect(list).toContain('/meta/assertions/~1revenue/by');
    expect(list).toContain('/meta/assertions//status');
    expect(list).toContain('/meta/dimensions/pays/1');
    expect(list).toContain('/meta/context/z~0/');
  });

  it('gives an empty data its own leaf', () => {
    expect(pointers(proofInput({}, {}))[0]).toBe('/data');
    expect(inputLeaves(proofInput({}, {}), SEED)[0]).toEqual({
      pointer: '/data',
      kind: 'object',
      salt: saltOf(SEED, '/data'),
    });
  });

  it('a value shared by two paths has its leaves on each path', () => {
    const shared = { q: [1] };
    const list = pointers(proofInput({}, { x: shared, y: shared }));
    expect(list.filter((p) => p.startsWith('/data'))).toEqual([
      '/data/x/q',
      '/data/x/q/0',
      '/data/y/q',
      '/data/y/q/0',
    ]);
  });

  it('salts every leaf with its own salt, under UNSALTED_SEED too (HMAC, key of zeros)', () => {
    const leaves = inputLeaves(EXAMPLE, UNSALTED_SEED);
    expect(leaves.map((leaf) => leaf.salt)).toEqual(
      leaves.map((leaf) => saltOf(new Uint8Array(32), leaf.pointer)),
    );
    expect(new Set(leaves.map((leaf) => leaf.salt)).size).toBe(leaves.length);
  });

  it('reads the input once and charges each of its values once', () => {
    const input = proofInput({ tags: ['a'] }, { x: { y: [1, 2] } });
    inputLeaves(input, SEED);
    expect(lastValuesSpent()).toBe(countValues(input));
  });
});

describe('inputLeafHash (D-15 encoding)', () => {
  it('is sha256(0x00 ‖ utf8(run-iq.input/1) ‖ 0x00 ‖ raw salt ‖ utf8(canonicalize(c)))', () => {
    expect(INPUT_TREE_TAG).toBe('run-iq.input/1');
    const input = proofInput(
      { context: { s: 'é"\\\u{1F600}', n: -0 } },
      { a: 1.5, b: [true, false], c: {}, d: { e: null }, big: 2 ** 53 - 1 },
    );
    const leaves = inputLeaves(input, SEED);
    expect(leaves.length).toBeGreaterThan(10);
    for (const leaf of leaves) {
      expect([leaf.pointer, hex(inputLeafHash(leaf))]).toEqual([
        leaf.pointer,
        hex(nodeLeafHash(leaf)),
      ]);
    }
  });

  it('refuses a leaf no valid input could give, with INVALID_INPUT', () => {
    const salt = 'ab'.repeat(32);
    const value = { pointer: '/data/a', kind: 'value', value: 1, salt };
    const cases: [unknown, string, string][] = [
      [null, '', 'an input leaf must be a plain object'],
      [{ ...value, extra: 1 }, '/extra', 'input leaf has an unknown key "extra"'],
      [{ ...value, pointer: undefined }, '/pointer', '/pointer is required'],
      [
        { ...value, pointer: 'data/a' },
        '/pointer',
        '/pointer must be a JSON pointer below /data or /meta',
      ],
      [
        { ...value, pointer: '/other/a' },
        '/pointer',
        '/pointer must be a JSON pointer below /data or /meta',
      ],
      [
        { ...value, pointer: '/data/~2' },
        '/pointer',
        '/pointer must be a JSON pointer below /data or /meta',
      ],
      [
        { ...value, pointer: '' },
        '/pointer',
        '/pointer must be a JSON pointer below /data or /meta',
      ],
      [{ ...value, kind: 'list' }, '/kind', '/kind must be one of value, array, object'],
      [
        { ...value, pointer: 1 },
        '/pointer',
        '/pointer must be a JSON pointer below /data or /meta',
      ],
      [
        { ...value, value: `a${String.fromCharCode(0xd800)}` },
        '/value',
        '/value contains a lone UTF-16 surrogate',
      ],
      [{ ...value, value: undefined }, '/value', '/value is required'],
      [{ ...value, value: { a: 1 } }, '/value', '/value must be a JSON scalar'],
      [{ ...value, value: [1] }, '/value', '/value must be a JSON scalar'],
      [{ ...value, value: 2 ** 53 }, '/value', 'number beyond 2^53 at /value'],
      [{ ...value, value: Number.NaN }, '/value', '/value is not JSON: NaN'],
      [{ ...value, length: 1 }, '/length', '/length is only for a leaf of kind array'],
      [{ ...value, salt: 'AB'.repeat(32) }, '/salt', '/salt must be 64 lowercase hex characters'],
      [{ ...value, salt: 'ab' }, '/salt', '/salt must be 64 lowercase hex characters'],
      [{ pointer: '/data/a', kind: 'array', salt }, '/length', '/length is required'],
      [
        { pointer: '/data/a', kind: 'array', length: -1, salt },
        '/length',
        '/length must be an integer from 0 to 10000000',
      ],
      [
        { pointer: '/data/a', kind: 'array', length: 1.5, salt },
        '/length',
        '/length must be an integer from 0 to 10000000',
      ],
      [
        { pointer: '/data/a', kind: 'array', length: 10_000_001, salt },
        '/length',
        '/length must be an integer from 0 to 10000000',
      ],
      [
        { pointer: '/data/a', kind: 'object', value: 1, salt },
        '/value',
        '/value is only for a leaf of kind value',
      ],
    ];
    for (const [leaf, path, message] of cases) {
      expect([path, specError(() => inputLeafHash(loose(leaf)))]).toMatchObject([
        path,
        { code: 'INVALID_INPUT', path, message: `invalid input leaf: ${message}` },
      ]);
    }
  });

  it('reads each member of the leaf once', () => {
    const reads: string[] = [];
    const leaf = { pointer: '/data/a', kind: 'value', value: 1, salt: 'ab'.repeat(32) };
    const counted = new Proxy(leaf, {
      get(target, key, receiver) {
        reads.push(String(key));
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(hex(inputLeafHash(loose(counted)))).toBe(hex(nodeLeafHash(loose(leaf))));
    expect(reads.sort()).toEqual(['kind', 'pointer', 'salt', 'value']);
  });

  it('refuses a pointer longer than every leaf pointer of an input may be', () => {
    const pointer = `/data/${'k'.repeat(MAX_INPUT_LEAF_TEXT)}`;
    const leaf = { pointer, kind: 'value', value: 1, salt: 'ab'.repeat(32) };
    expect(specError(() => inputLeafHash(loose(leaf)))).toMatchObject({
      code: 'INVALID_INPUT',
      path: '/pointer',
      message: `invalid input leaf: /pointer is longer than ${MAX_INPUT_LEAF_TEXT} code units`,
    });
  });
});

describe('computeInputDigest (D-15)', () => {
  it('commits the leaf count and the RFC 6962 root of the leaf hashes', () => {
    const input = proofInput({ tags: ['x'] }, { a: [1, { b: 'c' }], d: {} });
    const leaves = inputLeaves(input, SEED);
    const root = referenceRoot(leaves.map(nodeLeafHash));
    expect(hex(merkleRoot(leaves.map(inputLeafHash)))).toBe(hex(root));
    expect(leaves).toHaveLength(11);
    expect(computeInputDigest(input, SEED)).toBe(nodeInputDigest(11, root));
    expect(computeInputDigest(input, SEED)).not.toBe(hex(root));
  });

  it('is the digest of the same root under another count no more', () => {
    const input = proofInput({}, { a: 1 });
    const root = merkleRoot(inputLeaves(input, SEED).map(inputLeafHash));
    const digest = computeInputDigest(input, SEED);
    expect(digest).toBe(nodeInputDigest(7, root));
    expect(nodeInputDigest(8, root)).not.toBe(digest);
    expect(nodeInputDigest(2 ** 32 + 7, root)).not.toBe(digest);
  });

  it('does the hash work of D-14 and D-15 and no more', () => {
    const input = proofInput({ tags: ['é'] }, { a: [1, { b: 'c\u{1F600}' }], d: {}, e: null });
    const leaves = inputLeaves(input, SEED);
    const before = hashWorkDone();
    computeInputDigest(input, SEED);
    const after = hashWorkDone();
    const done = { calls: after.calls - before.calls, bytes: after.bytes - before.bytes };
    expect(done).toEqual(expectedHashWork(leaves.map(leafBytes)));
    expect(done.calls).toBe(3 * leaves.length);
  });

  it('does not depend on key order', () => {
    const reordered: ProofInput = {
      meta: {
        tenantId: 't',
        context: {},
        assertions: {},
        dimensions: {},
        tags: [],
        dates: {},
      },
      data: { d: { e: null }, c: {}, b: [], a: 1 },
    };
    expect(computeInputDigest(reordered, SEED)).toBe(computeInputDigest(EXAMPLE, SEED));
  });

  it('changes when a fact changes, and with the seed; same input and seed, same digest', () => {
    const digest = computeInputDigest(EXAMPLE, SEED);
    expect(computeInputDigest(structuredClone(EXAMPLE), SEED)).toBe(digest);
    const changed = { ...EXAMPLE, data: { ...EXAMPLE.data, a: 2 } };
    expect(computeInputDigest(changed, SEED)).not.toBe(digest);
    const moved = { ...EXAMPLE, data: { ...EXAMPLE.data, a: [1] } };
    expect(computeInputDigest(moved, SEED)).not.toBe(digest);
    expect(computeInputDigest(EXAMPLE, deriveInputSeed(SECRET, 'r2'))).not.toBe(digest);
    expect(computeInputDigest(EXAMPLE, UNSALTED_SEED)).not.toBe(digest);
  });

  it('a list, its elements and an empty object are told apart', () => {
    const digests = [
      { x: [] },
      { x: {} },
      { x: [[]] },
      { x: [{}] },
      { x: null },
      { x: [null] },
      { x: 'null' },
      { x: '[]' },
    ].map((data) => computeInputDigest(proofInput({}, data), SEED));
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('refuses exactly what validateProofInput refuses, after the seed', () => {
    const input = proofInput();
    const cases: unknown[] = [
      { ...input, data: { x: new Map() } },
      { ...input, data: { list: [1, undefined] } },
      { ...input, data: { big: 2 ** 53 } },
      { ...input, data: { $x: 1 } },
      { ...input, data: { deep: nested(1001) } },
      { ...input, meta: { ...input.meta, tags: ['b', 'a'] } },
      { data: {} },
      null,
    ];
    for (const value of cases) {
      const [first] = validateProofInput(value);
      expect(first).toBeDefined();
      for (const call of [
        () => computeInputDigest(loose(value), SEED),
        () => inputLeaves(loose(value), SEED),
      ]) {
        expect(specError(call)).toMatchObject({
          code: 'INVALID_INPUT',
          message: `invalid input: ${first?.message ?? ''}`,
          path: first?.path,
        });
      }
    }
  });

  it('refuses a seed that is not 32 bytes with INVALID_KEY, before reading the input', () => {
    let reads = 0;
    const input = new Proxy(proofInput(), {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const cases: [unknown, string][] = [
      [new Uint8Array(31), 'got 31 bytes'],
      [new Uint8Array(33), 'got 33 bytes'],
      ['0'.repeat(64), 'got a value of type string'],
      [undefined, 'got a value of type undefined'],
    ];
    for (const [seed, got] of cases) {
      const message = `the input seed must be a Uint8Array of 32 bytes, ${got}`;
      for (const call of [
        () => computeInputDigest(input, loose(seed)),
        () => inputLeaves(input, loose(seed)),
      ]) {
        expect(specError(call)).toMatchObject({ code: 'INVALID_KEY', message });
      }
    }
    expect(reads).toBe(0);
  });
});

describe('verifyInputInclusion (D-15)', () => {
  const input = proofInput({}, { a: 1 });
  const hashes = inputLeaves(input, SEED).map(inputLeafHash);
  const digest = computeInputDigest(input, SEED);
  const A = hashes[0] ?? new Uint8Array(32);

  it('is true for each leaf of the input, with its index, its size and its path', () => {
    expect(hashes).toHaveLength(7);
    hashes.forEach((leaf, i) => {
      const path = inclusionPath(hashes, i);
      expect([i, verifyInputInclusion(digest, 7, i, leaf, path)]).toEqual([i, true]);
      const other = hashes[(i + 1) % 7] ?? A;
      expect([i, verifyInputInclusion(digest, 7, i, other, path)]).toEqual([i, false]);
      expect([i, verifyInputInclusion(digest, 7, (i + 1) % 7, leaf, path)]).toEqual([i, false]);
    });
  });

  it('leaf 4 of 7 does not verify against the digest of 8 leaves', () => {
    const path = inclusionPath(hashes, 4);
    const leaf = hashes[4] ?? A;
    const root = merkleRoot(hashes);
    // The RFC 6962 root alone takes it as leaf 4 of 8; the digest commits to 7, and the
    // digest of the same root under 8 leaves is another digest.
    expect(verifyInclusion(leaf, 4, 8, path, root)).toBe(true);
    expect(verifyInputInclusion(digest, 8, 4, leaf, path)).toBe(false);
    expect(verifyInputInclusion(nodeInputDigest(8, root), 7, 4, leaf, path)).toBe(false);
    const eight = computeInputDigest(proofInput({}, { a: 1, b: 2 }), SEED);
    expect(verifyInputInclusion(eight, 8, 4, leaf, path)).toBe(false);
    expect(verifyInputInclusion(eight, 7, 4, leaf, path)).toBe(false);
  });

  it('is false, never throwing, for anything but such a proof', () => {
    const path = inclusionPath(hashes, 2);
    const leaf = hashes[2] ?? A;
    const throwing = [A, A, A];
    Object.defineProperty(throwing, 0, {
      get() {
        throw new Error('read');
      },
    });
    const cases: [unknown, unknown, unknown, unknown, unknown][] = [
      [digest.toUpperCase(), 7, 2, leaf, path],
      [digest.slice(1), 7, 2, leaf, path],
      [`${digest}0`, 7, 2, leaf, path],
      [fromHex(digest), 7, 2, leaf, path],
      [null, 7, 2, leaf, path],
      [digest, 0, 0, leaf, []],
      [digest, 7.5, 2, leaf, path],
      [digest, '7', 2, leaf, path],
      [digest, 7, 7, leaf, path],
      [digest, 7, -1, leaf, path],
      [digest, 7, 2, leaf.subarray(1), path],
      [digest, 7, 2, [...leaf], path],
      [digest, 7, 2, leaf, path.slice(1)],
      [digest, 7, 2, leaf, [...path, A]],
      [digest, 7, 2, leaf, throwing],
      [digest, 7, 2, leaf, null],
    ];
    cases.forEach((args, i) => {
      expect([
        i,
        verifyInputInclusion(...loose<Parameters<typeof verifyInputInclusion>>(args)),
      ]).toEqual([i, false]);
    });
    expect(verifyInputInclusion(digest, 7, 2, leaf, path)).toBe(true);
  });
});

describe(`leaf pointers: at most ${MAX_INPUT_LEAF_TEXT} code units in all`, () => {
  it('the test input holds the code units asked for', () => {
    for (const [units, depth] of [
      [300, 3],
      [301, 3],
      [307, 3],
      [5_000, 4],
      [12_345, 6],
    ] as const) {
      const { input, paths } = sharedPointerText(units, depth);
      expect(pointerText(input)).toBe(units);
      expect(inputLeaves(input, UNSALTED_SEED)).toHaveLength(paths + 1 + META_LEAVES);
    }
  });

  it(`validateProofInput accepts ${MAX_INPUT_LEAF_TEXT} code units, from short texts`, () => {
    const { input, paths, width, rest } = sharedPointerText(MAX_INPUT_LEAF_TEXT, 16);
    // 2^16 paths to one shared value, no text longer than a few thousand code units.
    expect(paths).toBe(65_536);
    expect(Math.max(width, rest)).toBeLessThan(70_000);
    expect(validateProofInput(input)).toEqual([]);
  });

  it('validateProofInput, the digests and inputLeaves refuse one code unit more', () => {
    const { input: over } = sharedPointerText(MAX_INPUT_LEAF_TEXT + 1, 16);
    const message = POINTER_TEXT;
    expect(validateProofInput(over)).toEqual([{ path: '', message }]);
    const calls: (() => unknown)[] = [
      () => computeInputDigest(over, SEED),
      () => inputLeaves(over, SEED),
      () => computeIdempotencyDigest({ input: over, options: {} }),
    ];
    for (const call of calls) {
      const before = hashWorkDone();
      expect(specError(call)).toMatchObject({
        code: 'INVALID_INPUT',
        path: '',
        message: `invalid input: ${message}`,
      });
      // Refused before anything is hashed.
      expect(hashWorkDone()).toEqual(before);
    }
  });

  it('a value shared by many paths counts its pointers on each path', () => {
    let shared: JsonValue = ['k'.repeat(1_000_000)];
    for (let i = 0; i < 9; i++) shared = { l: shared, r: shared };
    // 2^9 paths to the leaf list holding one element: few values, long pointers.
    const deep = proofInput({}, { ['k'.repeat(300_000)]: shared });
    expect(countValues(deep)).toBeLessThan(5_000);
    expect(validateProofInput(deep)).toEqual([
      {
        path: '',
        message: POINTER_TEXT,
      },
    ]);
  });
});

describe('computeIdempotencyDigest (D-17)', () => {
  const input = proofInput({ tags: ['a'] }, { x: 1 });

  it('is sha256Hex(canonicalize({ input, options })), unsalted', () => {
    const request = { input, options: {} };
    expect(computeIdempotencyDigest(request)).toBe(sha256Hex(canonicalize(request)));
    expect(computeIdempotencyDigest(request)).toBe(hex(nodeSha256(canonicalize(request))));
  });

  it('changes when options.requested changes, not with key order', () => {
    const one = computeIdempotencyDigest({ input, options: { requested: ['a'] } });
    expect(computeIdempotencyDigest({ input, options: { requested: ['b'] } })).not.toBe(one);
    expect(computeIdempotencyDigest({ input, options: {} })).not.toBe(one);
    expect(computeIdempotencyDigest({ options: { requested: ['a'] }, input })).toBe(one);
    const changed = proofInput({ tags: ['a'] }, { x: 2 });
    expect(computeIdempotencyDigest({ input: changed, options: { requested: ['a'] } })).not.toBe(
      one,
    );
  });

  it('reads the request once and charges each of its values once', () => {
    const request = { input, options: { ruleSets: [{ id: 'p', version: '1' }] } };
    computeIdempotencyDigest(request);
    expect(lastValuesSpent()).toBe(countValues(request));
  });

  it('refuses the input as computeInputDigest does', () => {
    const bad = { ...input, data: { $x: 1 } };
    const [first] = validateProofInput(bad);
    expect(specError(() => computeIdempotencyDigest(loose({ input: bad, options: {} })))).toEqual(
      specError(() => computeInputDigest(bad, SEED)),
    );
    expect(first?.message).toBe('reserved key /data/$x');
  });

  it('refuses a request or options that are not plain JSON, with INVALID_INPUT', () => {
    const deep = tooDeepIssue('/a'.repeat(1000));
    const cases: [unknown, string, string][] = [
      [null, '', 'invalid request: a request must be a plain object { input, options }'],
      [{ input }, '/options', 'invalid request: /options is required'],
      [{ options: {} }, '/input', 'invalid request: /input is required'],
      [{ input, options: {}, x: 1 }, '/x', 'invalid request: request has an unknown key "x"'],
      [{ input, options: [] }, '', 'invalid options: options must be a plain object'],
      [{ input, options: { a: undefined } }, '/a', 'invalid options: /a is not JSON: undefined'],
      [
        { input, options: { a: [1, undefined] } },
        '/a/1',
        'invalid options: /a/1 is not JSON: undefined',
      ],
      [
        { input, options: { a: new Map() } },
        '/a',
        'invalid options: /a is not JSON: an object that is neither plain nor an array',
      ],
      [{ input, options: { a: Number.NaN } }, '/a', 'invalid options: /a is not JSON: NaN'],
      [{ input, options: { a: 2 ** 53 } }, '/a', 'invalid options: number beyond 2^53 at /a'],
      [{ input, options: { a: nested(1001) } }, deep.path, `invalid options: ${deep.message}`],
    ];
    for (const [request, path, message] of cases) {
      expect([path, specError(() => computeIdempotencyDigest(loose(request)))]).toMatchObject([
        path,
        { code: 'INVALID_INPUT', path, message },
      ]);
    }
  });
});
