import { bytesToHex } from '@noble/hashes/utils.js';
import { citeName, isOwnError, newSpecError, unreadableMessage } from '../errors.js';
import { PackedHashes } from '../merkle.js';
import { compareSegments, parsePointer } from '../path/pointer.js';
import type { JsonPointer } from '../path/pointer.js';
import { ownCopy, readList, typeName, withValueBudget } from '../values.js';
import { DISCLOSURE_FORMAT, isAncestor, isWithin, mayGrow } from './disclosure.js';
import type {
  AbsenceProof,
  DisclosedFact,
  DisclosedLeaf,
  FactDisclosure,
  NeighbourLeaf,
} from './disclosure.js';
import { forEachLeaf } from './leaves.js';
import type { LeafContent } from './leaves.js';
import { inputSalter, readSeed } from './seed.js';
import { createLeafHasher, inputDigestOf } from './tree.js';
import type { ProofInput } from './types.js';
import { readValidInput } from './validate.js';

/**
 * The disclosure of the facts of `input` at the pointers `present`, and the proofs that the
 * pointers `absent` are absent from it, under `seed` (D-14, D-15; the format and its rules:
 * src/input/disclosure.ts).
 *
 * `seed` is checked first (`INVALID_KEY` unless a `Uint8Array` of 32 bytes); a seed of 32 zero
 * bytes (`UNSALTED_SEED`, compared by its bytes) is refused (`INVALID_DISCLOSURE`, `unsalted
 * input cannot be disclosed`): its salts are public, so a hidden neighbour would be found by
 * guessing. Then the requests are read once (`INVALID_DISCLOSURE`: `present must be an array of
 * JSON pointers`, `<list> could not be read: <reason>`, `<list> is too large: …`; `INVALID_PATH`
 * for an invalid pointer; `pointer requested twice: <p>` for a pointer listed twice, in either
 * list; `nothing to disclose`), then `input`, read once and checked as `validateProofInput`
 * checks it (`INVALID_INPUT`). A present pointer must name a value of the input (`pointer is
 * absent: <p>`), not inside another present one (`pointer inside another requested pointer:
 * <p> (inside <q>)`): the value is shown whole, every leaf at or below it (a list with its
 * elements, an object with its members). An absent pointer must be absent (`pointer is present:
 * <p>`); it may be inside a present one.
 *
 * The tree is hashed once, as `computeInputDigest` hashes it, and every audit path comes out of
 * the same pass: the work is that of the digest. Facts and absences come by increasing pointer,
 * whatever the order of the requests.
 */
export function discloseFacts(
  input: ProofInput,
  seed: Uint8Array,
  present: readonly JsonPointer[],
  absent: readonly JsonPointer[],
): FactDisclosure {
  return withValueBudget(() => {
    const seedBytes = readSeed(seed);
    if (seedBytes.every((byte) => byte === 0)) {
      throw newSpecError('INVALID_DISCLOSURE', 'unsalted input cannot be disclosed');
    }
    const requests = readRequests(present, absent);
    const snapshot = readValidInput(input);
    const walked = ownCopy(() => walkLeaves(snapshot, seedBytes, requests));
    return buildDisclosure(requests, walked);
  });
}

/** One request: a pointer, its decoded segments, and whether it is to be shown or disproven. */
interface Request {
  readonly pointer: string;
  readonly segments: string[];
  readonly present: boolean;
}

/** A leaf met during the walk, with its index, its segments, its salts and its commitment. */
interface Seen {
  readonly content: LeafContent;
  readonly segments: string[];
  readonly index: number;
  readonly salt: string;
  readonly valueSalt: string;
  readonly commitment: string;
}

/** What the walk finds for a request: the leaves at or below it, and those around them. */
interface Found {
  readonly leaves: Seen[];
  before?: Seen;
  after?: Seen;
}

