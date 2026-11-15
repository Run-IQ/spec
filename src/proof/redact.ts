import { bytesToHex } from '@noble/hashes/utils.js';
import { newSpecError, reasonOf } from '../errors.js';
import { sizedDigest } from '../merkle.js';
import { ordinary, typeName, withValueBudget } from '../values.js';
import { hiddenSections } from './lifts.js';
import type { HiddenSections } from './lifts.js';
import { isRedacted, packedLeafHashes } from './tree.js';
import { PROOF_SECTIONS } from './types.js';
import type { DecisionProof, ProofSection, ProofView, UnsignedProof } from './types.js';
import { readDecisionProof } from './validate.js';
import {
  NativeMap,
  NativeSet,
  arrayConcat,
  arrayForEach,
  arrayMap,
  arrayPush,
  arraySome,
  bare,
  mapSet,
  setAdd,
  setOf,
  setValuesArray,
  uint8ArraySubarray,
} from '../intrinsics.js';

/** Internal: where a proof's redacted entries are, as its checks need to know it. */
export interface Redactions {
  /** The number of redacted entries. */
  count: number;
  /** The sections that have a redacted entry, recording the checks they lift (`isLifted`). */
  hidden: HiddenSections;
  /** The number of redacted entries of each section that has one. */
  bySection: ReadonlyMap<ProofSection, number>;
  /**
   * For each section that has a redacted entry, the place in the section of each entry left:
   * what a message citing the place of an entry of the view (`applied not sorted at 2`) cites.
   */
  positions: ReadonlyMap<ProofSection, readonly number[]>;
}

/** Internal: no redacted entry. */
export const NO_REDACTION: Redactions = {
  count: 0,
  hidden: new NativeSet(),
  bySection: new NativeMap(),
  positions: new NativeMap(),
};

/**
 * Internal: what the consistency checks read of `p` (a validated snapshot): its header and the
 * entries of each section that are not redacted, in order (a section without redacted entry is
 * shared, not copied), and where the redacted ones were.
 */
export function proofView(p: UnsignedProof): { view: ProofView; redactions: Redactions } {
  const view = bare({ ...p }) as unknown as Record<string, unknown>;
  const hidden = new NativeSet<ProofSection>();
  const bySection = new NativeMap<ProofSection, number>();
  const positions = new NativeMap<ProofSection, number[]>();
  let count = 0;
  for (let idx191 = 0, list191 = PROOF_SECTIONS; idx191 < list191.length; idx191++) {
    const section = list191[idx191] as (typeof list191)[number];
    const list: readonly object[] = p[section];
    if (!arraySome(list, isRedacted)) continue;
    const left: object[] = [];
    const places: number[] = [];
    arrayForEach(list, (entry, i) => {
      if (isRedacted(entry)) return;
      arrayPush(left, entry);
      arrayPush(places, i);
    });
    const redacted = list.length - left.length;
    count += redacted;
    setAdd(hidden, section);
    mapSet(bySection, section, redacted);
    mapSet(positions, section, places);
    view[section] = left;
  }
  return {
    view: view as unknown as ProofView,
    redactions: { count, hidden: hiddenSections(bySection), bySection, positions },
  };
}

