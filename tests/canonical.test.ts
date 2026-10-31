import { describe, expect, it } from 'vitest';
import { canonicalize, canonicalizeAt, SpecError } from '../src/index.js';
import { specError } from './helpers.js';

const nonSerializable = expect.objectContaining({ code: 'NON_SERIALIZABLE' });

describe('canonicalize', () => {
  it('serialises scalars like JSON', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize(0)).toBe('0');
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize(1.5)).toBe('1.5');
    expect(canonicalize(1e21)).toBe('1e+21');
    expect(canonicalize('a"b\\c\n')).toBe(JSON.stringify('a"b\\c\n'));
    expect(canonicalize('é€😀')).toBe('"é€😀"');
  });

  it('sorts object keys at every depth', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  it('sorts keys by code unit, integer-like keys included', () => {
    expect(canonicalize({ b: 1, 10: 2, 2: 3, A: 4, _: 5 })).toBe(
      '{"10":2,"2":3,"A":4,"_":5,"b":1}',
    );
  });

  it('gives the same string whatever the insertion order', () => {
    const a = { x: 1, y: { p: true, q: null }, z: ['s', 2] };
    const b = { z: ['s', 2], y: { q: null, p: true }, x: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('keeps array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('omits undefined object properties', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalize({ a: { b: undefined } })).toBe('{"a":{}}');
  });

  it('turns undefined in an array into null, and refuses a hole: it is not JSON', () => {
    expect(canonicalize([1, undefined, 3])).toBe('[1,null,3]');
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
    expect(specError(() => canonicalize({ a: [1, , 3] }))).toMatchObject({
      code: 'NON_SERIALIZABLE',
      path: 'a',
      message: 'a has a hole at index 1: arrays must be dense',
    });
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
    expect(specError(() => canonicalize([, 1]))).toMatchObject({
      path: '',
      message: '(root) has a hole at index 0: arrays must be dense',
    });
  });

  it('serialises a Date as its ISO string', () => {
    expect(canonicalize({ d: new Date('2025-01-01T00:00:00Z') })).toBe(
      '{"d":"2025-01-01T00:00:00.000Z"}',
    );
  });

  it('accepts objects without a prototype', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.b = 1;
    o.a = 2;
    expect(canonicalize(o)).toBe('{"a":2,"b":1}');
  });

  it('accepts the same object referenced twice when it is not a cycle', () => {
    const shared = { v: 1 };
    expect(canonicalize({ a: shared, b: shared, c: [shared, shared] })).toBe(
      '{"a":{"v":1},"b":{"v":1},"c":[{"v":1},{"v":1}]}',
    );
  });

  it('ignores symbol keys, as JSON does', () => {
    expect(canonicalize({ a: 1, [Symbol('s')]: 2 })).toBe('{"a":1}');
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['a bigint', 10n],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['an invalid Date', new Date('nope')],
    ['a Map', new Map([['a', 1]])],
    ['a Set', new Set([1])],
    ['a class instance', new (class Foo {})()],
    ['a RegExp', /x/],
  ])('rejects %s', (_label, value) => {
    expect(() => canonicalize(value)).toThrow(nonSerializable);
    expect(() => canonicalize({ nested: { value } })).toThrow(nonSerializable);
    expect(() => canonicalize([value])).toThrow(nonSerializable);
  });

  it('rejects undefined at the top level only', () => {
    expect(() => canonicalize(undefined)).toThrow(nonSerializable);
  });

  it('rejects a function or symbol property instead of dropping it', () => {
    expect(() => canonicalize({ f() {} })).toThrow(nonSerializable);
    expect(() => canonicalize({ s: Symbol('s') })).toThrow(nonSerializable);
  });

  it('rejects circular references', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(() => canonicalize(o)).toThrow(nonSerializable);
    const arr: unknown[] = [1];
    arr.push({ back: arr });
    expect(() => canonicalize(arr)).toThrow(nonSerializable);
  });

  it('names the offending path in the error', () => {
    try {
      canonicalize({ params: { brackets: [{ rate: NaN }] } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SpecError);
      expect((err as SpecError).message).toContain('params.brackets[0].rate');
    }
  });

  it('applies no Unicode normalization: strings are data', () => {
    expect(canonicalize('\u00e9')).not.toBe(canonicalize('e\u0301'));
  });

  it('refuses a Decimal-like class instance: the caller converts it to JSON', () => {
    class Decimal {
      constructor(readonly value: string) {}
      toJSON(): string {
        return this.value;
      }
    }
    expect(() => canonicalize({ amount: new Decimal('1.10') })).toThrow(nonSerializable);
    expect(canonicalize({ amount: '1.10' })).toBe('{"amount":"1.10"}');
  });

  it('does not use toJSON', () => {
    expect(() => canonicalize({ toJSON: () => 'x' })).toThrow(nonSerializable);
  });
});

describe('canonicalizeAt', () => {
  it('serialises like canonicalize', () => {
    expect(canonicalizeAt({ b: 1, a: [true] }, 'metadata')).toBe(canonicalize({ b: 1, a: [true] }));
  });

  it('names the offending value from the given root', () => {
    expect(() => canonicalizeAt({ score: Infinity }, 'metadata')).toThrow(
      expect.objectContaining({
        code: 'NON_SERIALIZABLE',
        path: 'metadata.score',
        message: expect.stringContaining('"metadata.score"'),
      }),
    );
    expect(() => canonicalizeAt(new Map(), 'metadata')).toThrow(
      expect.objectContaining({ path: 'metadata' }),
    );
  });
});

describe('SpecError identity', () => {
  it('brands instances without an enumerable property', () => {
    const error = new SpecError('NON_SERIALIZABLE', 'x', 'a.b');
    expect(error).toBeInstanceOf(SpecError);
    expect(error).toBeInstanceOf(Error);
    const brand = Symbol.for('@run-iq/spec/SpecError');
    expect(Object.getOwnPropertyDescriptor(error, brand)).toMatchObject({
      value: true,
      enumerable: false,
    });
    expect(Object.keys(error)).not.toContain(brand);
    expect(Object.getOwnPropertySymbols({ ...error })).not.toContain(brand);
  });

  it('a plain Error is not a SpecError', () => {
    expect(new Error('x')).not.toBeInstanceOf(SpecError);
    expect(Object.assign(new Error('x'), { name: 'SpecError' })).not.toBeInstanceOf(SpecError);
    expect(null).not.toBeInstanceOf(SpecError);
  });

  it('a subclass keeps code, path and its own instanceof', () => {
    class MyError extends SpecError {}
    const mine = new MyError('INVALID_DATE', 'x', 'effectiveFrom');
    expect(mine).toBeInstanceOf(MyError);
    expect(mine).toBeInstanceOf(SpecError);
    expect(mine).toMatchObject({ code: 'INVALID_DATE', path: 'effectiveFrom', name: 'SpecError' });
    expect(new SpecError('INVALID_DATE', 'x')).not.toBeInstanceOf(MyError);
  });
});
