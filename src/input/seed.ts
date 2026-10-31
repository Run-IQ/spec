import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { newSpecError } from '../errors.js';
import { hashWork } from '../merkle.js';
import { Utf8Writer } from '../utf8.js';
import { bytesOf, hasLoneSurrogate, loneSurrogateMessage, typeName } from '../values.js';

/** The bytes of a seed (D-14). */
const SEED_BYTES = 32;
/** The fewest bytes of an input secret (D-14). */
const MIN_SECRET_BYTES = 32;
/** The HKDF salt of the input seed (D-14): one domain for every Run-IQ input seed. */
const SEED_SALT = utf8ToBytes('run-iq.input-seed/1');

/**
 * The seed of an input without a secret: 32 zero bytes (D-14). Its salts are HMACs under a
 * known key, so anyone can recompute them: a digest under `UNSALTED_SEED` hides nothing, and
 * a proof says so (`inputSalted: false`).
 *
 * A `Uint8Array` cannot be frozen: never write to this one. The functions of this package
 * read the bytes of the seed they are given, and decide nothing from the identity of this
 * object.
 */
export const UNSALTED_SEED: Uint8Array = new Uint8Array(SEED_BYTES);

/**
 * The seed of the input of the request `requestId` (D-14):
 * `HKDF-SHA256(ikm = secret, salt = utf8('run-iq.input-seed/1'), info = utf8(requestId))`,
 * 32 bytes, a fresh array. One secret gives every request its own seed, and the salts of its
 * input leaves follow from that seed (`inputLeaves`). The secret and the seed are never written
 * in a proof, a result or a log: whoever holds the seed can test guesses of hidden facts.
 *
 * `secret` is a `Uint8Array` (of any realm; a `Buffer` is one) of at least 32 bytes, copied at
 * the call; `requestId` is the request's non-empty id. Throws `SpecError` (`INVALID_KEY`)
 * otherwise: `the input secret must be a Uint8Array of at least 32 bytes, got <n> bytes` (or
 * `got a value of type <type>`), `requestId must be a non-empty string`, `requestId contains a
 * lone UTF-16 surrogate` (it has no UTF-8 form).
 */
export function deriveInputSeed(secret: Uint8Array, requestId: string): Uint8Array {
  const key = bytesOf(secret);
  if (key === undefined || key.length < MIN_SECRET_BYTES) {
    throw newSpecError(
      'INVALID_KEY',
      `the input secret must be a Uint8Array of at least ${MIN_SECRET_BYTES} bytes, ` +
        `${got(secret, key)}`,
    );
  }
  const id: unknown = requestId;
  if (typeof id !== 'string' || id === '') {
    throw newSpecError('INVALID_KEY', 'requestId must be a non-empty string');
  }
  if (hasLoneSurrogate(id)) throw newSpecError('INVALID_KEY', loneSurrogateMessage('requestId'));
  return hkdf(sha256, key, SEED_SALT, utf8ToBytes(id), SEED_BYTES);
}

/**
 * Internal: a copy of `seed` when it is a `Uint8Array` of exactly 32 bytes; otherwise throws
 * `SpecError` (`INVALID_KEY`, `the input seed must be a Uint8Array of 32 bytes, got <n> bytes`
 * or `got a value of type <type>`).
 */
export function readSeed(seed: Uint8Array): Uint8Array {
  const bytes = bytesOf(seed);
  if (bytes === undefined || bytes.length !== SEED_BYTES) {
    throw newSpecError(
      'INVALID_KEY',
      `the input seed must be a Uint8Array of ${SEED_BYTES} bytes, ${got(seed, bytes)}`,
    );
  }
  return bytes;
}

/**
 * Internal: the salt of each input leaf under `seed` (a copy this package owns), D-14:
 * `HMAC-SHA256(seed, utf8('input:' + pointer))`, 32 bytes. The keyed state is built once and
 * cloned for each pointer; each salt is written into the same 32-byte array, returned by every
 * call: use it before the next call.
 */
export function inputSalter(seed: Uint8Array): (pointer: string) => Uint8Array {
  const keyed = hmac.create(sha256, seed);
  const work = keyed.clone();
  const salt = new Uint8Array(SEED_BYTES);
  const writer = new Utf8Writer();
  return (pointer) => {
    keyed._cloneInto(work);
    const message = writer.encode(`input:${pointer}`);
    hashWork.calls += 1;
    hashWork.bytes += message.length;
    work.update(message);
    work.digestInto(salt);
    return salt;
  };
}

/** How a message describes what was given instead of bytes. */
function got(value: unknown, bytes: Uint8Array | undefined): string {
  return bytes === undefined
    ? `got a value of type ${typeName(value)}`
    : `got ${bytes.length} bytes`;
}
