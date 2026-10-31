import { boundIssueText } from './issues.js';
export type SpecErrorCode =
  | 'NON_SERIALIZABLE'
  | 'INVALID_DATE'
  | 'INVALID_RULE'
  | 'INVALID_PROOF'
  | 'INVALID_KEY'
  | 'INVALID_DECIMAL'
  | 'INVALID_PATH'
  | 'INVALID_INPUT'
  | 'INVALID_REFERENTIAL'
  | 'INVALID_DISCLOSURE'
  | 'INVALID_ATTESTATION';

/**
 * Brand set on every `SpecError`. `Symbol.for` gives the same symbol to every copy of this
 * package: each built entry (`@run-iq/spec`, `@run-iq/spec/canonical`, ESM or CJS) bundles its
 * own class, and two installed versions would too.
 */
const BRAND = Symbol.for('@run-iq/spec/SpecError');

/**
 * Thrown by every `@run-iq/spec` function; `code` says which contract was broken.
 *
 * `error instanceof SpecError` holds for a `SpecError` built by ANY copy of the class (another
 * entry point or another installed copy of the package): instances carry a non-enumerable
 * brand, which `instanceof` checks. A subclass keeps the ordinary prototype check.
 *
 * A `SpecError` a caller builds and throws from a getter, a Proxy trap or a calendar is not
 * passed on as it is: like any other thrown value, it is described and cited in the message of
 * the error this package throws.
 */
export class SpecError extends Error {
  readonly code: SpecErrorCode;
  /**
   * Path of the value `canonicalize` (or `canonicalizeAt`) could not serialize
   * (`params.rates[1]`), set only on those `NON_SERIALIZABLE` errors, whichever function
   * called it. Absent on every other error. Cut like an issue path: at most 1024 code units
   * (never inside a surrogate pair), then `…`.
   */
  readonly path?: string;

  constructor(code: SpecErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'SpecError';
    this.code = code;
    if (path !== undefined) this.path = path;
    Object.defineProperty(this, BRAND, { value: true });
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    // A subclass (`class MyError extends SpecError`) keeps the plain prototype check.
    if (this !== SpecError) return Function.prototype[Symbol.hasInstance].call(this, value);
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as Record<symbol, unknown>)[BRAND] === true
    );
  }
}

/**
 * The errors this copy of the package created (`newSpecError`). Only these are trusted as they
 * are: a `SpecError` is public, so a caller's getter or Proxy trap can throw one with any code
 * and any text; such an error, like any other thrown value, is described and cited
 * (`reasonOf`), never passed on raw.
 */
const OWN_ERRORS = new WeakSet<object>();

/**
 * Internal: a `SpecError` created by this package, remembered as its own (`isOwnError`); its
 * `path` cut by `boundIssueText`.
 */
export function newSpecError(code: SpecErrorCode, message: string, path?: string): SpecError {
  // Every path cut as issue paths are (1024 code units, never inside a surrogate pair, then
  // `…`), so no site can pass on unbounded caller text (a root path, deep keys).
  const error = new SpecError(code, message, path === undefined ? undefined : boundIssueText(path));
  OWN_ERRORS.add(error);
  return error;
}

/**
 * Internal: true for an error this package created (`newSpecError`); false for any other
 * value, a `SpecError` built by a caller included. Never throws (no trap of a Proxy runs).
 */
export function isOwnError(error: unknown): error is SpecError {
  return typeof error === 'object' && error !== null && OWN_ERRORS.has(error);
}

/**
 * Internal: a readable description of any thrown value, without ever throwing. A hostile value
 * (a Proxy, a null-prototype object, an Error whose `message` getter throws) gives
 * `'unreadable value'`.
 */
export function describeError(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message: unknown = error.message;
      if (typeof message === 'string') return message;
    }
  } catch {
    return 'unreadable value';
  }
  switch (typeof error) {
    case 'string':
      return error;
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
      return String(error);
    default:
      return 'unreadable value';
  }
}

/**
 * Internal: the `path` of an error this package created, or `undefined` for anything else (a
 * caller's `SpecError` included); never throws.
 */
export function specErrorPath(error: unknown): string | undefined {
  try {
    return isOwnError(error) && error.path ? error.path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Internal: `error` as a message cites it: the message of an error this package created
 * (`isOwnError`) as it is, its caller text already cited by `citeName`; any other thrown value
 * (a caller's `SpecError` included) described (`describeError`) and cited by `citeName`.
 */
export function reasonOf(error: unknown): string {
  return isOwnError(error) ? error.message : citeName(describeError(error));
}

/**
 * Internal: why the value at `subject` could not be read, never throwing:
 * `<subject> is too deeply nested` when the call stack overflowed while reading it, otherwise
 * `<subject> could not be read: <reason>` (a getter or a Proxy trap threw `error`). `subject`
 * (raw, often a path holding caller keys) is cited by `citeName`, the reason by `reasonOf`.
 */
export function unreadableMessage(subject: string, error: unknown): string {
  return isStackOverflow(error)
    ? `${citeName(subject)} is too deeply nested`
    : `${citeName(subject)} could not be read: ${reasonOf(error)}`;
}

/** Internal: true for the `RangeError` a call stack overflow throws; never throws. */
export function isStackOverflow(error: unknown): boolean {
  try {
    return error instanceof RangeError && /call stack/i.test(error.message);
  } catch {
    return false;
  }
}

/** Longest citation a message holds, in UTF-16 code units of its escaped form. */
export const CITE_LENGTH = 256;

/**
 * Internal: the one way a message cites a caller-supplied key, path or value: its control
 * characters, lone surrogates, quotes and backslashes escaped as in a JSON string (without the
 * surrounding quotes), cut once the escaped text would pass `CITE_LENGTH` (256) code units,
 * between two code points and never inside an escape, then `…`. So a huge key never makes a
 * huge message, and the fixed text after the citation (the reason) is always kept. Reads at
 * most 256 code points of `text`.
 */
export function citeName(text: string): string {
  let out = '';
  for (let i = 0; i < text.length;) {
    const code = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    const pair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    const char = text.slice(i, i + (pair ? 2 : 1));
    const piece = JSON.stringify(char).slice(1, -1);
    if (out.length + piece.length > CITE_LENGTH) return `${out}…`;
    out += piece;
    i += char.length;
  }
  return out;
}

/** Internal: `text` quoted for a message, as a JSON string cited by `citeName`. */
export function quoteText(text: string): string {
  return `"${citeName(text)}"`;
}
