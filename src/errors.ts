export type SpecErrorCode =
  | 'NON_SERIALIZABLE'
  | 'INVALID_DATE'
  | 'INVALID_RULE'
  | 'INVALID_PROOF'
  | 'INVALID_KEY'
  | 'INVALID_DECIMAL';

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
