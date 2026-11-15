import { PROOF_FORMAT } from './types.js';
import { arraySome, objectFreeze } from '../intrinsics.js';

/**
 * The proof formats this package reads, accepted for ever: a format is never withdrawn. A new
 * value in a closed enumeration or a new required field makes a next format
 * (`run-iq.proof/2`), never a change to an existing one. Frozen.
 */
export const PROOF_FORMATS: readonly string[] = objectFreeze([PROOF_FORMAT]);

/** Internal: true for a format listed in `PROOF_FORMATS`. */
export function isProofFormat(value: unknown): boolean {
  return arraySome(PROOF_FORMATS, (format) => format === value);
}
