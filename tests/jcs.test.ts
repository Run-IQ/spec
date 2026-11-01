import { describe, expect, it } from 'vitest';
import { canonicalize, canonicalizeAt } from '../src/index.js';
import { specError } from './helpers.js';
import { canonical } from './hashing.js';

// Vectors from RFC 8785 (JSON Canonicalization Scheme), sections 3.2.2 and 3.2.3.
describe('canonicalize is JCS (RFC 8785)', () => {
  it('writes numbers as ECMAScript does (section 3.2.2.3)', () => {
    // RFC 8785 writes this vector with more digits than a double holds: that is its point.
    // eslint-disable-next-line @typescript-eslint/no-loss-of-precision
    expect(canonical({ numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27] })).toBe(
      '{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}',
    );
  });

  it('sorts keys by UTF-16 code unit (section 3.2.3)', () => {
    expect(canonical({ '€': 1, '\r': 2, '1': 3, ö: 4 })).toBe('{"\\r":2,"1":3,"ö":4,"€":1}');
  });

  // Built from code points: an editor or a formatter could rewrite these characters.
  const ch = (...codes: number[]): string => String.fromCharCode(...codes);

  // RFC 8785 Appendix B: IEEE 754 double (big-endian hex) -> JCS text, every finite row.
  const APPENDIX_B: [string, string][] = [
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ];
  const double = (hex: string): number => Buffer.from(hex, 'hex').readDoubleBE(0);

  it('writes every finite number of RFC 8785 Appendix B', () => {
    expect(APPENDIX_B).toHaveLength(24);
    for (const [hex, text] of APPENDIX_B) expect(canonical(double(hex)), hex).toBe(text);
  });

  it('refuses the NaN and Infinity rows of Appendix B', () => {
    for (const hex of ['7fffffffffffffff', '7ff0000000000000']) {
      expect(specError(() => canonicalize(double(hex))).code).toBe('NON_SERIALIZABLE');
    }
  });

  it('writes the RFC 8785 sorting vector in order', () => {
    const entries: [string, string][] = [
      [ch(0x20ac), 'Euro Sign'],
      [ch(0x0d), 'Carriage Return'],
      [ch(0xfb33), 'Hebrew Letter Dalet With Dagesh'],
      ['1', 'One'],
      [ch(0xd83d, 0xde00), 'Emoji: Grinning Face'],
      [ch(0x80), 'Control'],
      [ch(0xf6), 'Latin Small Letter O With Diaeresis'],
    ];
    const expected = [1, 3, 5, 6, 0, 4, 2].map((i) => entries[i]!);
    const text = (key: string): string => (key === ch(0x0d) ? '\\r' : key);
    expect(canonical(Object.fromEntries(entries))).toBe(
      `{${expected.map(([key, name]) => `"${text(key)}":"${name}"`).join(',')}}`,
    );
  });

  it('escapes strings as section 3.2.2.2 says', () => {
    // RFC: "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/" gives "€$\u000f\nA'B\"\\\\\"/"
    const value = `${ch(0x20ac)}$${ch(0x0f, 0x0a)}A'B"${ch(0x5c, 0x5c)}"/`;
    const backslash = ch(0x5c);
    const escaped =
      `"${ch(0x20ac)}$${backslash}u000f${backslash}nA'B${backslash}"` + `${backslash.repeat(5)}"/"`;
    expect(canonical(value)).toBe(escaped);
  });

  it('writes -0 as 0', () => {
    expect(canonical(-0)).toBe('0');
    expect(canonical({ a: [-0] })).toBe('{"a":[0]}');
  });
});

describe('canonicalize refuses lone UTF-16 surrogates (I-JSON, pre-flight M-1)', () => {
  it.each([
    [
      'a lone high surrogate in a value',
      { a: '\ud800' },
      'a',
      'a string with a lone UTF-16 surrogate',
    ],
    [
      'a lone low surrogate in a value',
      ['ok', 'x\udc00'],
      '[1]',
      'a string with a lone UTF-16 surrogate',
    ],
    [
      'reversed surrogates',
      { a: { b: '\ude00\ud83d' } },
      'a.b',
      'a string with a lone UTF-16 surrogate',
    ],
    ['a lone surrogate at the top level', '\ud800', '', 'a string with a lone UTF-16 surrogate'],
    [
      'a lone surrogate in a key',
      { a: { '\ud800': 1 } },
      'a',
      'a key with a lone UTF-16 surrogate',
    ],
    [
      'a lone surrogate in a top-level key',
      { '\udfff': 1 },
      '',
      'a key with a lone UTF-16 surrogate',
    ],
  ])('%s', (_label, value, path, what) => {
    const error = specError(() => canonicalize(value));
    expect(error.code).toBe('NON_SERIALIZABLE');
    expect(error.path).toBe(path);
    expect(error.message).toBe(
      `Value at "${path || '(root)'}" cannot be serialized to canonical JSON: ${what}`,
    );
  });

  it('omits a key with a lone surrogate whose value is undefined, like any undefined one', () => {
    expect(canonical({ a: 1, '\udfff': undefined })).toBe('{"a":1}');
  });

  it('keeps well-formed pairs', () => {
    expect(canonical({ '😀': '😀' })).toBe('{"😀":"😀"}');
  });

  it('names the root given to canonicalizeAt', () => {
    expect(specError(() => canonicalizeAt({ k: '\ud800' }, 'data')).path).toBe('data.k');
  });

  it('escapes the control characters of a path in messages', () => {
    const error = specError(() => canonicalize({ 'a\nb': Number.NaN }));
    expect(error.path).toBe('a\nb');
    expect(error.message).toBe('Value at "a\\nb" cannot be serialized to canonical JSON: NaN');
  });

  it('finds a lone surrogate at the end of a huge string', () => {
    const error = specError(() => canonicalize(`${'a'.repeat(5_000_000)}\ud800`));
    expect(error.code).toBe('NON_SERIALIZABLE');
  }, 60_000);
});
