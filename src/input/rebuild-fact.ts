import type { JsonValue } from '../canonical.js';
import { citeName } from '../errors.js';
import { parsePointer } from '../path/pointer.js';
import type { JsonPointer } from '../path/pointer.js';
import type { FactCopy } from './read-disclosure.js';
import type { InputLeaf } from './tree.js';
import {
  NativeMap,
  NativeNumber,
  arrayForEach,
  arrayPop,
  arrayPush,
  arraySlice,
  bare,
  defineValue,
  mapEntriesArray,
  mapGet,
  mapHas,
  mapSet,
  mapSize,
} from '../intrinsics.js';

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
  for (let idx197 = 0, list197 = fact.leaves; idx197 < list197.length; idx197++) {
    const { leaf } = list197[idx197] as (typeof list197)[number];
    const node = nodeOf(leaf);
    if (node.kind === 'array') arrayPush(arrays, node);
    const segments = arraySlice(parsePointer(leaf.pointer), depth);
    root ??= segments.length === 0 ? node : { kind: 'object', members: new NativeMap() };
    let parent = root;
    arrayForEach(segments, (segment, i) => {
      const child = i === segments.length - 1 ? node : undefined;
      parent = childOf(parent, segment, child);
    });
  }
  for (let idx198 = 0, list198 = arrays; idx198 < list198.length; idx198++) {
    const list = list198[idx198] as (typeof list198)[number];
    if (mapSize(list.items) === list.length) continue;
    let missing = 0;
    while (mapHas(list.items, missing)) missing += 1;
    return (
      `fact not shown whole: ${citeName(fact.pointer)} ` +
      `(${citeName(list.pointer)} lacks element ${missing})`
    );
  }
  for (let idx1075 = 0, list1075 = arrays; idx1075 < list1075.length; idx1075++) {
    const list = list1075[idx1075] as (typeof list1075)[number];
    lists[list.pointer] = list.length;
  }
  return { value: root === undefined ? null : jsonOf(root) };
}

/** The node of a leaf: its scalar, its list (no element yet), or its empty object. */
function nodeOf(leaf: InputLeaf): Node {
  if (leaf.kind === 'array') {
    return {
      kind: 'array',
      pointer: leaf.pointer,
      length: leaf.length ?? 0,
      items: new NativeMap(),
    };
  }
  if (leaf.kind === 'object') return { kind: 'object', members: new NativeMap() };
  return { kind: 'value', value: leaf.value ?? null };
}

/**
 * The child of `parent` at `segment`: `node` when given (the leaf there), else the one met
 * before or a new object (one implied by the leaves below it). A list's segment is an index
 * below its length, and nothing is below a scalar: the checks before refused the rest.
 */
function childOf(parent: Node, segment: string, node: Node | undefined): Node {
  if (parent.kind === 'value') return parent;
  const make = (): Node => node ?? { kind: 'object', members: new NativeMap() };
  if (parent.kind === 'array') {
    const index = NativeNumber(segment);
    const child = mapGet(parent.items, index) ?? make();
    mapSet(parent.items, index, child);
    return child;
  }
  const child = mapGet(parent.members, segment) ?? make();
  mapSet(parent.members, segment, child);
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
      arrayPush(pending, { kind: 'array', node: child, out });
      return out;
    }
    const out: { [key: string]: JsonValue } = bare({});
    arrayPush(pending, { kind: 'object', node: child, out });
    return out;
  };
  const value = open(node);
  for (let task = arrayPop(pending); task !== undefined; task = arrayPop(pending)) {
    if (task.kind === 'array') {
      for (let k = 0; k < task.node.length; k++) {
        const item = mapGet(task.node.items, k);
        arrayPush(task.out, item === undefined ? null : open(item));
      }
      continue;
    }
    for (
      let idx199 = 0, list199 = mapEntriesArray(task.node.members);
      idx199 < list199.length;
      idx199++
    ) {
      const tuple1076 = list199[idx199] as (typeof list199)[number];
      const key = tuple1076[0];
      const member = tuple1076[1];
      // Plain assignment would turn a `__proto__` key into a prototype change.
      defineValue(task.out, key, open(member), true);
    }
  }
  return value;
}
