/**
 * Job 7, D5: the cost of the exact decimal functions at the limit. Operands of 50 000 and 100 000
 * digits finish within a stated budget (the test timeout), and a result past the limit is refused.
 */
import { describe, expect, it } from 'vitest';
import {
  addDecimals,
  divideDecimals,
  MAX_DECIMAL_DIGITS,
  multiplyDecimals,
  SpecError,
} from '../../src/index.js';

const digits = (length: number, seed: number): string => {
  let text = String(1 + (seed % 9));
  let state = seed;
  while (text.length < length) {
    state = (state * 1103515245 + 12345) % 2147483648;
    text += String(state % 10);
  }
  return text.slice(0, length);
};

describe('the exact decimal functions at scale', () => {
  it('divides 50 000-digit operands exactly, within 60 s', () => {
    const a = digits(50_000, 3);
    const b = digits(25_000, 7);
    const scale = 20;
    const result = divideDecimals(a, b, { scale, mode: 'down' });
    const quotient = (BigInt(a) * 10n ** BigInt(scale)) / BigInt(b);
    const text = quotient.toString().padStart(scale + 1, '0');
    const expected = `${text.slice(0, text.length - scale)}.${text.slice(text.length - scale)}`;
    expect(result).toBe(expected.replace(/0+$/, '').replace(/\.$/, ''));
  }, 60_000);

  it('adds operands at the limit, and refuses a multiplication past it, within 60 s', () => {
    const a = digits(MAX_DECIMAL_DIGITS, 5);
    const b = digits(MAX_DECIMAL_DIGITS, 9);
    expect(addDecimals(a, b)).toBe((BigInt(a) + BigInt(b)).toString());
    let error: unknown;
    try {
      multiplyDecimals(a, b);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SpecError);
    expect((error as SpecError).code).toBe('LIMIT_EXCEEDED');
    expect((error as SpecError).message).toContain('MAX_DECIMAL_DIGITS');
  }, 60_000);

  it('multiplies two 50 000-digit operands exactly at the limit', () => {
    const a = digits(50_000, 11);
    const b = digits(50_000, 13);
    expect(multiplyDecimals(a, b)).toBe((BigInt(a) * BigInt(b)).toString());
  }, 60_000);
});
