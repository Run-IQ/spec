export type SpecErrorCode = 'NON_SERIALIZABLE' | 'INVALID_DATE' | 'INVALID_RULE';

/** Thrown by every `@run-iq/spec` function; `code` says which contract was broken. */
export class SpecError extends Error {
  readonly code: SpecErrorCode;
  /**
   * Path of the value `canonicalize` could not serialize (`params.rates[1]`), set only on
   * those `NON_SERIALIZABLE` errors, whichever function called `canonicalize`. Absent on
   * every other error.
   */
  readonly path?: string;

  constructor(code: SpecErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'SpecError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}
