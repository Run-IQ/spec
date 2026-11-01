import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  computeIdempotencyDigest,
  computeInputDigest,
  findOverlappingVersions,
  formatPointer,
  governingAssertion,
  inclusionPath,
  matchDimension,
  matchesSelector,
  merkleRoot,
  normalizeRuleDefinition,
  sealProof,
  UNSALTED_SEED,
  validateOutputDeclaration,
  validateProof,
  validateProofInput,
  validateReferential,
  validateRuleDefinition,
  validateTemporalFact,
  valueMatchesOutputType,
  verifyProof,
} from '../src/index.js';
import type {
  FactAssertion,
  OutputDeclaration,
  RuleDefinitionInput,
  UnsignedProof,
  VersionedRuleWindow,
} from '../src/index.js';
import { MAX_JSON_VALUES } from '../src/values.js';
import {
  BASE_RULE,
  builtFile,
  fixedCalendar,
  HUMAN_ASSERTION,
  proofInput,
  specError,
} from './helpers.js';

const SEED = UNSALTED_SEED;

/** The elements a hostile list gave out: every read of an index, and every `in` test. */
let elementReads = 0;

/** A sparse array of the greatest length JavaScript allows: 2^32 - 1 holes. */
function sparse(): unknown[] {
  const list: unknown[] = [];
  list.length = 2 ** 32 - 1;
  return list;
}

/** A Proxy over an array that claims `length` elements, counting each element read. */
function claiming(length: number, holeAt?: number): unknown[] {
  return new Proxy<unknown[]>([], {
    get(target, key) {
      if (key === 'length') return length;
      if (typeof key === 'string' && /^\d+$/.test(key)) elementReads += 1;
      return typeof key === 'string' && /^\d+$/.test(key) ? 'x' : Reflect.get(target, key);
    },
    has(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        elementReads += 1;
        return Number(key) !== holeAt;
      }
      return Reflect.has(target, key);
    },
  });
}

const PROOF: UnsignedProof = {
  format: 'run-iq.proof/1',
  requestId: 'r',
  inputDigest: 'a'.repeat(64),
  evaluatedAt: null,
  sealedAt: '2026-01-01T00:00:00.000Z',
  rules: [],
  versions: { engine: '1', plugins: {}, dsls: {} },
  strata: [],
  outputs: {},
  applied: [],
  skipped: [],
  exceptions: [],
};

const referential = (members: unknown, periods: unknown = [{ from: '2020-01-01' }]): unknown => ({
  format: 'run-iq.referential/1',
  id: 'x',
  version: '1',
  dimension: 'd',
  codes: { A: periods },
  groups: { G: { exhaustive: true, members } },
});

/**
 * A short list with each element made a hash (its holes kept: `map` skips them), so that a leaf
 * list fails on its hole, not on an element read before it; any other list as it is. The cast
 * passes a hostile list where the API types a valid one: that is the case under test.
 */
function asHashes(list: unknown): Uint8Array[] {
  const short = Array.isArray(list) && list.length < 10;
  return (short ? list.map(() => new Uint8Array(32)) : list) as Uint8Array[];
}

/**
 * Each walk of a caller list, and the path its named problem cites. The casts pass a hostile
 * list where the API types a valid one: that is the case under test.
 */
