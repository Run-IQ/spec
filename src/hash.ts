import { bytesToHex } from '@noble/hashes/utils.js';
import { newSpecError } from './errors.js';
import { withSha256 } from './stream.js';
import { hasLoneSurrogate } from './values.js';

/**
 * Lowercase hex sha256 of a UTF-8 string, encoded piece by piece (no copy of the text is made).
 * Pure JavaScript: runs in Node, browsers and workers.
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
  return bytesToHex(withSha256((stream) => stream.text(value)));
}
