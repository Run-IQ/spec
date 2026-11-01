import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { JsonValue } from '../canonical.js';
import { citeName, reasonOf, unreadableMessage } from '../errors.js';
import { boundMessages, IssueList } from '../issues.js';
import { compareSegments, parsePointer } from '../path/pointer.js';
import type { JsonPointer } from '../path/pointer.js';
import { ownCopy, withValueBudget } from '../values.js';
import { isAncestor, isWithin, mayGrow } from './disclosure.js';
import type { FactDisclosureVerification } from './disclosure.js';
import { runCheck } from './read.js';
import { HEX_HASH, readDisclosure } from './read-disclosure.js';
import type {
  AbsenceCopy,
  DisclosureCopy,
  FactCopy,
  LeafCopy,
  NeighbourCopy,
} from './read-disclosure.js';
import { rebuild } from './rebuild-fact.js';
import { committedLeafHash, inputDigestOf, inputLeafHash, verifyInputInclusion } from './tree.js';
import type { InputLeaf } from './tree.js';

/** A list index as an input holds one (`01` names no element). */
const INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * Verifies a fact disclosure (`discloseFacts`) against the input digest `inputDigest`
 * (`computeInputDigest`), and never throws: anything malformed gives `valid: false`. The format
 * and its rules: src/input/disclosure.ts.
 *
 * 1. The shape. `d` is read once (each property read and counted once, as `MAX_JSON_VALUES`
 *    counts them) into a plain copy, and every later check runs on that copy: a closed object
 *    `{ format, inputDigest, size, facts, absent }`; `format` `run-iq.disclosure/1` (another one
 *    gives the single issue `unknown format: <format>`); `inputDigest` 64 lowercase hex
 *    characters; `size` an integer from 0 to 10 000 000; not more facts, nor more leaves in a
 *    fact, than leaves in the tree (checked before any is read); each fact `{ pointer, leaves,
 *    before?, after? }` with at least one leaf; each leaf a closed object whose `index` is below
 *    `size` and whose `path` holds exactly the hashes of the audit path of (`index`, `size`)
 *    (its length checked before any element is read); each neighbour `{ pointer, salt,
 *    commitment, index, path }`; each absence `{ pointer, before?, after? }`.
 * 2. `input digest mismatch` unless `d.inputDigest` is `inputDigest`; `nothing disclosed` for a
 *    disclosure without fact or absence.
 * 3. Each leaf, hashed as `inputLeafHash` hashes it (a neighbour from its pointer, salt and
 *    commitment; a leaf no valid input has is refused: `<path>: invalid input leaf: <why>`),
 *    must be in the tree at its index: `leaf not in tree: <pointer>` otherwise.
 * 4. Facts by increasing pointer, none inside the one before, and absences by increasing
 *    pointer, each once.
 * 5. Each fact must be shown whole (`fact not shown whole: <pointer> (<why>)`): its leaves at
 *    consecutive indices, each at or below its pointer, framed by exactly the neighbours the
 *    format requires. Each absence: `absence not proven: <pointer> (<why>)` unless its
 *    neighbours frame it as the format says; with no neighbour, only the empty tree proves it.
 * 6. What the leaves contradict: `leaves out of order: …`, `leaf inside a scalar: …`, `leaf
 *    inside an empty object: …`, `leaf outside its list: …`, `absent pointer is present: …`,
 *    and a list of a fact missing an element (`fact not shown whole: <pointer> (<list> lacks
 *    element <k>)`). Every conclusion still assumes a tree sorted honestly by its signer
 *    (D-15).
 *
 * The verdict is about the data read during the call: act on the copy it describes (take a JSON
 * copy first, verify it and use it).
 */
export function verifyFactDisclosure(d: unknown, inputDigest: string): FactDisclosureVerification {
  try {
    return withValueBudget(() => verify(d, inputDigest));
  } catch (error) {
    // Never reached by a value read under guard; a last net, still never a throw.
    return refusedWith([unreadableMessage('disclosure', error)]);
  }
}