const LIST_READERS: [string, (list: unknown) => unknown, string][] = [
  ['canonicalize', (list) => specError(() => canonicalize({ a: list })).message, 'a'],
  ['merkleRoot', (list) => specError(() => merkleRoot(asHashes(list))).message, 'leaf hashes'],
  [
    'inclusionPath',
    (list) => specError(() => inclusionPath(asHashes(list), 0)).message,
    'leaf hashes',
  ],
  [
    'computeInputDigest data',
    (list) =>
      specError(() => computeInputDigest(proofInput({}, { l: list as never }), SEED)).message,
    'invalid input: /data/l',
  ],
  [
    'computeIdempotencyDigest options',
    (list) =>
      specError(() =>
        computeIdempotencyDigest({ input: proofInput(), options: { l: list as never } }),
      ).message,
    'invalid options: /l',
  ],
  [
    'normalizeRuleDefinition params',
    (list) =>
      specError(() => normalizeRuleDefinition({ ...BASE_RULE, params: list as never })).message,
    'params',
  ],
  [
    'normalizeRuleDefinition tags',
    (list) =>
      specError(() => normalizeRuleDefinition({ ...BASE_RULE, tags: list as string[] })).message,
    'tags',
  ],
  [
    'validateRuleDefinition params',
    (list) => validateRuleDefinition({ ...BASE_RULE, params: list }).errors[0],
    'params',
  ],
  [
    'validateRuleDefinition tags',
    (list) => validateRuleDefinition({ ...BASE_RULE, tags: list }).errors[0],
    'tags',
  ],
  [
    'validateRuleDefinition dimension values',
    (list) =>
      validateRuleDefinition({ ...BASE_RULE, dimensions: { c: { anyOf: list } } }).errors[0],
    'dimensions.c.anyOf',
  ],
  [
    'validateRuleDefinition extension',
    (list) => validateRuleDefinition({ ...BASE_RULE, ext: list }).errors[0],
    'ext',
  ],
  [
    'validateProof applied',
    (list) => validateProof({ ...PROOF, digest: 'b'.repeat(64), applied: list }).errors[0],
    'applied',
  ],
  [
    'validateProof strata',
    (list) => validateProof({ ...PROOF, digest: 'b'.repeat(64), strata: list }).errors[0],
    'strata',
  ],
  [
    'sealProof rules',
    (list) => specError(() => sealProof({ ...PROOF, rules: list as never })).message,
    'Cannot seal the proof: rules',
  ],
  [
    'verifyProof rules option',
    (list) => verifyProof(sealProof(PROOF), { rules: list as RuleDefinitionInput[] }).issues.at(-1),
    'rules',
  ],
  [
    'formatPointer',
    (list) => specError(() => formatPointer(list as string[])).message,
    'JSON pointer segments',
  ],
  [
    'findOverlappingVersions',
    (list) =>
      specError(() => findOverlappingVersions(list as VersionedRuleWindow[], 'UTC', fixedCalendar))
        .message,
    'rules',
  ],
  [
    'validateProofInput data',
    (list) => validateProofInput(proofInput({}, { a: list as never }))[0]?.message,
    '/data/a',
  ],
  [
    'validateProofInput tags',
    (list) => validateProofInput(proofInput({ tags: list as string[] }))[0]?.message,
    '/meta/tags',
  ],
  [
    'validateTemporalFact',
    (list) => validateTemporalFact(list, '/x').find((issue) => issue.path === '/x')?.message,
    '/x',
  ],
  [
    'matchDimension input',
    (list) =>
      specError(() =>
        matchDimension('A', list as string[], '2021-01-01', { referentials: [] } as never),
      ).message,
    'input',
  ],
  [
    'matchesSelector rule tags',
    (list) =>
      specError(() =>
        matchesSelector(
          { id: 'a', tags: list as string[], dimensions: {}, model: 'm' },
          { tags: ['a'] },
        ),
      ).message,
    'rule.tags',
  ],
  [
    'matchesSelector selector list',
    (list) =>
      specError(() =>
        matchesSelector(
          { id: 'a', tags: [], dimensions: {}, model: 'm' },
          { ids: list as string[] },
        ),
      ).message,
    'selector.ids',
  ],
  [
    'validateOutputDeclaration values',
    (list) =>
      validateOutputDeclaration({ type: 'enum', combine: 'highestPriority', values: list })[0]
        ?.message,
    'output.values',
  ],
  [
    'valueMatchesOutputType values',
    (list) =>
      specError(() =>
        valueMatchesOutputType('a', {
          type: 'enum',
          combine: 'highestPriority',
          values: list,
        } as OutputDeclaration),
      ).message,
    'output declaration.values',
  ],
];

