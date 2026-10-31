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
 */
export class SpecError extends Error {
  readonly code: SpecErrorCode;
  /**
   * Path of the value `canonicalize` (or `canonicalizeAt`) could not serialize
   * (`params.rates[1]`), set only on those `NON_SERIALIZABLE` errors, whichever function
   * called it. Absent on every other error.
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

/** Internal: the `path` of a `SpecError`, or `undefined` for anything else; never throws. */
export function specErrorPath(error: unknown): string | undefined {
  try {
    return error instanceof SpecError && error.path ? error.path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Internal: why the value at `subject` could not be read, never throwing:
 * `<subject> is too deeply nested` when the call stack overflowed while reading it, otherwise
 * `<subject> could not be read: <reason>` (a getter or a Proxy trap threw `error`).
 */
export function unreadableMessage(subject: string, error: unknown): string {
  return isStackOverflow(error)
    ? `${subject} is too deeply nested`
    : `${subject} could not be read: ${describeError(error)}`;
}

/** True for the `RangeError` a call stack overflow throws; never throws. */
function isStackOverflow(error: unknown): boolean {
  try {
    return error instanceof RangeError && /call stack/i.test(error.message);
  } catch {
    return false;
  }
}

/** Longest text a message cites before cutting it. */
const EXCERPT_LENGTH = 100;

/**
 * Internal: `text` as a message cites it: its first 100 UTF-16 code units, followed by `…` when
 * it is longer, so a huge value never makes a huge message.
 */
export function excerpt(text: string): string {
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text;
}

/**
 * Internal: `text` quoted for a message, as a JSON string (a lone surrogate or a control
 * character is escaped), cut like `excerpt`.
 */
export function quoteText(text: string): string {
  return JSON.stringify(excerpt(text));
}