/** A disclosure refused for `issues`. */
function refusedWith(issues: string[]): FactDisclosureVerification {
  return { valid: false, issues: boundMessages(issues), facts: {}, lists: {}, absent: [] };
}

function verify(d: unknown, inputDigest: unknown): FactDisclosureVerification {
  if (typeof inputDigest !== 'string' || !HEX_HASH.test(inputDigest)) {
    return refusedWith(['the expected input digest must be 64 lowercase hex characters']);
  }
  let copy: DisclosureCopy | undefined;
  let unknownFormat: string | undefined;
  const { issues } = runCheck(
    (reader) => {
      const read = readDisclosure(d, reader);
      if (typeof read === 'string') unknownFormat = read;
      else copy = read;
    },
    (error) => ({ path: '', message: unreadableMessage('disclosure', error) }),
  );
  if (unknownFormat !== undefined) return refusedWith([`unknown format: ${unknownFormat}`]);
  if (issues.length > 0 || copy === undefined) {
    return refusedWith(issues.map((issue) => issue.message));
  }
  const read: DisclosureCopy = copy;
  if (read.inputDigest !== inputDigest) return refusedWith(['input digest mismatch']);
  if (read.facts.length === 0 && read.absent.length === 0) {
    return refusedWith(['nothing disclosed']);
  }
  const problems = new IssueList();
  const verified = checkLeaves(read, inputDigest, problems);
  checkOrder(read, problems);
  checkFacts(read, verified, problems);
  checkAbsences(read, inputDigest, verified, problems);
  checkContradictions([...verified.values()], read.absent, problems);
  const facts: Record<JsonPointer, JsonValue> = {};
  const lists: Record<JsonPointer, number> = {};
  for (const fact of read.facts) {
    if (problems.length > 0) break;
    const value = rebuild(fact, lists);
    // Pointers start with `/` (or are ``): no key of the prototype can be one.
    if (typeof value === 'string') problems.add('', value);
    else facts[fact.pointer] = value.value;
  }
  if (problems.length > 0) return refusedWith(problems.messages());
  return { valid: true, issues: [], facts, lists, absent: read.absent.map((a) => a.pointer) };
}

/** A leaf in the tree: its index, pointer and segments, and its kind when it is shown. */
interface Verified {
  readonly index: number;
  readonly pointer: string;
  readonly segments: string[];
  readonly kind?: InputLeaf['kind'];
  readonly length?: number;
}

/**
 * Lists the problems of the leaves (one a valid input cannot have, one not in the tree), and
 * returns the leaves in the tree by index, each index once (two leaves in the tree at one index
 * have one hash: they are the same leaf; a shown one tells its kind). Every check below stops
 * once `problems` is full.
 */
function checkLeaves(
  copy: DisclosureCopy,
  inputDigest: string,
  problems: IssueList,
): Map<number, Verified> {
  const byIndex = new Map<number, Verified>();
  const keep = (leaf: Verified): void => {
    if (byIndex.get(leaf.index)?.kind === undefined) byIndex.set(leaf.index, leaf);
  };
  for (const fact of copy.facts) {
    for (const leaf of fact.leaves) {
      if (problems.full) break;
      const problem = leafProblem(leaf, copy.size, inputDigest);
      if (problem !== undefined) problems.add('', problem);
      else {
        const { pointer, kind, length } = leaf.leaf;
        const segments = parsePointer(pointer);
        keep({
          index: leaf.index,
          pointer,
          segments,
          kind,
          ...(length !== undefined && { length }),
        });
      }
    }
  }
  const neighbours = [...copy.facts, ...copy.absent].flatMap((entry) => [
    entry.before,
    entry.after,
  ]);
  for (const neighbour of neighbours) {
    if (problems.full) break;
    if (neighbour === undefined) continue;
    const problem = neighbourProblem(neighbour, copy.size, inputDigest);
    if (problem !== undefined) problems.add('', problem);
    else {
      const { index, pointer } = neighbour;
      keep({ index, pointer, segments: parsePointer(pointer) });
    }
  }
  return new Map([...byIndex].sort(([a], [b]) => a - b));
}

