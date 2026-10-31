import { newSpecError } from '../errors.js';

/**
 * Internal to `@run-iq/spec`: the leaves of a decision input (D-15), walked over a plain copy
 * this package made (`readProofInput`), never over a caller's value. Shared by the validator,
 * which bounds the total length of their pointers, and by the input tree, which hashes them.
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
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** The length of `escapeSegment(key)`, without building it. */
function escapedLength(key: string): number {
  let length = key.length;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code === 0x7e || code === 0x2f) length += 1;
  }
  return length;
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
  if (Array.isArray(node)) {
    const list: readonly unknown[] = node;
    return list.map((child, i): [string, unknown] => [String(i), child]);
  }
  return Object.entries(node);
}

/** The members of a list or an object, keys sorted in UTF-16 code units. */
function sortedMembers(node: object): [string, unknown][] {
  return membersOf(node).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Calls `visit` with each leaf of `root` (a plain copy, possibly sharing objects between paths:
 * a shared value has its leaves on each path), in the order of `comparePointers`. Iterative: an
 * explicit stack, so no nesting overflows the call stack. Each list or object is sorted once,
 * however many paths lead to it.
 */
export function forEachLeaf(root: unknown, visit: (leaf: LeafContent) => void): void {
  const sorted = new Map<object, [string, unknown][]>();
  const stack: [unknown, string][] = [[root, '']];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [value, pointer] = top;
    if (isScalar(value)) {
      visit({ pointer, kind: 'value', value });
      continue;
    }
    if (typeof value !== 'object') notJson(pointer);
    let members = sorted.get(value);
    if (members === undefined) {
      members = sortedMembers(value);
      sorted.set(value, members);
    }
    if (Array.isArray(value)) visit({ pointer, kind: 'array', length: members.length });
    else if (members.length === 0) {
      visit({ pointer, kind: 'object' });
      continue;
    }
    // Pushed in reverse, so that they are visited in order.
    for (let i = members.length - 1; i >= 0; i--) {
      const member = members[i];
      if (member !== undefined) stack.push([member[1], `${pointer}/${escapeSegment(member[0])}`]);
    }
  }
}

/** The leaves below a value, and the code units their pointers hold below it. */
interface Below {
  readonly leaves: number;
  readonly units: number;
}

/**
 * The UTF-16 code units the leaf pointers of `root` hold in all (the sum of their lengths), or
 * `cap + 1` when they hold more. Linear in the size of the copy, whatever the number of paths
 * through shared values: each list or object is summed once (its leaves and the units of their
 * pointers below it), and a path to it adds its own prefix once per leaf, by multiplication.
 * Iterative: an explicit stack.
 */
export function leafPointerText(root: unknown, cap: number): number {
  if (typeof root !== 'object' || root === null) return 0;
  const done = new Map<object, Below>();
  const stack: object[] = [root];
  const below = (child: unknown): Below | undefined =>
    typeof child === 'object' && child !== null ? done.get(child) : { leaves: 1, units: 0 };
  while (stack.length > 0) {
    const node = stack[stack.length - 1];
    if (node === undefined) break;
    if (done.has(node)) {
      stack.pop();
      continue;
    }
    const children = membersOf(node).map(([key, child]): [number, unknown] => [
      escapedLength(key),
      child,
    ]);
    let waiting = false;
    for (const [, child] of children) {
      if (typeof child === 'object' && child !== null && !done.has(child)) {
        stack.push(child);
        waiting = true;
      }
    }
    if (waiting) continue;
    stack.pop();
    let leaves = Array.isArray(node) || children.length === 0 ? 1 : 0;
    let units = 0;
    for (const [segment, child] of children) {
      const sum = below(child) ?? { leaves: 0, units: 0 };
      leaves += sum.leaves;
      // `/` and the segment, once per leaf below the child; capped to stay exact.
      units = Math.min(units + sum.units + sum.leaves * (1 + segment), cap + 1);
    }
    done.set(node, { leaves, units });
  }
  return done.get(root)?.units ?? 0;
}
