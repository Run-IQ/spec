import { newSpecError, quoteText } from '../errors.js';

/** A canonical decimal: no leading zero, no trailing fractional zero, no exponent. */
const CANONICAL = /^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;
/** Any decimal `toCanonicalDecimal` accepts: an optional `-`, digits, an optional fraction. */
const DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;
const ZERO = 0x30;

/**
 * True when `text` is a decimal in canonical form, the form a `decimal` output holds: an
 * optional `-`, an integer part without leading zero, and a fractional part without trailing
 * zero, if any (`"12.5"`, `"0"`, `"-3"`). `"-0"`, `"12.50"`, `"012"`, `"1e3"`, `".5"`, `"+1"`
 * and any value that is not a string are not. Any number of digits is allowed.
 */
export function isCanonicalDecimal(text: string): boolean {
  return typeof text === 'string' && text !== '-0' && CANONICAL.test(text);
}

/**
 * The canonical form of a decimal written in text: leading zeros of the integer part and
 * trailing zeros of the fractional part are removed, and a zero loses its sign
 * (`"0012.50"` gives `"12.5"`, `"-0.0"` gives `"0"`). The conversion is textual and exact, for
 * any number of digits; it is idempotent.
 *
 * Throws `SpecError` (`INVALID_DECIMAL`) when `text` is not a string made of an optional `-`,
 * ASCII digits, and an optional `.` followed by digits: an exponent, a `+`, spaces, a
 * separator, `".5"` or `"5."` are refused rather than guessed.
 */
export function toCanonicalDecimal(text: string): string {
  if (typeof text !== 'string') {
    throw newSpecError('INVALID_DECIMAL', `Not a decimal: ${describe(text)} (expected a string)`);
  }
  const parts = DECIMAL.exec(text);
  if (!parts) {
    throw newSpecError(
      'INVALID_DECIMAL',
      `Not a decimal: ${quoteText(text)} (expected an optional "-", digits, and an ` +
        'optional "." followed by digits; no exponent, no spaces)',
    );
  }
  const [, sign = '', digits = '', fraction = ''] = parts;
  const integer = digits.replace(/^0+(?=[0-9])/, '');
  let end = fraction.length;
  while (end > 0 && fraction.charCodeAt(end - 1) === ZERO) end--;
  const decimals = fraction.slice(0, end);
  const magnitude = decimals === '' ? integer : `${integer}.${decimals}`;
  return magnitude === '0' ? '0' : `${sign}${magnitude}`;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (isArray(value)) return 'an array';
  const type = typeof value;
  return type === 'undefined' ? 'undefined' : `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`;
}

/** `Array.isArray`, false when it throws (a revoked Proxy). */
function isArray(value: unknown): boolean {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}