/** The requests of both lists, sorted by `comparePointers`, each pointer once. */
function readRequests(present: readonly string[], absent: readonly string[]): Request[] {
  const requests = [
    ...readPointers(present, 'present').map((p) => ({ ...p, present: true })),
    ...readPointers(absent, 'absent').map((p) => ({ ...p, present: false })),
  ];
  if (requests.length === 0) throw newSpecError('INVALID_DISCLOSURE', 'nothing to disclose');
  requests.sort((a, b) => compareSegments(a.segments, b.segments));
  requests.forEach((request, i) => {
    const previous = requests[i - 1];
    if (previous !== undefined && compareSegments(previous.segments, request.segments) === 0) {
      throw newSpecError(
        'INVALID_DISCLOSURE',
        `pointer requested twice: ${citeName(request.pointer)}`,
      );
    }
  });
  return requests;
}

/** The pointers of the caller's list `name`, read once, each parsed (`INVALID_PATH`). */
function readPointers(
  list: readonly string[],
  name: string,
): { pointer: string; segments: string[] }[] {
  let items: unknown[];
  try {
    if (!Array.isArray(list)) {
      throw newSpecError('INVALID_DISCLOSURE', `${name} must be an array of JSON pointers`);
    }
    const read = readList(list, name);
    if (!Array.isArray(read)) throw newSpecError('INVALID_DISCLOSURE', read.message);
    items = read;
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw newSpecError('INVALID_DISCLOSURE', unreadableMessage(name, error));
  }
  return items.map((pointer) => {
    if (typeof pointer !== 'string') {
      // As `parsePointer` refuses it; `typeName` runs no caller code.
      throw newSpecError(
        'INVALID_PATH',
        `a JSON pointer must be a string, got ${typeName(pointer)}`,
      );
    }
    return { pointer, segments: parsePointer(pointer) };
  });
}

/**
 * Walks the leaves of `snapshot` (a copy this package made) in their order, hashing each as
 * `computeInputDigest` does into one packed buffer, and finds what each request (sorted) needs
 * by merging: a request falls before the first leaf that does not come before it; it then
 * collects every leaf at or below it (the requests open at a leaf nest, a stack), and the first
 * leaf past them is after it. Only the leaves a request needs are kept: the salts and the
 * commitment of the previous leaf wait in fixed buffers until the next leaf is met.
 */
function walkLeaves(
  snapshot: ProofInput,
  seed: Uint8Array,
  requests: readonly Request[],
): { hashes: PackedHashes; found: Found[] } {
  const salter = inputSalter(seed, 'input:');
  const valueSalter = inputSalter(seed, 'value:');
  const hasher = createLeafHasher();
  const hashes = new PackedHashes();
  const found: Found[] = requests.map(() => ({ leaves: [] }));
  const open: number[] = [];
  let next = 0;
  let previous: { content: LeafContent; segments: string[]; index: number } | undefined;
  let previousSeen: Seen | undefined;
  const previousBytes = new Uint8Array(96);
  const seenBefore = (): Seen | undefined => {
    if (previous !== undefined && previousSeen === undefined) {
      previousSeen = {
        ...previous,
        salt: bytesToHex(previousBytes.subarray(0, 32)),
        valueSalt: bytesToHex(previousBytes.subarray(32, 64)),
        commitment: bytesToHex(previousBytes.subarray(64)),
      };
    }
    return previousSeen;
  };
  forEachLeaf(snapshot, (leaf) => {
    const index = hashes.length;
    const salt = salter(leaf.pointer);
    const valueSalt = valueSalter(leaf.pointer);
    hasher.hash(hashes.next(), leaf, salt, valueSalt);
    hashes.push();
    if (next >= requests.length && open.length === 0) return;
    const segments = parsePointer(leaf.pointer);
    let here: Seen | undefined;
    const seen = (): Seen =>
      (here ??= {
        content: leaf,
        segments,
        index,
        salt: bytesToHex(salt),
        valueSalt: bytesToHex(valueSalt),
        commitment: bytesToHex(hasher.commitment),
      });
    for (let top = open.at(-1); top !== undefined; top = open.at(-1)) {
      const request = requests[top];
      if (request === undefined || isWithin(request.segments, segments)) break;
      setAfter(found[top], seen());
      open.pop();
    }
    for (let request = requests[next]; request !== undefined; request = requests[next]) {
      if (compareSegments(request.segments, segments) > 0) break;
      const entry = found[next];
      const before = seenBefore();
      if (entry !== undefined && before !== undefined) entry.before = before;
      if (isWithin(request.segments, segments)) open.push(next);
      else setAfter(entry, seen());
      next += 1;
    }
    for (const k of open) found[k]?.leaves.push(seen());
    previous = { content: leaf, segments, index };
    previousSeen = here;
    previousBytes.set(salt, 0);
    previousBytes.set(valueSalt, 32);
    previousBytes.set(hasher.commitment, 64);
  });
  // The requests after the last leaf: that leaf is before them.
  for (; next < requests.length; next++) {
    const entry = found[next];
    const before = seenBefore();
    if (entry !== undefined && before !== undefined) entry.before = before;
  }
  return { hashes, found };
}

