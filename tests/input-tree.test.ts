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
import { SpecError } from '../src/index.js';
import type { InputLeaf, JsonValue, ProofInput } from '../src/index.js';
import { copyWork } from '../src/input/read.js';
import { inputLeafText } from '../src/input/validate.js';
import { hashWorkDone } from '../src/stream.js';
import { DATE_FORMS } from '../src/input/assertions.js';
import { ASSERTION_METHODS } from '../src/input/types.js';
import {
  lastValuesSpent,
  MAX_INPUT_LEAF_TEXT,
  MAX_JSON_DEPTH,
  MAX_JSON_VALUES,
} from '../src/values.js';
import {
  countValues,
  LONGEST_DATA_LIST,
  loose,
  HUMAN_ASSERTION,
  nested,
  proofInput,
  specError,
  tooDeepIssue,
} from './helpers.js';
import {
  expectedHashWork,
  leafBytes,
  nodeLeafHash,
  fromHex,
  hex,
  nodeHmac,
  nodeInputDigest,
  nodeInputSeed,
  nodeSha256,
  referenceRoot,
  pointerText,
  sharedPointerText,
} from './hashing.js';
import type { TreeLeaf } from './hashing.js';

const SECRET = new Uint8Array(32).fill(0x42);
/** The problem of an input whose leaf pointers hold too many code units. */
const POINTER_TEXT =
  'the leaf pointers of the input hold more than ' + `${MAX_INPUT_LEAF_TEXT} code units`;
const SEED = nodeInputSeed(SECRET, 'r1');
/** Why `/meta` is never a leaf. */
const META_ALWAYS = '/meta always holds its six members, so it is never a leaf';
const NON_EMPTY = '/value must be a non-empty string';
const SALT_A = 'ab'.repeat(32);
const VALUE_SALT_A = 'cd'.repeat(32);
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

/** The salts of the leaf at `pointer` under `SEED`, by `node:crypto`. */
const saltsOf = (pointer: string): { salt: string; valueSalt: string } => ({
  salt: saltOf(SEED, pointer),
  valueSalt: hex(nodeHmac(SEED, `value:${pointer}`)),
});

/** The pointers of the leaves of `input`, in order. */
const pointers = (input: ProofInput, seed: Uint8Array = SEED): string[] =>
  inputLeaves(input, seed).map((leaf) => leaf.pointer);

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
  it('lists the example leaves in order, salted by HMAC-SHA256(seed, input:|value:<ptr>)', () => {
    const leaf = (pointer: string, rest: Omit<TreeLeaf, 'pointer'>): InputLeaf => ({
      pointer,
      ...rest,
      ...saltsOf(pointer),
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
      ['pointer', 'kind', 'value', 'salt', 'valueSalt'],
      ['pointer', 'kind', 'length', 'salt', 'valueSalt'],
      ['pointer', 'kind', 'salt', 'valueSalt'],
      ['pointer', 'kind', 'value', 'salt', 'valueSalt'],
      ['pointer', 'kind', 'salt', 'valueSalt'],
      ['pointer', 'kind', 'salt', 'valueSalt'],
      ['pointer', 'kind', 'salt', 'valueSalt'],
      ['pointer', 'kind', 'salt', 'valueSalt'],
      ['pointer', 'kind', 'length', 'salt', 'valueSalt'],
      ['pointer', 'kind', 'value', 'salt', 'valueSalt'],
    ]);
  });

  it('escapes keys as RFC 6901 does, and lists a list before its elements', () => {
    const input = proofInput({}, { 'a/b': 1, x: [5, 6] });
    const leaves = inputLeaves(input, SEED).filter((leaf) => leaf.pointer.startsWith('/data'));
    expect(leaves).toEqual([
      { pointer: '/data/a~1b', kind: 'value', value: 1, ...saltsOf('/data/a~1b') },
      { pointer: '/data/x', kind: 'array', length: 2, ...saltsOf('/data/x') },
      { pointer: '/data/x/0', kind: 'value', value: 5, ...saltsOf('/data/x/0') },
      { pointer: '/data/x/1', kind: 'value', value: 6, ...saltsOf('/data/x/1') },
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
      ...saltsOf('/data'),
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
    expect(leaves.map((leaf) => leaf.valueSalt)).toEqual(
      leaves.map((leaf) => hex(nodeHmac(new Uint8Array(32), `value:${leaf.pointer}`))),
    );
    const salts = leaves.flatMap((leaf) => [leaf.salt, leaf.valueSalt]);
    expect(new Set(salts).size).toBe(2 * leaves.length);
  });

  it('reads the input once and charges each of its values once', () => {
    const input = proofInput({ tags: ['a'] }, { x: { y: [1, 2] } });
    inputLeaves(input, SEED);
    expect(lastValuesSpent()).toBe(countValues(input));
  });
});