describe(`at most ${MAX_JSON_VALUES} values per call, a list's length counted first`, () => {
  it('is the shared constant', () => {
    expect(MAX_JSON_VALUES).toBe(10_000_000);
  });

  it.each(LIST_READERS)(
    '%s: a sparse array of length 2^32 - 1',
    (_name, read, path) => {
      expect(read(sparse())).toBe(`${path} is too large: more than 10000000 values`);
    },
    60_000,
  );

  it.each(LIST_READERS)('%s: a Proxy claiming 10^12 elements, none read', (_name, read, path) => {
    elementReads = 0;
    expect(read(claiming(1e12))).toBe(`${path} is too large: more than 10000000 values`);
    expect(elementReads).toBe(0);
  });

  it('referentials: the node limit counts the claimed lengths before any element is read', () => {
    elementReads = 0;
    expect(validateReferential(referential(claiming(1e12)))).toEqual([
      { path: '', message: 'referential too large: 1000000000002 nodes' },
    ]);
    expect(validateReferential(referential([{ value: 'A' }], claiming(1e12)))).toEqual([
      { path: '', message: 'referential too large: 1000000000002 nodes' },
    ]);
    expect(elementReads).toBe(0);
    expect(
      specError(() => validateReferential(referential([]), { maxNodes: 1e7 + 1 })),
    ).toMatchObject({ code: 'INVALID_REFERENTIAL', message: 'maxNodes must be at most 10000000' });
  }, 60_000);

  it('one budget per call, shared by every list it reads', () => {
    elementReads = 0;
    // The first list spends 6 000 000 values (its hole is found at once), the second is then
    // refused before any of its elements is read.
    const dimensions = { a: { anyOf: claiming(6e6, 0) }, b: { anyOf: claiming(6e6) } };
    expect(validateRuleDefinition({ ...BASE_RULE, dimensions }).errors).toEqual([
      'dimensions.a.anyOf has a hole at index 0: arrays must be dense',
      'dimensions.b.anyOf is too large: more than 10000000 values',
    ]);
    expect(elementReads).toBe(1);
  });
});

describe('a hole is not JSON: refused everywhere, never written as null', () => {
  // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
  const holed = (): unknown[] => ['a', , 'b'];

  it.each(LIST_READERS)('%s', (_name, read, path) => {
    expect(read(holed())).toBe(`${path} has a hole at index 1: arrays must be dense`);
  });

  it('referential members and periods', () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
    const members = [{ value: 'A' }, , { value: 'A' }];
    expect(validateReferential(referential(members))).toContainEqual({
      path: 'groups.G.members',
      message: 'groups.G.members has a hole at index 1: arrays must be dense',
    });
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
    const periods = [{ from: '2020-01-01', until: '2021-01-01' }, , { from: '2022-01-01' }];
    expect(validateReferential(referential([{ value: 'A' }], periods))).toContainEqual({
      path: 'codes.A',
      message: 'codes.A has a hole at index 1: arrays must be dense',
    });
  });

  it('an explicit undefined in an array is refused by canonicalize, never written null', () => {
    expect(specError(() => canonicalize([1, undefined]))).toMatchObject({
      code: 'NON_SERIALIZABLE',
      path: '[1]',
      message: '[1] is not JSON: undefined',
    });
  });
});

