import { citeName, isOwnOptionsError, newOptionsError, unreadableMessage } from '../errors.js';
import { publicKeyBytes } from './sign.js';
import {
  budgetExhausted,
  isPlainObject,
  optionsLimits,
  spendValues,
  tooLargeMessage,
} from '../values.js';
import {
  NativeMap,
  arrayPush,
  mapSet,
  objectGetOwnPropertyDescriptor,
  reflectOwnKeys,
  symbolToString,
} from '../intrinsics.js';

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
  required = false,
): Map<string, Uint8Array> {
  const keys = new NativeMap<string, Uint8Array>();
  if (trustedKeys === undefined) {
    // Optional for `verifyProof`; `verifyAttestation` needs them (`{}` trusts no key).
    if (required)
      fail(option, `${option} is required: an object of hex public keys ({} trusts none)`);
    return keys;
  }
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
    const all = reflectOwnKeys(record);
    // Every key counts against the options budget, the keys of a huge object included.
    if (!spendValues(all.length)) fail(option, tooLargeMessage(option));
    for (const key of all) {
      if (typeof key === 'symbol') {
        const path = citeName(`${option}.${symbolToString(key)}`);
        return fail(path, `${path} is not a key id: a symbol`);
      }
      if (objectGetOwnPropertyDescriptor(record, key)?.enumerable !== true) {
        const path = citeName(`${option}.${key}`);
        return fail(path, `${path} is not enumerable: it would not be read`);
      }
      arrayPush(ids, key);
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
    mapSet(keys, id, bytes);
  }
  return keys;
}

/**
 * Internal: the function that raises a mistake of the caller about its options for a call
 * (`root` names all of them in the message of the bound: `options`, `trustedKeys`). A read refused
 * for its size is the options bound, which the message names with the place it was met, never
 * the fault of the value that happened to be read last.
 */
export function optionsFailure(root: string): (option: string, message: string) => never {
  return (option, message) => {
    if (budgetExhausted()) {
      throw newOptionsError(
        root,
        `${root} are too large: more than ${optionsLimits.nodes} values (at ${option})`,
      );
    }
    throw newOptionsError(option, message);
  };
}