/**
 * Hides entries of a sealed proof (D-16): returns a copy whose entries for which
 * `hide(section, index)` is `true` (`index` their place in their section) are replaced by
 * `{ redacted: <hex of their leaf> }`. The leaves, hence `digest`, are unchanged: a signature
 * still holds, and `verifyProof` checks the redacted proof against it, reporting
 * `redacted entries: n`. An entry already redacted stays so; `hide` is not called for it. The
 * header is never redacted: it holds nothing that depends on the input (D-16).
 *
 * Only a proof sealed with a secret seed can be redacted (D-14): under `UNSALTED_SEED`, the
 * salts are public and a hidden entry could be found again by trying candidates.
 *
 * `p` is read once (each property read exactly once) into a plain-JSON copy, which is checked and
 * redacted. `hide` is called once per entry not redacted, in the order of the leaves (the
 * sections in the order of `PROOF_SECTIONS`, each in order), and must return a boolean.
 *
 * Throws `SpecError`:
 * - `INVALID_PROOF`, `Cannot redact the proof: <problem>`, when `p` is malformed (see
 *   `validateProof`) or its digest does not match its content;
 * - `INVALID_DISCLOSURE`: `unsalted proof cannot be redacted` (`inputSalted` false), `hide must
 *   be a function`, `hide must return a boolean, got <type> for <section>[<index>]`, `hide
 *   failed for <section>[<index>]: <reason>` (what it threw).
 */
export function redactProof(
  p: DecisionProof,
  hide: (section: ProofSection, index: number) => boolean,
): DecisionProof {
  return withValueBudget(() => {
    const { proof, errors } = readDecisionProof(p);
    if (!proof) throw newSpecError('INVALID_PROOF', `Cannot redact the proof: ${errors[0]}`);
    if (!proof.inputSalted) {
      throw newSpecError('INVALID_DISCLOSURE', 'unsalted proof cannot be redacted');
    }
    if (typeof hide !== 'function') {
      throw newSpecError('INVALID_DISCLOSURE', 'hide must be a function');
    }
    const hashes = packedLeafHashes(proof);
    // The leaves are kept apart: the root is computed in place, over them.
    const leaves = hashes.copyAll();
    const digest = bytesToHex(sizedDigest(proof.format, hashes.length, hashes.root()));
    if (digest !== proof.digest) {
      throw newSpecError(
        'INVALID_PROOF',
        'Cannot redact the proof: its digest does not match its content',
      );
    }
    const chosen: [ProofSection, number, string][] = [];
    let leaf = 1;
    for (let idx192 = 0, list192 = PROOF_SECTIONS; idx192 < list192.length; idx192++) {
      const section = list192[idx192] as (typeof list192)[number];
      arrayForEach(proof[section] as readonly object[], (entry, i) => {
        const at = leaf++;
        if (isRedacted(entry) || !askHide(hide, section, i)) return;
        arrayPush(chosen, [
          section,
          i,
          bytesToHex(uint8ArraySubarray(leaves, at * 32, (at + 1) * 32)),
        ]);
      });
    }
    const copy = bare({ ...proof }) as unknown as Record<ProofSection, object[]>;
    for (
      let idx1073 = 0, list1073 = setValuesArray(setOf(arrayMap(chosen, (entry) => entry[0])));
      idx1073 < list1073.length;
      idx1073++
    ) {
      const section = list1073[idx1073] as (typeof list1073)[number];
      copy[section] = arrayConcat(copy[section]);
    }
    for (let idx1074 = 0, list1074 = chosen; idx1074 < list1074.length; idx1074++) {
      const tuple2001 = list1074[idx1074] as (typeof list1074)[number];
      const section = tuple2001[0];
      const i = tuple2001[1];
      const redacted = tuple2001[2];
      copy[section][i] = { redacted };
    }
    return ordinary(copy) as unknown as DecisionProof;
  });
}

/** What `hide` says of entry `index` of `section`: a boolean, or a thrown `SpecError`. */
function askHide(
  hide: (section: ProofSection, index: number) => boolean,
  section: ProofSection,
  index: number,
): boolean {
  let answer: unknown;
  try {
    answer = hide(section, index);
  } catch (error) {
    throw newSpecError(
      'INVALID_DISCLOSURE',
      `hide failed for ${section}[${index}]: ${reasonOf(error)}`,
    );
  }
  if (typeof answer !== 'boolean') {
    throw newSpecError(
      'INVALID_DISCLOSURE',
      `hide must return a boolean, got ${typeName(answer)} for ${section}[${index}]`,
    );
  }
  return answer;
}
