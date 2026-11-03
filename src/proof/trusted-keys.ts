import { citeName, isOwnOptionsError, unreadableMessage } from '../errors.js';
import { publicKeyBytes } from './sign.js';
import { isPlainObject } from '../values.js';

// Internal to `@run-iq/spec`: the `trustedKeys` of `verifyProof` and `verifyAttestation`.

/**
 * The keys of `trustedKeys` (`option` names them in an error), each read once. Every fault is the
 * caller's and goes to `fail`: not an object, an `ownKeys` or a getter that throws, a symbol or
 * non-enumerable key, a key that is malformed.
 */
export function readTrustedKeys(
  trustedKeys: unknown,
  option: string,
  fail: (option: string, message: string) => never,
): Map<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>();
  if (trustedKeys === undefined) return keys;
  let record: Record<string, unknown> | undefined;
  try {
    record = isPlainObject(trustedKeys) ? trustedKeys : undefined;
  } catch (error) {
    return fail(option, unreadableMessage(option, error));
  }
  if (record === undefined) {
    return fail(option, `${option} must be an object of hex public keys`);
  }
  // Every own key is the caller's: a symbol or a non-enumerable key is a key that would be
  // ignored, which is refused, and an `ownKeys` that throws is never "no keys".
  const ids: string[] = [];
  try {
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key === 'symbol') {
        const path = citeName(`${option}.${key.toString()}`);
        return fail(path, `${path} is not a key id: a symbol`);
      }
      if (Object.getOwnPropertyDescriptor(record, key)?.enumerable !== true) {
        const path = citeName(`${option}.${key}`);
        return fail(path, `${path} is not enumerable: it would not be read`);
      }
      ids.push(key);
    }
  } catch (error) {
    if (isOwnOptionsError(error)) throw error;
    return fail(option, unreadableMessage(option, error));
  }
  for (const id of ids) {
    const path = citeName(`${option}.${id}`);
    let value: unknown;
    try {
      value = record[id];
    } catch (error) {
      return fail(path, unreadableMessage(path, error));
    }
    const bytes = publicKeyBytes(value);
    if (!bytes) return fail(path, `${path} is malformed`);
    keys.set(id, bytes);
  }
  return keys;
}
