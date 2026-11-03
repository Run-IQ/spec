import { newSpecError } from '../errors.js';
import {
  NativeMap,
  NativeString,
  arrayIsArray,
  arrayMap,
  arrayPop,
  arrayPush,
  arraySort,
  mapGet,
  mapSet,
  objectEntries,
  stringReplace,
} from '../intrinsics.js';

/**
 * Internal to `@run-iq/spec`: the leaves of a decision input (D-15), walked over a plain copy
 * this package made (`readProofInput`), never over a caller's value: the input tree hashes them
 * (the validator counts the same leaves as it reads, `walkJson`).
 *
 * A leaf is each scalar (`null` included), each list (empty or not: its elements have their own
 * leaves) and each empty object; a non-empty object has no leaf of its own (its descendants
 * imply it). Leaves come in the order of `comparePointers`: decoded segments compared in UTF-16
 * code units, a pointer before its descendants, so list indices compare as texts (`/l/10`
 * before `/l/2`).
 */

/** A JSON scalar: what a leaf of kind `value` holds. */
export type JsonScalar = string | number | boolean | null;

/** What a leaf says, before its salt: its pointer, its kind, and its value or length. */
export type LeafContent =
  | { pointer: string; kind: 'value'; value: JsonScalar }
  | { pointer: string; kind: 'array'; length: number }
  | { pointer: string; kind: 'object' };

/** A key as a JSON pointer segment writes it (RFC 6901): `~` as `~0`, `/` as `~1`. */
function escapeSegment(key: string): string {
  return stringReplace(stringReplace(key, /~/g, '~0'), /\//g, '~1');
}

/** True for a JSON scalar. */
function isScalar(value: unknown): value is JsonScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Refuses a value that is neither a scalar nor a list or an object: never reached on a copy
 * `readProofInput` made, which holds plain JSON only.
 */
function notJson(pointer: string): never {
  throw newSpecError('NON_SERIALIZABLE', `the input copy is not JSON at ${pointer}`);
}

/** The members of a list or an object as `[key, child]`, a list's keys its indices. */
function membersOf(node: object): [string, unknown][] {
  if (arrayIsArray(node)) {
    const list: readonly unknown[] = node;
    return arrayMap(list, (child, i): [string, unknown] => [NativeString(i), child]);
  }
  return objectEntries(node);
}

/** The members of a list or an object, keys sorted in UTF-16 code units. */
function sortedMembers(node: object): [string, unknown][] {
  return arraySort(membersOf(node), ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Calls `visit` with each leaf of `root` (a plain copy, possibly sharing objects between paths:
 * a shared value has its leaves on each path), in the order of `comparePointers`. Iterative: an
 * explicit stack, so no nesting overflows the call stack. Each list or object is sorted once,
 * however many paths lead to it.
 */
export function forEachLeaf(root: unknown, visit: (leaf: LeafContent) => void): void {
  const sorted = new NativeMap<object, [string, unknown][]>();
  const stack: [unknown, string][] = [[root, '']];
  for (let top = arrayPop(stack); top !== undefined; top = arrayPop(stack)) {
    const [value, pointer] = top;
    if (isScalar(value)) {
      visit({ pointer, kind: 'value', value });
      continue;
    }
    if (typeof value !== 'object') notJson(pointer);
    let members = mapGet(sorted, value);
    if (members === undefined) {
      members = sortedMembers(value);
      mapSet(sorted, value, members);
    }
    if (arrayIsArray(value)) visit({ pointer, kind: 'array', length: members.length });
    else if (members.length === 0) {
      visit({ pointer, kind: 'object' });
      continue;
    }
    // Pushed in reverse, so that they are visited in order.
    for (let i = members.length - 1; i >= 0; i--) {
      const member = members[i];
      if (member !== undefined)
        arrayPush(stack, [member[1], `${pointer}/${escapeSegment(member[0])}`]);
    }
  }
}
