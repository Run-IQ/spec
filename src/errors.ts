export type SpecErrorCode = 'NON_SERIALIZABLE' | 'INVALID_DATE' | 'INVALID_RULE';

/** Thrown by every `@run-iq/spec` function; `code` says which contract was broken. */
export class SpecError extends Error {
  readonly code: SpecErrorCode;
  /** Path of the offending value (`params.rates[1]`), when the error is about one value. */
  readonly path?: string;

  constructor(code: SpecErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'SpecError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}
