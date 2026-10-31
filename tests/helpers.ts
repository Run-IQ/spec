import { SpecError } from '../src/index.js';

/** The `SpecError` `call` throws; fails the test when it throws anything else, or nothing. */
export function specError(call: () => unknown): SpecError {
  try {
    call();
  } catch (error) {
    if (error instanceof SpecError) return error;
    throw error;
  }
  throw new Error('expected a SpecError');
}
