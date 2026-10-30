export type SpecErrorCode = 'NON_SERIALIZABLE' | 'INVALID_DATE' | 'INVALID_RULE';

/** Thrown by every `@run-iq/spec` function; `code` says which contract was broken. */
export class SpecError extends Error {
  readonly code: SpecErrorCode;

  constructor(code: SpecErrorCode, message: string) {
    super(message);
    this.name = 'SpecError';
    this.code = code;
  }
}