/** Why the shown `leaf` is not the leaf at its index of the tree of `inputDigest`. */
function leafProblem(leaf: LeafCopy, size: number, inputDigest: string): string | undefined {
  let hash: Uint8Array;
  try {
    // The copy holds primitives only: hashing it reads no value of the caller.
    hash = ownCopy(() => inputLeafHash(leaf.leaf));
  } catch (error) {
    return `${leaf.at}: ${reasonOf(error)}`;
  }
  return inclusionProblem(leaf.leaf.pointer, hash, leaf, size, inputDigest);
}

/** Why `neighbour` is not the leaf at its index of the tree of `inputDigest`. */
function neighbourProblem(
  neighbour: NeighbourCopy,
  size: number,
  inputDigest: string,
): string | undefined {
  let hash: Uint8Array;
  try {
    const { pointer, salt, commitment } = neighbour;
    hash = committedLeafHash(pointer, hexToBytes(salt), hexToBytes(commitment));
  } catch (error) {
    return `${neighbour.at}: ${reasonOf(error)}`;
  }
  return inclusionProblem(neighbour.pointer, hash, neighbour, size, inputDigest);
}

function inclusionProblem(
  pointer: string,
  hash: Uint8Array,
  place: { index: number; path: readonly string[] },
  size: number,
  inputDigest: string,
): string | undefined {
  const path = place.path.map((hex) => hexToBytes(hex));
  return verifyInputInclusion(inputDigest, size, place.index, hash, path)
    ? undefined
    : `leaf not in tree: ${citeName(pointer)}`;
}

/** Facts and absences by strictly increasing pointer, no fact inside the one before. */
function checkOrder(copy: DisclosureCopy, problems: IssueList): void {
  const ordered = (
    list: readonly { at: string; segments: string[] }[],
    what: string,
    nested: boolean,
  ): void => {
    list.forEach((entry, i) => {
      const previous = list[i - 1];
      if (problems.full || previous === undefined) return;
      if (compareSegments(previous.segments, entry.segments) >= 0) {
        problems.add('', `${entry.at} does not follow ${previous.at}: ${what}`);
      } else if (nested && isAncestor(previous.segments, entry.segments)) {
        problems.add('', `${entry.at} is inside ${previous.at}: a fact is shown whole once`);
      }
    });
  };
  ordered(copy.facts, 'facts are listed by increasing pointer', true);
  ordered(copy.absent, 'absences are listed by increasing pointer', false);
}

/**
 * Lists why each fact whose leaves are all in the tree is not shown whole: its leaves at
 * consecutive indices, at or below its pointer, framed by the neighbours the format requires.
 */
function checkFacts(
  copy: DisclosureCopy,
  verified: ReadonlyMap<number, Verified>,
  problems: IssueList,
): void {
  for (const fact of copy.facts) {
    if (problems.full) return;
    const shown = [...fact.leaves, fact.before, fact.after].every(
      (leaf) => leaf === undefined || verified.has(leaf.index),
    );
    if (!shown) continue;
    const cited = citeName(fact.pointer);
    for (const reason of factReasons(fact, copy.size, verified)) {
      problems.add('', `fact not shown whole: ${cited} (${reason})`);
    }
  }
}