describe('inputLeafHash (D-15 encoding)', () => {
  it('is sha256(0x00 ‖ tag ‖ 0x00 ‖ salt ‖ C ‖ JCS(pointer)), C over valueSalt and c', () => {
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
    const salt = SALT_A;
    const valueSalt = VALUE_SALT_A;
    const value = { pointer: '/data/a', kind: 'value', value: 1, salt, valueSalt };
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
      [{ ...value, valueSalt: undefined }, '/valueSalt', '/valueSalt is required'],
      [
        { ...value, valueSalt: 'CD'.repeat(32) },
        '/valueSalt',
        '/valueSalt must be 64 lowercase hex characters',
      ],
      [{ ...value, valueSalt: 1 }, '/valueSalt', '/valueSalt must be 64 lowercase hex characters'],
      [{ pointer: '/data/a', kind: 'array', salt, valueSalt }, '/length', '/length is required'],
      [
        { pointer: '/data/a', kind: 'array', length: -1, salt, valueSalt },
        '/length',
        `/length must be an integer from 0 to ${LONGEST_DATA_LIST}`,
      ],
      [
        { pointer: '/data/a', kind: 'array', length: 1.5, salt, valueSalt },
        '/length',
        `/length must be an integer from 0 to ${LONGEST_DATA_LIST}`,
      ],
      [
        { pointer: '/data/a', kind: 'array', length: LONGEST_DATA_LIST + 1, salt, valueSalt },
        '/length',
        `/length must be an integer from 0 to ${LONGEST_DATA_LIST}`,
      ],
      [
        { pointer: '/data/a', kind: 'object', value: 1, salt, valueSalt },
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
    const leaf = { pointer: '/data/a', kind: 'value', value: 1, salt: SALT_A, valueSalt: SALT_A };
    const counted = new Proxy(leaf, {
      get(target, key, receiver) {
        reads.push(String(key));
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(hex(inputLeafHash(loose(counted)))).toBe(hex(nodeLeafHash(loose(leaf))));
    expect(reads.sort()).toEqual(['kind', 'pointer', 'salt', 'value', 'valueSalt']);
  });

  it('refuses every leaf whose place, kind or value no valid input has (M3)', () => {
    const salts = { salt: SALT_A, valueSalt: VALUE_SALT_A };
    const none = (why: string): string => `/pointer names no leaf of a valid input: ${why}`;
    const digest = 'a'.repeat(64);
    const cases: [object, string, string][] = [
      [{ pointer: '/meta', kind: 'object' }, '/pointer', none(META_ALWAYS)],
      [
        { pointer: '/meta/foo', kind: 'value', value: 1 },
        '/pointer',
        none('/meta has no member "foo"'),
      ],
      [
        { pointer: '/meta/__proto__', kind: 'object' },
        '/pointer',
        none('/meta has no member "__proto__"'),
      ],
      [
        { pointer: '/data/$x', kind: 'value', value: 1 },
        '/pointer',
        none('a root key of /data starting with "$" is reserved'),
      ],
      [
        { pointer: '/data', kind: 'value', value: 1 },
        '/kind',
        '/kind must be object at this pointer',
      ],
      [
        { pointer: '/data', kind: 'array', length: 0 },
        '/kind',
        '/kind must be object at this pointer',
      ],
      [
        { pointer: '/meta/tenantId', kind: 'array', length: 3 },
        '/kind',
        '/kind must be value at this pointer',
      ],
      [{ pointer: '/meta/tenantId', kind: 'value', value: '' }, '/value', NON_EMPTY],
      [{ pointer: '/meta/tenantId', kind: 'value', value: 1 }, '/value', NON_EMPTY],
      [
        { pointer: '/meta/tenantId/x', kind: 'value', value: 'a' },
        '/pointer',
        none('nothing is below /meta/tenantId, a string'),
      ],
      [
        { pointer: '/meta/dates', kind: 'array', length: 0 },
        '/kind',
        '/kind must be object at this pointer',
      ],
      [
        { pointer: '/meta/dates/-', kind: 'value', value: '2026-01-01' },
        '/pointer',
        none('a date name is never empty or "-"'),
      ],
      [
        { pointer: '/meta/dates/$at', kind: 'value', value: '2026-01-01' },
        '/pointer',
        none('a date name never starts with "$"'),
      ],
      [
        { pointer: '/meta/dates/d', kind: 'value', value: '2026-02-30' },
        '/value',
        `/value must be ${DATE_FORMS}`,
      ],
      [
        { pointer: '/meta/dates/d/x', kind: 'value', value: 'a' },
        '/pointer',
        none('a date is a string'),
      ],
      [{ pointer: '/meta/tags', kind: 'object' }, '/kind', '/kind must be array at this pointer'],
      [
        { pointer: '/meta/tags/01', kind: 'value', value: 'a' },
        '/pointer',
        none('a tag is named by its index, written 0|[1-9][0-9]*'),
      ],
      [{ pointer: '/meta/tags/0', kind: 'value', value: '' }, '/value', NON_EMPTY],
      [
        { pointer: '/meta/dimensions/pays', kind: 'value', value: ':TG' },
        '/value',
        '/value has an empty code system before ":"',
      ],
      [
        { pointer: '/meta/dimensions/pays', kind: 'array', length: 1 },
        '/length',
        `/length must be an integer from 2 to ${MAX_JSON_VALUES - 9}`,
      ],
      [
        { pointer: '/meta/dimensions/pays', kind: 'object' },
        '/kind',
        '/kind must be value or array at this pointer',
      ],
      [
        { pointer: '/meta/dimensions/pays/x', kind: 'value', value: 'TG' },
        '/pointer',
        none('a dimension value is named by its index, 0|[1-9][0-9]*'),
      ],
      [
        { pointer: '/meta/dimensions/pays/0', kind: 'value', value: 1 },
        '/value',
        '/value must be a string',
      ],
      [
        { pointer: '/meta/dimensions/pays/0/x', kind: 'value', value: 'a' },
        '/pointer',
        none('below a string'),
      ],
      [
        { pointer: '/meta/assertions/~1a', kind: 'object' },
        '/pointer',
        none('an assertion holds by, method, at and status, so it is never a leaf'),
      ],
      [
        { pointer: '/meta/assertions/a/by', kind: 'value', value: 'x' },
        '/pointer',
        none('assertion key "a" must be a JSON pointer'),
      ],
      [
        { pointer: '/meta/assertions/~1a/other', kind: 'value', value: 1 },
        '/pointer',
        none('an assertion has no field "other"'),
      ],
      [
        { pointer: '/meta/assertions/~1a/method', kind: 'value', value: 'guess' },
        '/value',
        `/value must be one of ${ASSERTION_METHODS.join(', ')}`,
      ],
      [
        { pointer: '/meta/assertions/~1a/confidence', kind: 'value', value: 2 },
        '/value',
        '/value must be a number from 0 to 1',
      ],
      [
        { pointer: '/meta/assertions/~1a/complete', kind: 'value', value: true },
        '/value',
        '/value must be false',
      ],
      [
        { pointer: '/meta/assertions/~1a/source', kind: 'object' },
        '/pointer',
        none('a source holds proofDigest and output, so it is never a leaf'),
      ],
      [
        { pointer: '/meta/assertions/~1a/source/proofDigest', kind: 'value', value: 'x' },
        '/value',
        '/value must be a lowercase sha256 hex string',
      ],
      [
        { pointer: '/meta/assertions/~1a/source/output', kind: 'value', value: 'a.b' },
        '/value',
        '/value name must not contain "."',
      ],
      [
        { pointer: '/meta/assertions/~1a/source/other', kind: 'value', value: digest },
        '/pointer',
        none('a source has no field "other"'),
      ],
      [
        { pointer: '/meta/assertions/~1a/by/x', kind: 'value', value: 'a' },
        '/pointer',
        none('a field of an assertion is a scalar'),
      ],
    ];
    for (const [leaf, path, message] of cases) {
      expect([leaf, specError(() => inputLeafHash(loose({ ...leaf, ...salts })))]).toMatchObject([
        leaf,
        { code: 'INVALID_INPUT', path, message: `invalid input leaf: ${message}` },
      ]);
    }
  });

  it('accepts a leaf at each place a valid input has one, as the input tree gives it', () => {
    const input = proofInput(
      {
        tenantId: 't',
        dates: { d: '2026-01-01', i: '2026-01-01T00:00:00.000Z' },
        tags: ['a', 'b'],
        dimensions: { pays: 'TG', zone: ['A', 'B'] },
        context: { $x: [1, {}], y: null },
        assertions: {
          '/a': {
            by: 'clerk',
            method: 'decision',
            at: '2026-01-01',
            status: 'validated',
            basis: 'b',
            evidenceDigest: 'a'.repeat(64),
            confidence: 0.5,
            complete: false,
            source: { proofDigest: 'b'.repeat(64), output: 'pack:total', subject: '/rows/0' },
          },
        },
      },
      { a: [1, 'x', null, true, [], {}], b: {}, 'c/~': { d: 2 } },
    );
    const leaves = inputLeaves(input, SEED);
    expect(leaves).toHaveLength(34);
    for (const leaf of leaves) {
      expect([leaf.pointer, hex(inputLeafHash(leaf))]).toEqual([
        leaf.pointer,
        hex(nodeLeafHash(leaf)),
      ]);
    }
    const empty = inputLeaves(proofInput({ dates: {} }, {}), SEED).map((leaf) => leaf.pointer);
    expect(empty).toEqual([
      '/data',
      '/meta/assertions',
      '/meta/context',
      '/meta/dates',
      '/meta/dimensions',
      '/meta/tags',
      '/meta/tenantId',
    ]);
    for (const leaf of inputLeaves(proofInput({ dates: {} }, {}), SEED)) {
      expect(hex(inputLeafHash(leaf))).toBe(hex(nodeLeafHash(leaf)));
    }
  });

  it(`refuses a leaf more than ${MAX_JSON_DEPTH} levels below /data or /meta/context`, () => {
    const meta = proofInput({ dates: {} }, {}).meta;
    /** `leaf` under `levels` objects, each holding it at `a`. */
    const under = (levels: number, leaf: JsonValue): JsonValue => {
      let value = leaf;
      for (let i = 0; i < levels; i++) value = { a: value };
      return value;
    };
    const roots: [string, (value: JsonValue) => unknown][] = [
      ['/data', (value) => ({ data: value, meta })],
      ['/meta/context', (value) => ({ data: {}, meta: { ...meta, context: value } })],
    ];
    const kinds: [Omit<TreeLeaf, 'pointer'>, JsonValue][] = [
      [{ kind: 'value', value: 1 }, 1],
      [{ kind: 'object' }, {}],
      [{ kind: 'array', length: 0 }, []],
      [{ kind: 'array', length: 1 }, [1]],
    ];
    const outcomes: string[] = [];
    for (const [root, inputOf] of roots) {
      for (const [fields, leaf] of kinds) {
        for (const levels of [MAX_JSON_DEPTH - 1, MAX_JSON_DEPTH, MAX_JSON_DEPTH + 1]) {
          const pointer = root + '/a'.repeat(levels);
          const issues = validateProofInput(inputOf(under(levels, leaf)));
          let hashed = 'accepted';
          try {
            inputLeafHash({ ...fields, pointer, salt: SALT_A, valueSalt: VALUE_SALT_A });
          } catch (error) {
            hashed = error instanceof SpecError ? `${error.code} ${error.message}` : 'other';
          }
          expect(hashed === 'accepted').toBe(issues.length === 0);
          const why = issues.length === 0 ? 'ok' : `${issues.length}: ${issues[0]?.path ?? ''}`;
          outcomes.push(`${fields.kind} ${levels} ${why} | ${hashed}`);
        }
      }
    }
    const deepest = (root: string): string => root + '/a'.repeat(MAX_JSON_DEPTH);
    const tooDeep = (root: string): string =>
      'INVALID_INPUT invalid input leaf: /pointer names no leaf of a valid input: ' +
      `it is nested deeper than ${MAX_JSON_DEPTH} levels below ${root}`;
    /** The path of the issue: the container at the limit, cut as an issue cuts it. */
    const cut = (root: string): string => tooDeepIssue(deepest(root)).path;
    const tooLong = 'INVALID_INPUT invalid input leaf: /length must be an integer from 0 to 0';
    const expected: string[] = [];
    for (const [root] of roots) {
      for (const kind of ['value', 'object', 'array']) {
        expected.push(`${kind} 999 ok | accepted`, `${kind} 1000 ok | accepted`);
        expected.push(`${kind} 1001 1: ${cut(root)} | ${tooDeep(root)}`);
      }
      expected.push(`array 999 ok | accepted`);
      expected.push(`array 1000 1: ${cut(root)} | ${tooLong}`);
      expected.push(`array 1001 1: ${cut(root)} | ${tooDeep(root)}`);
    }
    expect(outcomes).toEqual(expected);
    expect(validateProofInput({ data: under(1, under(MAX_JSON_DEPTH, 1)), meta })).toEqual([
      tooDeepIssue(deepest('/data')),
    ]);
  }, 60_000);
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
    expect(done.calls).toBe(5 * leaves.length);
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
  }, 60_000);

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
  }, 60_000);
});

