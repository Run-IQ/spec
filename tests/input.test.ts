import { describe, expect, it } from 'vitest';
import { validateProofInput } from '../src/index.js';
import { reservedDimensionNameMessage } from '../src/rule/dimensions.js';
import { MAX_INPUT_DEPTH, MAX_INPUT_VALUES } from '../src/input/read.js';
import { inputCheckReads } from '../src/input/validate.js';
import { nested, proofInput } from './helpers.js';

const DATE_FORMS = 'a civil date YYYY-MM-DD or an instant YYYY-MM-DDTHH:MM:SS.sssZ';

describe('validateProofInput: the closed shape', () => {
  it('accepts a complete input', () => {
    expect(validateProofInput(proofInput())).toEqual([]);
  });

  it('refuses the former effectiveDate: the reference date is meta.dates.effective', () => {
    const meta: Record<string, unknown> = { ...proofInput().meta, effectiveDate: '2026-01-01' };
    delete meta.dates;
    expect(validateProofInput({ data: {}, meta })).toEqual([
      { path: '/meta/effectiveDate', message: '/meta has an unknown key "effectiveDate"' },
      { path: '/meta/dates', message: '/meta/dates is required' },
    ]);
  });

  it('requires every field of meta', () => {
    expect(validateProofInput({ data: {}, meta: {} })).toEqual(
      ['tenantId', 'dates', 'tags', 'dimensions', 'context', 'assertions'].map((field) => ({
        path: `/meta/${field}`,
        message: `/meta/${field} is required`,
      })),
    );
  });

  it('refuses an unknown top-level key, a missing data and a missing meta', () => {
    expect(validateProofInput({ facts: {} })).toEqual([
      { path: '/facts', message: 'proof input has an unknown key "facts"' },
      { path: '/data', message: '/data is required' },
      { path: '/meta', message: '/meta is required' },
    ]);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'input'],
    ['a Map', new Map()],
  ])('refuses %s as the input', (_name, value) => {
    expect(validateProofInput(value)).toEqual([
      { path: '', message: 'a proof input must be a plain object' },
    ]);
  });

  it.each([
    ['data', { data: [], meta: proofInput().meta }, '/data must be a plain object'],
    ['meta', { data: {}, meta: null }, '/meta must be a plain object'],
    ['context', proofInput({ context: [] as never }), '/meta/context must be a plain object'],
    ['dates', proofInput({ dates: [] as never }), '/meta/dates must be a plain object'],
    [
      'dimensions',
      proofInput({ dimensions: 'FR' as never }),
      '/meta/dimensions must be a plain object',
    ],
    [
      'assertions',
      proofInput({ assertions: [] as never }),
      '/meta/assertions must be a plain object',
    ],
  ])('refuses %s that is not a plain object', (_name, value, message) => {
    expect(validateProofInput(value)).toEqual([{ path: message.split(' ')[0], message }]);
  });

  it.each([
    ['', '/meta/tenantId must be a non-empty string'],
    [7, '/meta/tenantId must be a non-empty string'],
    ['t\uDC00', '/meta/tenantId contains a lone UTF-16 surrogate'],
  ])('refuses the tenant id %j', (tenantId, message) => {
    expect(validateProofInput(proofInput({ tenantId: tenantId as string }))).toEqual([
      { path: '/meta/tenantId', message },
    ]);
  });
});

