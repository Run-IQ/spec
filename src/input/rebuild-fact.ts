import type { JsonValue } from '../canonical.js';
import { citeName } from '../errors.js';
import { parsePointer } from '../path/pointer.js';
import type { JsonPointer } from '../path/pointer.js';
import type { FactCopy } from './read-disclosure.js';
import type { InputLeaf } from './tree.js';

/**
 * Internal to `@run-iq/spec`: the value of a fact of a disclosure, rebuilt from its leaves once
 * `verifyFactDisclosure` (src/input/verify-disclosure.ts) has checked them. Lists are maps of
 * the elements met until the end, and the value is built without recursion.
 */

/** A value being rebuilt: a scalar, a list (its elements by index) or an object. */
type Node =
  | { readonly kind: 'value'; readonly value: JsonValue }
  | {
      readonly kind: 'array';
      readonly pointer: string;
      readonly length: number;
      readonly items: Map<number, Node>;
    }
  | { readonly kind: 'object'; readonly members: Map<string, Node> };

/**
 * The value of `fact` rebuilt from its leaves (sorted, consecutive, at or below its pointer,
 * free of contradictions: all checked before), the length of each of its lists added to
 * `lists`; or why it is not whole: a list lacking an element. Lists are built as maps of the
 * elements met, so a list's length allocates nothing.
 */
export function rebuild(
  fact: FactCopy,
  lists: Record<JsonPointer, number>,
): { value: JsonValue } | string {
  const depth = fact.segments.length;
  const arrays: Extract<Node, { kind: 'array' }>[] = [];
  let root: Node | undefined;
  for (const { leaf } of fact.leaves) {
    const node = nodeOf(leaf);
    if (node.kind === 'array') arrays.push(node);
    const segments = parsePointer(leaf.pointer).slice(depth);
    root ??= segments.length === 0 ? node : { kind: 'object', members: new Map() };
    let parent = root;
    segments.forEach((segment, i) => {
      const child = i === segments.length - 1 ? node : undefined;
      parent = childOf(parent, segment, child);
    });
  }
  for (const list of arrays) {
    if (list.items.size === list.length) continue;
    let missing = 0;
    while (list.items.has(missing)) missing += 1;
    return (
      `fact not shown whole: ${citeName(fact.pointer)} ` +
      `(${citeName(list.pointer)} lacks element ${missing})`
    );
  }
  for (const list of arrays) lists[list.pointer] = list.length;
  return { value: root === undefined ? null : jsonOf(root) };
}

/** The node of a leaf: its scalar, its list (no element yet), or its empty object. */
function nodeOf(leaf: InputLeaf): Node {
  if (leaf.kind === 'array') {
    return { kind: 'array', pointer: leaf.pointer, length: leaf.length ?? 0, items: new Map() };
  }
  if (leaf.kind === 'object') return { kind: 'object', members: new Map() };
  return { kind: 'value', value: leaf.value ?? null };
}

/**
 * The child of `parent` at `segment`: `node` when given (the leaf there), else the one met
 * before or a new object (one implied by the leaves below it). A list's segment is an index
 * below its length, and nothing is below a scalar: the checks before refused the rest.
 */
function childOf(parent: Node, segment: string, node: Node | undefined): Node {
  if (parent.kind === 'value') return parent;
  const make = (): Node => node ?? { kind: 'object', members: new Map() };
  if (parent.kind === 'array') {
    const index = Number(segment);
    const child = parent.items.get(index) ?? make();
    parent.items.set(index, child);
    return child;
  }
  const child = parent.members.get(segment) ?? make();
  parent.members.set(segment, child);
  return child;
}

/** A list or an object of a whole value, and the JSON value it is rebuilt into. */
type Task =
  | { readonly kind: 'array'; readonly node: Extract<Node, { kind: 'array' }>; out: JsonValue[] }
  | {
      readonly kind: 'object';
      readonly node: Extract<Node, { kind: 'object' }>;
      out: { [key: string]: JsonValue };
    };

/**
 * The JSON value of a whole `node`, built without recursion: each list or object is made empty
 * when its parent is filled, in its parent's order, and filled when its task comes off the stack.
 */
function jsonOf(node: Node): JsonValue {
  const pending: Task[] = [];
  const open = (child: Node): JsonValue => {
    if (child.kind === 'value') return child.value;
    if (child.kind === 'array') {
      const out: JsonValue[] = [];
      pending.push({ kind: 'array', node: child, out });
      return out;
    }
    const out: { [key: string]: JsonValue } = {};
    pending.push({ kind: 'object', node: child, out });
    return out;
  };
  const value = open(node);
  for (let task = pending.pop(); task !== undefined; task = pending.pop()) {
    if (task.kind === 'array') {
      for (let k = 0; k < task.node.length; k++) {
        const item = task.node.items.get(k);
        task.out.push(item === undefined ? null : open(item));
      }
      continue;
    }
    for (const [key, member] of task.node.members) {
      // Plain assignment would turn a `__proto__` key into a prototype change.
      Object.defineProperty(task.out, key, {
        value: open(member),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return value;
}
