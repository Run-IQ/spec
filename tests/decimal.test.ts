import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import { isCanonicalDecimal, SpecError, toCanonicalDecimal } from '../src/index.js';

const LONG_DIGITS = '9'.repeat(5000);

/** [text, canonical form]: texts toCanonicalDecimal accepts. */
const CONVERTED: [string, string][] = [
  ['0', '0'],
  ['00', '0'],
  ['-0', '0'],
  ['-0.0', '0'],
  ['-0.00', '0'],
  ['0.000', '0'],
  ['0012.50', '12.5'],
  ['12.5', '12.5'],
  ['-3', '-3'],
  ['-003.100', '-3.1'],
  ['1.000', '1'],
  ['0.05', '0.05'],
  ['-0.050', '-0.05'],
  ['100', '100'],
  ['1000.0001', '1000.0001'],
  [`000${LONG_DIGITS}.${LONG_DIGITS}000`, `${LONG_DIGITS}.${LONG_DIGITS}`],
  [`0.${'0'.repeat(4000)}1`, `0.${'0'.repeat(4000)}1`],
];

/** Texts that are not decimals at all: toCanonicalDecimal throws INVALID_DECIMAL. */
const NOT_DECIMALS: string[] = [
  '',
  '.',
  '-',
  '.5',
  '5.',
  '-.5',
  '+1',
  '1e3',
  '1E3',
  '1.5e-2',
  ' 1',
  '1 ',
  '1 000',
  '1,5',
  '0x10',
  'NaN',
  'Infinity',
  '--1',
  '1.2.3',
  '١٢',
];

describe('isCanonicalDecimal', () => {
  it.each(['0', '12.5', '-3', '-0.5', '0.05', '100', `${LONG_DIGITS}.${LONG_DIGITS}`])(
    'accepts %s',
    (text) => {
      expect(isCanonicalDecimal(text)).toBe(true);
    },
  );

  it.each(['-0', '-0.0', '00', '012', '12.50', '1.0', '0.0', '1e3', ...NOT_DECIMALS])(
    'refuses %j',
    (text) => {
      expect(isCanonicalDecimal(text)).toBe(false);
    },
  );

  it('refuses a value that is not a string, for a JavaScript caller', () => {
    for (const value of [12.5, 0, null, undefined, ['1'], { text: '1' }]) {
      expect(isCanonicalDecimal(value as unknown as string)).toBe(false);
    }
  });

  it('holds exactly for the canonical form of a decimal', () => {
    for (const [text, canonical] of CONVERTED) {
      expect(isCanonicalDecimal(text)).toBe(text === canonical);
      expect(isCanonicalDecimal(canonical)).toBe(true);
    }
  });
});

describe('toCanonicalDecimal', () => {
  it.each(CONVERTED.map(([text, canonical]) => [text.slice(0, 40), text, canonical]))(
    'writes %j canonically',
    (_label, text, canonical) => {
      expect(toCanonicalDecimal(text)).toBe(canonical);
    },
  );

  it('is idempotent', () => {
    for (const [text] of CONVERTED) {
      const once = toCanonicalDecimal(text);
      expect(toCanonicalDecimal(once)).toBe(once);
    }
  });

  it.each(NOT_DECIMALS)('refuses %j with INVALID_DECIMAL', (text) => {
    let thrown: unknown;
    try {
      toCanonicalDecimal(text);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SpecError);
    expect(thrown).toMatchObject({
      code: 'INVALID_DECIMAL',
      message:
        `Not a decimal: ${JSON.stringify(text)} (expected an optional "-", digits, ` +
        'and an optional "." followed by digits; no exponent, no spaces)',
    });
  });

  it('refuses a value that is not a string, naming its type', () => {
    for (const [value, described] of [
      [12.5, 'a number'],
      [null, 'null'],
      [undefined, 'undefined'],
      [['1'], 'an array'],
    ] as const) {
      expect(() => toCanonicalDecimal(value as unknown as string)).toThrow(
        expect.objectContaining({
          code: 'INVALID_DECIMAL',
          message: `Not a decimal: ${described} (expected a string)`,
        }),
      );
    }
  });
});

describe('both entries', () => {
  it('export the decimal functions', () => {
    expect(canonicalEntry.isCanonicalDecimal).toBe(isCanonicalDecimal);
    expect(canonicalEntry.toCanonicalDecimal).toBe(toCanonicalDecimal);
  });
});