describe('the validator counts the leaf pointers the input tree has', () => {
  it('on inputs using every part of meta, escapes, unicode and shared values', () => {
    const shared = { s: [1, { t: 'é' }], 'u/~': {} };
    const inputs: ProofInput[] = [
      proofInput({}, {}),
      proofInput({ dates: {} }, { a: [] }),
      proofInput(
        {
          dates: { 'd/~': '2026-01-01', é: '2026-02-01T00:00:00.000Z' },
          tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'],
          dimensions: { pays: 'TG', 'z/o': ['A', 'B', 'C'] },
          context: { '~': shared, k: [shared, shared] },
          assertions: {
            '/x~1y': {
              by: 'b',
              method: 'decision',
              at: '2026-01-01',
              status: 'validated',
              complete: false,
              source: { proofDigest: 'a'.repeat(64), output: 'o', subject: '/r' },
            },
            '/$dates/d': { by: 'b', method: 'human', at: '2026-01-01', status: 'proposed' },
          },
        },
        { 'a~b': shared, l: Array.from({ length: 12 }, (_, i) => [i, shared]), m: {} },
      ),
      EXAMPLE,
    ];
    for (const input of inputs) {
      expect(validateProofInput(input)).toEqual([]);
      expect(inputLeafText(input)).toBe(pointerText(input));
    }
  });
});

describe('validateProofInput keeps no copy; a digest reads its input once into one', () => {
  it('copies no value when it only checks, and each value once for a digest', () => {
    const input = proofInput({}, { a: [1, 2] });
    const before = copyWork.values;
    expect(validateProofInput(input)).toEqual([]);
    expect(copyWork.values).toBe(before);
    computeInputDigest(input, SEED);
    // data: 1, 2, the list, data itself; context {}; the date of meta.dates.
    expect(copyWork.values - before).toBe(6);
  });

  it('checks an input of a million values without copying one', () => {
    const rows = Array.from({ length: 250_000 }, (_, i) => ({ id: `r${i}`, n: i, ok: true }));
    const input = proofInput({ tags: ['a', 'b'], dimensions: { z: ['A', 'B'] } }, { rows });
    const before = copyWork.values;
    expect(validateProofInput(input)).toEqual([]);
    expect(copyWork.values).toBe(before);
  }, 60_000);
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
