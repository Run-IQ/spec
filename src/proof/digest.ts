import { canonicalize } from '../canonical.js';
import { SpecError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import type { DecisionProof, ProofInput, UnsignedProof } from './types.js';
import { readUnsignedProof } from './validate.js';

/**
 * The digest a proof keeps in place of its input: `sha256Hex(canonicalize(input))`. Key order
 * and `undefined` members do not change it. Throws `SpecError` (`NON_SERIALIZABLE`, with the
 * path) for a value that has no JSON form.
 */
export function computeInputDigest(input: ProofInput): string {
  return sha256Hex(canonicalize(input));
}

/**
 * Seals a proof: returns a copy with `digest = sha256Hex(canonicalize(content))`, where the
 * content is every key but `digest` and `signature`. A `digest` or `signature` already on `p`
 * is dropped, so sealing again gives a fresh, unsigned proof.
 *
 * `p` is read once into a plain-JSON copy (each property read exactly once); that copy is what
 * is validated, hashed and returned, detached from `p` and without `undefined` members. Lists
 * keep their order: the producer sorts them (see `UnsignedProof`).
 *
 * Throws `SpecError` (`INVALID_PROOF`), naming the first problem, when the content is not a
 * valid unsigned proof (see `validateProof`) or is not internally consistent (see
 * `unlistedCitations`: `cited rule not listed: ...`).
 */
export function sealProof(p: UnsignedProof): DecisionProof {
  const { proof, errors } = readUnsignedProof(p);
  if (!proof) throw new SpecError('INVALID_PROOF', `Cannot seal the proof: ${errors[0]}`);
  const [uncited] = unlistedCitations(proof);
  if (uncited) throw new SpecError('INVALID_PROOF', `Cannot seal the proof: ${uncited}`);
  return { ...proof, digest: contentDigest(proof) };
}

/**
 * Internal: the digest `p` should carry, computed from its content. `p` must be a plain-JSON
 * snapshot (`readDecisionProof`, `readUnsignedProof`), never a caller's live object.
 */
export function contentDigest(p: UnsignedProof): string {
  return sha256Hex(canonicalize(proofContent(p)));
}

/**
 * Internal: the citations of rules that `p.rules` does not list, each reported once, in this
 * order:
 * - each `ruleId@version` of `applied`, `skipped` and `exceptions`:
 *   `cited rule not listed: id@version`;
 * - each rule id in the `contributors` of `outputs` (by output name) and in the `affected` of
 *   `exceptions`, which name rules by id only: `cited rule not listed: id`.
 */
export function unlistedCitations(p: UnsignedProof): string[] {
  const listed = new Set(p.rules.map((rule) => `${rule.id}@${rule.version}`));
  const listedIds = new Set(p.rules.map((rule) => rule.id));
  const issues = new Set<string>();
  for (const cited of [...p.applied, ...p.skipped, ...p.exceptions]) {
    const key = `${cited.ruleId}@${cited.version}`;
    if (!listed.has(key)) issues.add(`cited rule not listed: ${key}`);
  }
  const outputNames = Object.keys(p.outputs).sort();
  const citedIds = [
    ...outputNames.flatMap((name) => p.outputs[name]?.contributors ?? []),
    ...p.exceptions.flatMap((exception) => exception.affected),
  ];
  for (const id of citedIds) {
    if (!listedIds.has(id)) issues.add(`cited rule not listed: ${id}`);
  }
  return [...issues];
}

/** A shallow copy of `p` without `digest` and `signature`. */
function proofContent(p: UnsignedProof): Record<string, unknown> {
  const content: Record<string, unknown> = { ...p };
  delete content.digest;
  delete content.signature;
  return content;
}
