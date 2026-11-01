import type { JsonValue } from '../canonical.js';
import type { JsonPointer } from '../path/pointer.js';
import type { InputLeaf } from './tree.js';

/**
 * Selective disclosure of the facts of a decision input, and proofs of absence (D-14, D-15):
 * the format `run-iq.disclosure/1`, frozen with `run-iq.proof/1`. `discloseFacts` writes one
 * (src/input/disclose.ts), `verifyFactDisclosure` checks one (src/input/verify-disclosure.ts);
 * both rest on the types and rules below.
 *
 * A disclosure shows leaves of the salted input tree, each with its index and its audit path,
 * and is checked against the input digest alone (`computeInputDigest`), which commits to the
 * leaf count: a leaf is in the tree, at its place, in a tree of that size
 * (`verifyInputInclusion`). The leaves are sorted by `comparePointers`, the descendants of a
 * pointer right after it, so:
 * - a fact (a present pointer) is shown whole: every leaf at or below it, at consecutive
 *   indices, framed by the leaf before (unless the first leaf is the pointer's own, or the
 *   first of the tree) and the leaf after (unless the fact is a scalar, an empty object or an
 *   empty list, or its last leaf is the last of the tree), neither inside it;
 * - a pointer is absent when the two adjacent leaves around it frame it, the second not inside
 *   it; before the first leaf, the first leaf alone proves it (index 0), after the last leaf the
 *   last one alone (its index is the size less one, and the size is committed); in the empty
 *   tree, none.
 *
 * A framing leaf is a neighbour (`NeighbourLeaf`): its pointer, its `salt` and the commitment
 * `C` to its content. Its kind, its value and its `valueSalt` are never shown. Its pointer is:
 * a key of the input can be learnt from a proof about another one, so an input whose keys are
 * themselves private should use opaque keys (ids, not names).
 *
 * Every conclusion holds only if the signer sorted the tree honestly: a tree is not checked to
 * be sorted by its digest, and only a replay with the input checks it (D-15). What the shown
 * leaves themselves contradict (leaves out of order, a leaf below a scalar or an empty object,
 * an element outside its list, a list missing an element, an absence one of them shows
 * present) is refused.
 */

/** The format of a fact disclosure (D-6). */
export const DISCLOSURE_FORMAT = 'run-iq.disclosure/1';

/**
 * A shown leaf of the input tree: the leaf (`InputLeaf`: pointer, kind, value or length, salt,
 * valueSalt), its `index` among the leaves sorted by `comparePointers`, and its RFC 6962 audit
 * path (`path`, lowercase hex, from the bottom of the tree up).
 */
export interface DisclosedLeaf extends InputLeaf {
  index: number;
  path: string[];
}

/**
 * A leaf shown without its content: its `pointer`, its `salt` and its `commitment` (`C`, D-15,
 * lowercase hex), with its `index` and its audit `path`. Its kind and value stay hidden.
 */
export interface NeighbourLeaf {
  pointer: JsonPointer;
  salt: string;
  commitment: string;
  index: number;
  path: string[];
}

/**
 * A fact: the value at `pointer`, shown whole by its `leaves` (every leaf at or below it, by
 * increasing index), with the neighbours that frame them (`before`, `after`; see the rules
 * above).
 */
export interface DisclosedFact {
  pointer: JsonPointer;
  leaves: DisclosedLeaf[];
  before?: NeighbourLeaf;
  after?: NeighbourLeaf;
}

/**
 * The proof that `pointer` is absent from the input: the leaf just before it (`before`) and
 * the leaf just after it (`after`, not inside it), or one of them alone (before the first leaf:
 * `after` at index 0; after the last leaf: `before` at index `size - 1`); neither only in the
 * empty tree.
 */
export interface AbsenceProof {
  pointer: JsonPointer;
  before?: NeighbourLeaf;
  after?: NeighbourLeaf;
}

/**
 * A fact disclosure (`run-iq.disclosure/1`): the input digest it is checked against, the leaf
 * count that digest commits to (`size`), the facts (`facts`, by increasing pointer, none inside
 * another) and the proven absences (`absent`, by increasing pointer). The seed, the salts of a
 * leaf not shown, and the `valueSalt` and content of a neighbour are never in it.
 */
export interface FactDisclosure {
  format: typeof DISCLOSURE_FORMAT;
  inputDigest: string;
  size: number;
  facts: DisclosedFact[];
  absent: AbsenceProof[];
}

/**
 * What `verifyFactDisclosure` concludes. When `valid`, `facts` holds the value at each fact's
 * pointer, rebuilt from its leaves (a scalar, a list, an object), `lists` the length of every
 * list in them, and `absent` each pointer proven absent; otherwise all three are empty and
 * `issues` says why (at most 100 problems, then `further problems not listed (limit 100)`).
 */
export interface FactDisclosureVerification {
  valid: boolean;
  issues: string[];
  facts: Record<JsonPointer, JsonValue>;
  lists: Record<JsonPointer, number>;
  absent: JsonPointer[];
}

/** Internal: true when `a` is `b` or one of its ancestors: a prefix of its segments. */
export function isWithin(a: readonly string[], b: readonly string[]): boolean {
  return a.length <= b.length && a.every((segment, i) => segment === b[i]);
}

/** Internal: true when `a` is a strict ancestor of `b`: a proper prefix of its segments. */
export function isAncestor(a: readonly string[], b: readonly string[]): boolean {
  return a.length < b.length && isWithin(a, b);
}

/**
 * Internal: true when a fact may hold leaves after its first one (D-15), so that its last leaf
 * needs a neighbour after it: unless that first leaf is at the fact's pointer (`atPointer`) and
 * holds nothing below it (a scalar, an empty object, an empty list). A fact needs a neighbour
 * before it when its first leaf is not at its pointer.
 */
export function mayGrow(atPointer: boolean, kind: string, length: number | undefined): boolean {
  return !atPointer || (kind === 'array' && length !== 0);
}
