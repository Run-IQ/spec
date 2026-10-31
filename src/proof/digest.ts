import { canonicalize } from '../canonical.js';
import { SpecError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import type { DecisionProof, ProofInput, UnsignedProof } from './types.js';
import { unsignedProofIssues } from './validate.js';

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
 * The copy is plain JSON data, detached from `p`, without `undefined` members. Lists keep
 * their order: the producer sorts them (see `UnsignedProof`).
 *
 * Throws `SpecError` (`INVALID_PROOF`), naming the first problem, when the content is not a
 * valid unsigned proof (see `validateProof`) or is not internally consistent: every rule cited
 * in `applied`, `skipped` and `exceptions` must be listed in `rules`
 * (`cited rule not listed: id@version`).
 */
export function sealProof(p: UnsignedProof): DecisionProof {
  const [issue] = unsignedProofIssues(p);
  if (issue) throw new SpecError('INVALID_PROOF', `Cannot seal the proof: ${issue.message}`);
  const [uncited] = unlistedCitations(p);
  if (uncited) throw new SpecError('INVALID_PROOF', `Cannot seal the proof: ${uncited}`);
  const canonical = canonicalize(proofContent(p));
  // The canonical form of a valid unsigned proof parses back to the same proof, as plain JSON.
  const content = JSON.parse(canonical) as UnsignedProof;
  return { ...content, digest: sha256Hex(canonical) };
}

/** Internal: the digest `p` should carry, computed from its content. */
export function contentDigest(p: UnsignedProof): string {
  return sha256Hex(canonicalize(proofContent(p)));
}

/**
 * Internal: one `cited rule not listed: id@version` issue for each rule cited in `applied`,
 * `skipped` or `exceptions` (in that order, each once) that `rules` does not list.
 */
export function unlistedCitations(p: UnsignedProof): string[] {
  const listed = new Set(p.rules.map((rule) => `${rule.id}@${rule.version}`));
  const issues = new Set<string>();
  for (const cited of [...p.applied, ...p.skipped, ...p.exceptions]) {
    const key = `${cited.ruleId}@${cited.version}`;
    if (!listed.has(key)) issues.add(`cited rule not listed: ${key}`);
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
