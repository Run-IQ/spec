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
 * Throws `SpecError` (`INVALID_PROOF`) when the content is not a valid unsigned proof (see
 * `validateProof`), naming the first problem.
 */
export function sealProof(p: UnsignedProof): DecisionProof {
  const [issue] = unsignedProofIssues(p);
  if (issue) throw new SpecError('INVALID_PROOF', `Cannot seal the proof: ${issue.message}`);
  const canonical = canonicalize(proofContent(p));
  // The canonical form of a valid unsigned proof parses back to the same proof, as plain JSON.
  const content = JSON.parse(canonical) as UnsignedProof;
  return { ...content, digest: sha256Hex(canonical) };
}

/** Internal: the digest `p` should carry, computed from its content. */
export function contentDigest(p: UnsignedProof): string {
  return sha256Hex(canonicalize(proofContent(p)));
}

/** A shallow copy of `p` without `digest` and `signature`. */
function proofContent(p: UnsignedProof): Record<string, unknown> {
  const content: Record<string, unknown> = { ...p };
  delete content.digest;
  delete content.signature;
  return content;
}