describe('validateProofInput: named dates', () => {
  it('accepts a civil date and a canonical instant', () => {
    const dates = { effective: '2026-01-01', facture: '2026-01-01T10:00:00.000Z' };
    expect(validateProofInput(proofInput({ dates }))).toEqual([]);
  });

  it('accepts no date at all: a missing reference date is the engine’s to report', () => {
    expect(validateProofInput(proofInput({ dates: {} }))).toEqual([]);
  });

  it.each([
    ['an offset date-time (core normalizes it first)', '2026-01-01T11:00:00+01:00'],
    ['a date-time without milliseconds', '2026-01-01T10:00:00Z'],
    ['a date-time with one decimal', '2026-01-01T10:00:00.0Z'],
    ['a day that does not exist', '2026-02-30'],
    ['a lowercase z', '2026-01-01T10:00:00.000z'],
    ['an empty text', ''],
    ['a Date object', new Date('2026-01-01T00:00:00.000Z')],
    ['a number', 20260101],
    ['null', null],
  ])('refuses %s', (_name, value) => {
    const dates = { facture: value } as unknown as Record<string, string>;
    expect(validateProofInput(proofInput({ dates }))).toEqual([
      { path: '/meta/dates/facture', message: `/meta/dates/facture must be ${DATE_FORMS}` },
    ]);
  });

  it('refuses a date name with a lone surrogate, naming its object', () => {
    expect(validateProofInput(proofInput({ dates: { 'd\uD800': '2026-01-01' } }))).toEqual([
      {
        path: '/meta/dates',
        message: '/meta/dates has a key with a lone UTF-16 surrogate: "d\\ud800"',
      },
    ]);
  });

  it('writes a date name in the pointer with RFC 6901 escapes', () => {
    expect(validateProofInput(proofInput({ dates: { 'a/b~': 'x' } }))).toEqual([
      { path: '/meta/dates/a~1b~0', message: `/meta/dates/a~1b~0 must be ${DATE_FORMS}` },
    ]);
  });
});

describe('validateProofInput: tags (pre-flight M-17)', () => {
  const tagIssues = (tags: unknown): unknown =>
    validateProofInput(proofInput({ tags: tags as string[] }));
  const unsorted = [{ path: '/meta/tags', message: 'tags must be sorted without duplicates' }];

  it.each([[[]], [['a', 'b']], [['B', 'a']], [['é', 'é']], [['']]])(
    'accepts %j (UTF-16 code unit order)',
    (tags) => {
      expect(tagIssues(tags)).toEqual([]);
    },
  );

  it.each([[['b', 'a']], [['a', 'a']], [['a', 'B']], [['é', 'é']]])('refuses %j', (tags) => {
    expect(tagIssues(tags)).toEqual(unsorted);
  });

  it.each([[['a', 1]], ['a'], [{ 0: 'a' }], [null]])('refuses %j as tags', (tags) => {
    expect(tagIssues(tags)).toEqual([
      { path: '/meta/tags', message: '/meta/tags must be an array of strings' },
    ]);
  });

  it('refuses a tag with a lone surrogate', () => {
    expect(tagIssues(['a', 'b\uD800'])).toEqual([
      { path: '/meta/tags/1', message: '/meta/tags/1 contains a lone UTF-16 surrogate' },
    ]);
  });
});

describe('validateProofInput: dimensions', () => {
  const dimensionIssues = (dimensions: unknown): unknown =>
    validateProofInput(proofInput({ dimensions: dimensions as Record<string, string> }));

  it.each([
    [{ pays: ['FR', 'US'] }],
    [{ pays: 'FR' }],
    [{ pays: ['FR', 'US'], secteur: 'nace-2.1:62.10' }],
    [{ pays: ['BE', 'FR', 'US'] }],
  ])('accepts %j', (dimensions) => {
    expect(dimensionIssues(dimensions)).toEqual([]);
  });

  it.each([
    [['US', 'FR'], '/meta/dimensions/pays must be sorted without duplicates'],
    [['FR', 'FR'], '/meta/dimensions/pays must be sorted without duplicates'],
    [['FR'], '/meta/dimensions/pays holds a single value: write it as a string, not a list'],
    [[], '/meta/dimensions/pays must not be an empty list'],
    [7, '/meta/dimensions/pays must be a value or a sorted list of at least two values'],
    [null, '/meta/dimensions/pays must be a value or a sorted list of at least two values'],
    ['', '/meta/dimensions/pays must not be empty'],
    [':FR', '/meta/dimensions/pays has an empty code system before ":"'],
    ['iso:', '/meta/dimensions/pays has an empty code after ":"'],
    ['F\uDC00', '/meta/dimensions/pays contains a lone UTF-16 surrogate'],
  ])('refuses pays %j', (value, message) => {
    expect(dimensionIssues({ pays: value })).toEqual([{ path: '/meta/dimensions/pays', message }]);
  });

  it('names the list element that is not a dimension value', () => {
    expect(dimensionIssues({ pays: ['FR', 3] })).toEqual([
      { path: '/meta/dimensions/pays/1', message: '/meta/dimensions/pays/1 must be a string' },
    ]);
  });

  it('refuses a dimension name starting with $ (review of 9F)', () => {
    expect(dimensionIssues({ $pays: 'FR' })).toEqual([
      {
        path: '/meta/dimensions/$pays',
        message: reservedDimensionNameMessage('/meta/dimensions/$pays'),
      },
    ]);
    expect(reservedDimensionNameMessage('/meta/dimensions/$pays')).toBe(
      '/meta/dimensions/$pays must not start with "$": dimension names starting with "$" are ' +
        'reserved',
    );
  });

  it('refuses a dimension name with a lone surrogate', () => {
    expect(dimensionIssues({ 'p\uD800': 'FR' })).toEqual([
      {
        path: '/meta/dimensions',
        message: '/meta/dimensions has a key with a lone UTF-16 surrogate: "p\\ud800"',
      },
    ]);
  });
});