function setAfter(entry: Found | undefined, after: Seen): void {
  if (entry !== undefined) entry.after = after;
}

/**
 * The disclosure of the requests from what the walk `found`: a fact for each present pointer,
 * a proof for each absent one, every audit path computed in the same pass as the root.
 */
function buildDisclosure(
  requests: readonly Request[],
  walked: { hashes: PackedHashes; found: Found[] },
): FactDisclosure {
  const { hashes, found } = walked;
  const facts: { pointer: string; leaves: Seen[]; before?: Seen; after?: Seen }[] = [];
  const absences: { pointer: string; before?: Seen; after?: Seen }[] = [];
  let shownAbove: Request | undefined;
  requests.forEach((request, i) => {
    const { leaves, before, after } = found[i] ?? { leaves: [] };
    const cited = citeName(request.pointer);
    const [first] = leaves;
    if (!request.present) {
      if (first !== undefined) {
        throw newSpecError('INVALID_DISCLOSURE', `pointer is present: ${cited}`);
      }
      absences.push({
        pointer: request.pointer,
        ...(before && { before }),
        ...(after && { after }),
      });
      return;
    }
    if (shownAbove !== undefined && isAncestor(shownAbove.segments, request.segments)) {
      throw newSpecError(
        'INVALID_DISCLOSURE',
        `pointer inside another requested pointer: ${cited} ` +
          `(inside ${citeName(shownAbove.pointer)})`,
      );
    }
    if (first === undefined)
      throw newSpecError('INVALID_DISCLOSURE', `pointer is absent: ${cited}`);
    shownAbove = request;
    const atPointer = first.segments.length === request.segments.length;
    const { content } = first;
    const length = content.kind === 'array' ? content.length : undefined;
    facts.push({
      pointer: request.pointer,
      leaves,
      ...(!atPointer && before && { before }),
      ...(mayGrow(atPointer, content.kind, length) && after && { after }),
    });
  });
  const shown = [
    ...facts.flatMap((fact) => [...fact.leaves, fact.before, fact.after]),
    ...absences.flatMap((absence) => [absence.before, absence.after]),
  ];
  const indices = [...new Set(shown.flatMap((seen) => (seen ? [seen.index] : [])))];
  const size = hashes.length;
  const { paths, root } = hashes.pathsAndRoot(indices);
  const pathOf = new Map(indices.map((index, k) => [index, (paths[k] ?? []).map(bytesToHex)]));
  const path = (seen: Seen): string[] => [...(pathOf.get(seen.index) ?? [])];
  const disclosed = (seen: Seen): DisclosedLeaf => ({
    ...seen.content,
    salt: seen.salt,
    valueSalt: seen.valueSalt,
    index: seen.index,
    path: path(seen),
  });
  const neighbour = (seen: Seen): NeighbourLeaf => ({
    pointer: seen.content.pointer,
    salt: seen.salt,
    commitment: seen.commitment,
    index: seen.index,
    path: path(seen),
  });
  const framed = (entry: {
    before?: Seen;
    after?: Seen;
  }): Pick<AbsenceProof, 'before' | 'after'> => ({
    ...(entry.before && { before: neighbour(entry.before) }),
    ...(entry.after && { after: neighbour(entry.after) }),
  });
  return {
    format: DISCLOSURE_FORMAT,
    inputDigest: bytesToHex(inputDigestOf(size, root)),
    size,
    facts: facts.map((fact): DisclosedFact => ({
      pointer: fact.pointer,
      leaves: fact.leaves.map(disclosed),
      ...framed(fact),
    })),
    absent: absences.map((absence): AbsenceProof => ({
      pointer: absence.pointer,
      ...framed(absence),
    })),
  };
}