/** Why `fact`, its leaves in the tree, is not shown whole. */
function factReasons(
  fact: FactCopy,
  size: number,
  verified: ReadonlyMap<number, Verified>,
): string[] {
  const reasons: string[] = [];
  const [first] = fact.leaves;
  const last = fact.leaves[fact.leaves.length - 1];
  if (first === undefined || last === undefined) return reasons;
  if (fact.leaves.some((leaf, k) => leaf.index !== first.index + k)) {
    reasons.push('its leaves are not at consecutive indices');
  }
  for (const leaf of fact.leaves) {
    const segments = verified.get(leaf.index)?.segments ?? [];
    if (!isWithin(fact.segments, segments)) {
      reasons.push(`the leaf ${citeName(leaf.leaf.pointer)} is not at or below it`);
    }
  }
  const segmentsOf = (leaf: NeighbourCopy): string[] => verified.get(leaf.index)?.segments ?? [];
  const firstSegments = verified.get(first.index)?.segments ?? [];
  const atPointer = compareSegments(firstSegments, fact.segments) === 0;
  const { before, after } = fact;
  if (atPointer && before !== undefined) reasons.push('the before leaf is not needed');
  else if (!atPointer && before === undefined && first.index > 0) {
    reasons.push('no leaf before it, and its first leaf is not the first of the tree');
  } else if (before !== undefined) {
    if (before.index !== first.index - 1) {
      reasons.push('the before leaf is not just before its first leaf');
    }
    if (compareSegments(segmentsOf(before), fact.segments) >= 0) {
      reasons.push('the before leaf does not come before it');
    }
  }
  const grows = mayGrow(atPointer, first.leaf.kind, first.leaf.length);
  if (!grows && after !== undefined) reasons.push('the after leaf is not needed');
  else if (grows && after === undefined && last.index < size - 1) {
    reasons.push('no leaf after it, and its last leaf is not the last of the tree');
  } else if (after !== undefined) {
    if (after.index !== last.index + 1)
      reasons.push('the after leaf is not just after its last leaf');
    for (const reason of afterReasons(segmentsOf(after), fact.segments)) reasons.push(reason);
  }
  return reasons;
}

/** Why a leaf of these segments does not come after `segments` without being inside them. */
function afterReasons(after: readonly string[], segments: readonly string[]): string[] {
  if (compareSegments(after, segments) <= 0) return ['the after leaf does not come after it'];
  return isAncestor(segments, after) ? ['the after leaf is inside it'] : [];
}

/**
 * Lists why each absence whose neighbours are in the tree does not prove its pointer absent
 * (D-15); an absence with a neighbour not in the tree is already refused for it.
 */
function checkAbsences(
  copy: DisclosureCopy,
  inputDigest: string,
  verified: ReadonlyMap<number, Verified>,
  problems: IssueList,
): void {
  for (const entry of copy.absent) {
    if (problems.full) return;
    const { before, after } = entry;
    const beforeSegments = before && verified.get(before.index)?.segments;
    const afterSegments = after && verified.get(after.index)?.segments;
    if ((before && !beforeSegments) || (after && !afterSegments)) continue;
    const reasons: string[] = [];
    if (beforeSegments && compareSegments(beforeSegments, entry.segments) >= 0) {
      reasons.push('the before leaf does not come before it');
    }
    if (afterSegments) {
      for (const reason of afterReasons(afterSegments, entry.segments)) reasons.push(reason);
    }
    if (before && after) {
      if (after.index !== before.index + 1) {
        reasons.push('the before and after leaves are not adjacent');
      }
    } else if (before) {
      if (before.index !== copy.size - 1) reasons.push('the before leaf is not the last leaf');
    } else if (after) {
      if (after.index !== 0) reasons.push('the after leaf is not the first leaf');
    } else if (copy.size !== 0 || inputDigest !== emptyTreeDigest()) {
      reasons.push('no neighbour leaf, and the tree is not empty');
    }
    const cited = citeName(entry.pointer);
    for (const reason of reasons) problems.add('', `absence not proven: ${cited} (${reason})`);
  }
}

/** The digest of the empty tree: `computeInputDigest` of no leaf (D-15). */
function emptyTreeDigest(): string {
  return bytesToHex(inputDigestOf(0, sha256(new Uint8Array(0))));
}

