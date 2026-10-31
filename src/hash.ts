import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { newSpecError } from './errors.js';
import { hasLoneSurrogate } from './values.js';

/**
 * Lowercase hex sha256 of a UTF-8 string. Pure JavaScript: runs in Node, browsers and workers.
 * Throws `SpecError` (`NON_SERIALIZABLE`) for a value that is not a string, and for a string
 * holding a lone UTF-16 surrogate: it has no UTF-8 form (an encoder would silently put U+FFFD in
 * its place, so two different strings would share one digest).
 */
export function sha256Hex(text: string): string {
  const value: unknown = text;
  if (typeof value !== 'string') {
    throw newSpecError(
      'NON_SERIALIZABLE',
      `sha256Hex needs a string, got a value of type ${typeof value}`,
    );
  }
  if (hasLoneSurrogate(value)) {
    throw newSpecError('NON_SERIALIZABLE', 'sha256Hex: a string with a lone UTF-16 surrogate');
  }
  return bytesToHex(sha256(utf8ToBytes(value)));
}