describe('governingAssertion: the cost follows the assertions, not the pointer', () => {
  it('a pointer of 40 000 segments asks only for the keys of the assertions', () => {
    const keys = ['', '/a', '/a/a/a', '/b'];
    const target: Record<string, FactAssertion> = Object.fromEntries(
      keys.map((key) => [key, HUMAN_ASSERTION]),
    );
    let asked = 0;
    let listed = 0;
    const count = (key: string | symbol): void => {
      asked += typeof key === 'string' ? key.length + 1 : 1;
    };
    const assertions = new Proxy(target, {
      get(t, key) {
        count(key);
        return Reflect.get(t, key);
      },
      has(t, key) {
        count(key);
        return Reflect.has(t, key);
      },
      getOwnPropertyDescriptor(t, key) {
        count(key);
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
      ownKeys(t) {
        listed += 1;
        return Reflect.ownKeys(t);
      },
    });
    const pointer = '/a'.repeat(40_000);
    expect(governingAssertion(assertions, pointer)).toEqual({
      pointer: '/a/a/a',
      assertion: HUMAN_ASSERTION,
    });
    expect(listed).toBe(1);
    // Only the governing key is read: at most the total length of the keys, plus one per key.
    const total = keys.reduce((sum, key) => sum + key.length + 1, 0);
    expect(asked).toBeLessThanOrEqual(total);
    expect(asked).toBe('/a/a/a'.length + 1);
  }, 60_000);
});

describe('under a 1 GB heap (built dist)', () => {
  it('a sparse array of length 2^32 - 1 gives the named problem, the process exits 0', () => {
    const dist = builtFile('index.js');
    const script = `
      const s = await import(${JSON.stringify(`file://${dist}`)});
      const sp = () => { const a = []; a.length = 2 ** 32 - 1; return a; };
      const base = { id: 'r1', version: 1, model: 'm', priority: 1, effectiveFrom: '2025-01-01' };
      const message = (f) => { try { f(); return 'no error'; } catch (e) { return e.message; } };
      const seed = s.deriveInputSeed(new Uint8Array(32).fill(1), 'r1');
      const input = { data: { a: 1 }, meta: { tenantId: 't', dates: {}, tags: [], dimensions: {},
        context: {}, assertions: {} } };
      console.log(JSON.stringify([
        s.validateRuleDefinition({ ...base, params: sp() }).errors[0],
        message(() => s.normalizeRuleDefinition({ ...base, params: sp() })),
        s.validateProof({ applied: sp() }).issues.find((i) => i.path === 'applied').message,
        message(() => s.formatPointer(sp())),
        message(() => s.findOverlappingVersions(sp(), 'UTC', {})),
        message(() => s.canonicalize(sp())),
        message(() => s.merkleRoot(sp())),
        s.verifyInclusion(new Uint8Array(32), 0, 2, sp(), new Uint8Array(32)),
        s.verifyInputInclusion('0'.repeat(64), 2, 0, new Uint8Array(32), sp()),
        s.verifyFactDisclosure({ format: 'run-iq.disclosure/1', inputDigest: '0'.repeat(64),
          size: 1, facts: [], absent: sp() }, '0'.repeat(64)).issues[0],
        s.verifyFactDisclosure({ format: 'run-iq.disclosure/1', inputDigest: '0'.repeat(64),
          size: 10000000, facts: sp(), absent: [] }, '0'.repeat(64)).issues[0],
        message(() => s.discloseFacts(input, seed, sp(), [])),
        message(() => s.discloseFacts(input, seed, [], sp())),
      ]));`;
    const out = execFileSync(
      process.execPath,
      ['--max-old-space-size=1024', '--input-type=module', '-e', script],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(out)).toEqual([
      'params is too large: more than 10000000 values',
      'params is too large: more than 10000000 values',
      'applied is too large: more than 10000000 values',
      'JSON pointer segments is too large: more than 10000000 values',
      'rules is too large: more than 10000000 values',
      '(root) is too large: more than 10000000 values',
      'leaf hashes is too large: more than 10000000 values',
      false,
      false,
      '/absent is too large: more than 10000000 values',
      '/facts holds 4294967295 leaves, more than the size of the tree (10000000)',
      'present is too large: more than 10000000 values',
      'absent is too large: more than 10000000 values',
    ]);
  }, 60_000);
});