describe('validateProofInput: data and context', () => {
  const dataIssues = (data: Record<string, unknown>): unknown =>
    validateProofInput(proofInput({}, data as Record<string, never>));

  it.each([
    ['2 ** 53', { id: 2 ** 53 }, '/data/id'],
    ['1e300', { x: 1e300 }, '/data/x'],
    ['-(2 ** 53)', { x: -(2 ** 53) }, '/data/x'],
    ['inside a list', { a: [1, 2 ** 53] }, '/data/a/1'],
    ['inside an object', { a: { b: -1e20 } }, '/data/a/b'],
  ])('refuses a number beyond 2^53 (%s, D-5)', (_name, data, path) => {
    expect(dataIssues(data)).toEqual([{ path, message: `number beyond 2^53 at ${path}` }]);
  });

  it('accepts the largest safe integers and any smaller number', () => {
    const data = { max: 2 ** 53 - 1, min: -(2 ** 53 - 1), small: 1e-300, zero: -0, rate: 0.055 };
    expect(dataIssues(data)).toEqual([]);
  });

  it('refuses a number beyond 2^53 in meta.context too', () => {
    expect(validateProofInput(proofInput({ context: { n: 2 ** 60 } }))).toEqual([
      { path: '/meta/context/n', message: 'number beyond 2^53 at /meta/context/n' },
    ]);
  });

  it('refuses a root key of data starting with $ (D-3), not a deeper one', () => {
    expect(dataIssues({ $x: 1, $outputs: {} })).toEqual([
      { path: '/data/$x', message: 'reserved key /data/$x' },
      { path: '/data/$outputs', message: 'reserved key /data/$outputs' },
    ]);
    expect(dataIssues({ a: { $x: 1 }, b: [{ $y: 2 }] })).toEqual([]);
  });

  it('accepts a root key starting with $ in meta.context: no rule reads it', () => {
    expect(validateProofInput(proofInput({ context: { $trace: 'x' } }))).toEqual([]);
  });

  it('refuses a lone surrogate in a key, at the path of its object', () => {
    expect(dataIssues({ a: { 'k\uD800': 1 } })).toEqual([
      { path: '/data/a', message: '/data/a has a key with a lone UTF-16 surrogate: "k\\ud800"' },
    ]);
  });

  it('refuses a lone surrogate in a text', () => {
    expect(dataIssues({ a: ['ok', 'x\uDC00'] })).toEqual([
      { path: '/data/a/1', message: '/data/a/1 contains a lone UTF-16 surrogate' },
    ]);
  });

  it('writes keys in pointers with RFC 6901 escapes', () => {
    expect(dataIssues({ 'a/b': { '~c': 2 ** 53 } })).toEqual([
      { path: '/data/a~1b/~0c', message: 'number beyond 2^53 at /data/a~1b/~0c' },
    ]);
  });

  class Money {
    amount = 1;
  }

  it.each([
    ['undefined', { x: undefined }, 'undefined'],
    ['NaN', { x: NaN }, 'NaN'],
    ['Infinity', { x: Infinity }, 'Infinity'],
    ['-Infinity', { x: -Infinity }, '-Infinity'],
    ['a bigint', { x: 1n }, 'a bigint'],
    ['a function', { x: () => 1 }, 'a function'],
    ['a symbol', { x: Symbol('s') }, 'a symbol'],
    ['a Date', { x: new Date(0) }, 'a Date: write it as a string'],
    ['a Map', { x: new Map() }, 'an object that is neither plain nor an array'],
    ['a class instance', { x: new Money() }, 'an object that is neither plain nor an array'],
  ])('refuses %s', (_name, data, what) => {
    expect(dataIssues(data)).toEqual([
      { path: '/data/x', message: `/data/x is not JSON: ${what}` },
    ]);
  });

  it('refuses a hole in a list', () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
    expect(dataIssues({ a: [1, , 3] })).toEqual([
      { path: '/data/a/1', message: '/data/a/1 is not JSON: undefined' },
    ]);
  });

  it('refuses a circular reference', () => {
    const data: Record<string, unknown> = { a: 1 };
    data.self = data;
    const list: unknown[] = [];
    list.push({ back: list });
    data.list = list;
    expect(dataIssues(data)).toEqual([
      { path: '/data/self', message: '/data/self is not JSON: a circular reference' },
      { path: '/data/list/0/back', message: '/data/list/0/back is not JSON: a circular reference' },
    ]);
  });
});