/** An item of the sweep of `checkContradictions`: an absence or a verified leaf. */
type Item = { absence: AbsenceCopy; leaf?: undefined } | { leaf: Verified; absence?: undefined };

/**
 * Lists what the verified leaves (sorted by index) and the absences contradict. The leaves
 * must come in the order of their indices. Then leaves and absences are swept in pointer order
 * (an absence before a leaf at the same pointer) with the stack of their ancestors: a leaf below
 * an absence, a shown scalar or a shown empty object, an element outside a shown list (its
 * index not below the length of the nearest list above it), or an absence naming an element of
 * a shown list, is refused. Each ancestor test stops at the first differing segment: the work
 * follows the segments swept.
 */
function checkContradictions(
  leaves: readonly Verified[],
  absent: readonly AbsenceCopy[],
  problems: IssueList,
): void {
  leaves.forEach((leaf, i) => {
    const previous = leaves[i - 1];
    if (problems.full || previous === undefined) return;
    if (compareSegments(previous.segments, leaf.segments) >= 0) {
      problems.add(
        '',
        `leaves out of order: ${citeName(previous.pointer)} (leaf ${previous.index}) ` +
          `does not come before ${citeName(leaf.pointer)} (leaf ${leaf.index})`,
      );
    }
  });
  const items: Item[] = [
    ...absent.map((absence) => ({ absence })),
    ...leaves.map((leaf) => ({ leaf })),
  ];
  const segmentsOf = (item: Item): string[] => (item.leaf ?? item.absence).segments;
  // Stable: at the same pointer, an absence stays before a leaf.
  items.sort((a, b) => compareSegments(segmentsOf(a), segmentsOf(b)));
  const stack: Item[] = [];
  const holds = (top: Item, item: Item): boolean => {
    const a = segmentsOf(top);
    const b = segmentsOf(item);
    // An absence holds what is at it too; a leaf only what is strictly below it.
    return top.absence !== undefined ? isWithin(a, b) : isAncestor(a, b);
  };
  for (const item of items) {
    if (problems.full) return;
    let top = stack[stack.length - 1];
    while (top !== undefined && !holds(top, item)) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    const problem = itemProblem(top, item);
    if (problem !== undefined) problems.add('', problem);
    stack.push(item);
  }
}

/** What `item` contradicts in `top`, the nearest item above it, or `undefined`. */
function itemProblem(top: Item | undefined, item: Item): string | undefined {
  if (top === undefined) return undefined;
  if (top.absence !== undefined) {
    return item.leaf === undefined
      ? undefined
      : `absent pointer is present: ${citeName(top.absence.pointer)} ` +
          `(leaf ${citeName(item.leaf.pointer)})`;
  }
  const above = top.leaf;
  if (above === undefined) return undefined;
  const cited = citeName(item.leaf ? item.leaf.pointer : (item.absence?.pointer ?? ''));
  const parent = citeName(above.pointer);
  if (item.leaf !== undefined) {
    if (above.kind === 'value') return `leaf inside a scalar: ${cited} (inside ${parent})`;
    if (above.kind === 'object') {
      return `leaf inside an empty object: ${cited} (inside ${parent})`;
    }
  }
  if (above.kind !== 'array') return undefined;
  const length = above.length ?? 0;
  const segments = item.leaf ? item.leaf.segments : (item.absence?.segments ?? []);
  const segment = segments[above.segments.length] ?? '';
  const element = INDEX.test(segment) && Number(segment) < length;
  if (item.leaf !== undefined && !element) {
    return `leaf outside its list: ${cited} (${parent} has length ${length})`;
  }
  if (item.absence !== undefined && element && segments.length === above.segments.length + 1) {
    return `absent pointer is present: ${cited} (${parent} has length ${length})`;
  }
  return undefined;
}
