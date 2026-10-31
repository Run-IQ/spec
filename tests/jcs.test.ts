import { describe, expect, it } from 'vitest';
import { canonicalize, canonicalizeAt, SpecError } from '../src/index.js';

/** The `SpecError` `call` throws; fails the test when it does not throw one. */
function specError(call: () => unknown): SpecError {
  try {
    call();
  } catch (error) {
    if (error instanceof SpecError) return error;
    throw error;
  }
  throw new Error('expected a SpecError');
}

// Vectors from RFC 8785 (JSON Canonicalization Scheme), sections 3.2.2 and 3.2.3.
describe('canonicalize is JCS (RFC 8785)', () => {
  it('writes numbers as ECMAScript does (section 3.2.2.3)', () => {
    // RFC 8785 writes this vector with more digits than a double holds: that is its point.
    // eslint-disable-next-line @typescript-eslint/no-loss-of-precision
    expect(canonicalize({ numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27] })).toBe(
      '{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}',
    );
  });

  it('sorts keys by UTF-16 code unit (section 3.2.3)', () => {
    expect(canonicalize({ '€': 1, '\r': 2, '1': 3, ö: 4 })).toBe('{"\\r":2,"1":3,"ö":4,"€":1}');
  });

  // Built from code points: an editor or a formatter could rewrite these characters.
  const ch = (...codes: number[]): string => String.fromCharCode(...codes);

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
    expect(canonicalize(Object.fromEntries(entries))).toBe(
      `{${expected.map(([key, name]) => `"${text(key)}":"${name}"`).join(',')}}`,
    );
  });

  it('escapes strings as section 3.2.2.2 says', () => {
    // RFC: "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/" gives "€$\u000f\nA'B\"\\\\\"/"
    const value = `${ch(0x20ac)}$${ch(0x0f, 0x0a)}A'B"${ch(0x5c, 0x5c)}"/`;
    const escaped = `"${ch(0x20ac)}$${ch(0x5c)}u000f${ch(0x5c)}nA'B${ch(0x5c)}"${ch(0x5c, 0x5c, 0x5c, 0x5c, 0x5c)}"/"`;
    expect(canonicalize(value)).toBe(escaped);
  });

  it('writes -0 as 0', () => {
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize({ a: [-0] })).toBe('{"a":[0]}');
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

  it('omits a key with a lone surrogate whose value is undefined, like any undefined member', () => {
    expect(canonicalize({ a: 1, '\udfff': undefined })).toBe('{"a":1}');
  });

  it('keeps well-formed pairs', () => {
    expect(canonicalize({ '😀': '😀' })).toBe('{"😀":"😀"}');
  });

  it('names the root given to canonicalizeAt', () => {
    expect(specError(() => canonicalizeAt({ k: '\ud800' }, 'data')).path).toBe('data.k');
  });

  it('finds a lone surrogate at the end of a huge string', () => {
    const error = specError(() => canonicalize(`${'a'.repeat(5_000_000)}\ud800`));
    expect(error.code).toBe('NON_SERIALIZABLE');
  });
});