describe('validateProofInput: hostile values (pre-flight I20, R30)', () => {
  it('reports a getter that throws, at its pointer, and keeps checking the rest', () => {
    const data = { ok: 2 ** 53 };
    Object.defineProperty(data, 'bad', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(validateProofInput(proofInput({}, data))).toEqual([
      { path: '/data/ok', message: 'number beyond 2^53 at /data/ok' },
      { path: '/data/bad', message: '/data/bad could not be read: boom' },
    ]);
  });

  it('reports a throwing getter on a field of meta', () => {
    const meta: Record<string, unknown> = { ...proofInput().meta };
    Object.defineProperty(meta, 'tags', {
      enumerable: true,
      get() {
        throw new Error('no tags');
      },
    });
    expect(validateProofInput({ data: {}, meta })).toEqual([
      { path: '/meta/tags', message: '/meta/tags could not be read: no tags' },
    ]);
  });

  it('accepts a transparent Proxy, and names a Proxy whose traps throw', () => {
    expect(validateProofInput(new Proxy(proofInput(), {}))).toEqual([]);
    const trap = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap');
        },
      },
    );
    expect(validateProofInput(proofInput({}, trap))).toEqual([
      { path: '/data', message: '/data could not be read: trap' },
    ]);
  });

  it('names a revoked Proxy, never throwing', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(validateProofInput(proxy)).toEqual([
      {
        path: '',
        message:
          "proof input could not be read: Cannot perform 'IsArray' on a proxy that has been " +
          'revoked',
      },
    ]);
    expect(validateProofInput(proofInput({ context: proxy as Record<string, never> }))).toEqual([
      {
        path: '/meta/context',
        message:
          "/meta/context could not be read: Cannot perform 'IsArray' on a proxy that has been " +
          'revoked',
      },
    ]);
  });

  it(`accepts values ${MAX_INPUT_DEPTH} levels deep and refuses one level more`, () => {
    expect(MAX_INPUT_DEPTH).toBe(1000);
    expect(validateProofInput(proofInput({}, { a: nested(MAX_INPUT_DEPTH - 1) as never }))).toEqual(
      [],
    );
    const path = `/data${'/a'.repeat(MAX_INPUT_DEPTH)}`;
    expect(validateProofInput(proofInput({}, { a: nested(MAX_INPUT_DEPTH) as never }))).toEqual([
      { path, message: `${path.slice(0, 100)}… nests values more than 1000 levels deep` },
    ]);
  });

  it('names a nesting 10 000 levels deep without overflowing the stack', () => {
    let list: unknown = [];
    for (let i = 0; i < 10_000; i++) list = [list];
    const path = `/meta/context/l${'/0'.repeat(MAX_INPUT_DEPTH - 1)}`;
    expect(validateProofInput(proofInput({ context: { l: list as never } }))).toEqual([
      { path, message: `${path.slice(0, 100)}… nests values more than 1000 levels deep` },
    ]);
  });

  it('reads a value shared by many paths once, and judges its depth at each place', () => {
    let reads = 0;
    const leaf = {};
    Object.defineProperty(leaf, 'v', {
      enumerable: true,
      get() {
        reads += 1;
        return 1;
      },
    });
    // 2^60 paths through 61 distinct objects: walking every path would never end.
    let dag: unknown = leaf;
    for (let i = 0; i < 60; i++) dag = { l: dag, r: dag };
    expect(validateProofInput(proofInput({}, { dag: dag as never }))).toEqual([]);
    expect(reads).toBe(1);

    const shared = nested(10);
    const deep = nested(MAX_INPUT_DEPTH - 5) as Record<string, unknown>;
    let cursor = deep;
    for (let i = 0; i < MAX_INPUT_DEPTH - 6; i++) cursor = cursor.a as Record<string, unknown>;
    cursor.a = shared;
    const path = `/data/deep${'/a'.repeat(MAX_INPUT_DEPTH - 5)}`;
    expect(
      validateProofInput(proofInput({}, { first: shared as never, deep: deep as never })),
    ).toEqual([
      { path, message: `${path.slice(0, 100)}… nests values more than 1000 levels deep` },
    ]);
  });

  it(`refuses more than ${MAX_INPUT_VALUES} values before reading them`, () => {
    expect(MAX_INPUT_VALUES).toBe(10_000_000);
    let indexReads = 0;
    const huge = new Proxy([], {
      get(target, key) {
        if (key === 'length') return 1e12;
        indexReads += 1;
        return Reflect.get(target, key);
      },
    });
    expect(validateProofInput(proofInput({}, { huge: huge as never }))).toEqual([
      { path: '/data/huge', message: 'input too large: more than 10000000 values' },
    ]);
    expect(indexReads).toBe(0);
    const sparse: unknown[] = [];
    sparse.length = 2 ** 32 - 1;
    expect(validateProofInput(proofInput({}, { sparse: sparse as never }))).toEqual([
      { path: '/data/sparse', message: 'input too large: more than 10000000 values' },
    ]);
  });

  it('counts the values it reads, so the work is bounded by the size of the input', () => {
    const data = { list: Array.from({ length: 1000 }, (_, i) => ({ i })) };
    // data and meta, meta's six fields, the reference date, data's key, the list's 1000
    // elements and the key of each element: one read each.
    expect(inputCheckReads(proofInput({}, data))).toBe(2 + 6 + 1 + 1 + 1000 + 1000);
  });

  it('reads each property exactly once (counting getters)', () => {
    const counts = new Map<string, number>();
    const counted = (value: unknown, path: string): unknown => {
      if (value === null || typeof value !== 'object') return value;
      const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
      for (const [key, member] of Object.entries(value)) {
        const inner = counted(member, `${path}/${key}`);
        Object.defineProperty(out, key, {
          enumerable: true,
          get() {
            counts.set(`${path}/${key}`, (counts.get(`${path}/${key}`) ?? 0) + 1);
            return inner;
          },
        });
      }
      return out;
    };
    const input = proofInput(
      {
        dates: { effective: '2026-01-01', facture: '2026-01-01T10:00:00.000Z' },
        tags: ['a', 'b'],
        dimensions: { pays: ['FR', 'US'], secteur: 'C' },
        context: { channel: 'web' },
        assertions: {
          '/revenue': {
            by: 'ai-1',
            method: 'ai',
            at: '2026-01-02T08:00:00.000Z',
            status: 'proposed',
            confidence: 0.8,
            evidenceDigest: 'a'.repeat(64),
          },
        },
      },
      { revenue: 1000, items: [{ q: 1 }, { q: 2 }] },
    );
    expect(validateProofInput(counted(input, ''))).toEqual([]);
    expect(counts.size).toBe(30);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });
});
