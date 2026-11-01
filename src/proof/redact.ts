import { bytesToHex } from '@noble/hashes/utils.js';
import { newSpecError, reasonOf } from '../errors.js';
import { sizedDigest } from '../merkle.js';
import { typeName, withValueBudget } from '../values.js';
import { isRedacted, packedLeafHashes } from './tree.js';
import { PROOF_SECTIONS } from './types.js';
import type { DecisionProof, ProofSection, ProofView, UnsignedProof } from './types.js';
import { readDecisionProof } from './validate.js';

/** Internal: where a proof's redacted entries are, as its checks need to know it. */
export interface Redactions {
  /** The number of redacted entries. */
  count: number;
  /** The sections that have a redacted entry. */
  hidden: ReadonlySet<ProofSection>;
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
  hidden: new Set(),
  bySection: new Map(),
  positions: new Map(),
};

/**
 * Internal: what the consistency checks read of `p` (a validated snapshot): its header and the
 * entries of each section that are not redacted, in order (a section without redacted entry is
 * shared, not copied), and where the redacted ones were.
 */
export function proofView(p: UnsignedProof): { view: ProofView; redactions: Redactions } {
  const view = { ...p } as unknown as Record<string, unknown>;
  const hidden = new Set<ProofSection>();
  const bySection = new Map<ProofSection, number>();
  const positions = new Map<ProofSection, number[]>();
  let count = 0;
  for (const section of PROOF_SECTIONS) {
    const list: readonly object[] = p[section];
    if (!list.some(isRedacted)) continue;
    const left: object[] = [];
    const places: number[] = [];
    list.forEach((entry, i) => {
      if (isRedacted(entry)) return;
      left.push(entry);
      places.push(i);
    });
    const redacted = list.length - left.length;
    count += redacted;
    hidden.add(section);
    bySection.set(section, redacted);
    positions.set(section, places);
    view[section] = left;
  }
  return {
    view: view as unknown as ProofView,
    redactions: { count, hidden, bySection, positions },
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
    for (const section of PROOF_SECTIONS) {
      proof[section].forEach((entry, i) => {
        const at = leaf++;
        if (isRedacted(entry) || !askHide(hide, section, i)) return;
        chosen.push([section, i, bytesToHex(leaves.subarray(at * 32, (at + 1) * 32))]);
      });
    }
    const copy = { ...proof } as unknown as Record<ProofSection, object[]>;
    for (const section of new Set(chosen.map(([section]) => section))) {
      copy[section] = [...copy[section]];
    }
    for (const [section, i, redacted] of chosen) copy[section][i] = { redacted };
    return copy as unknown as DecisionProof;
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
