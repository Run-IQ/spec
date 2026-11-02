import type { JsonValue } from '../canonical.js';
import type { Instant } from '../time/civil.js';

/**
 * Detached attestations (D-29): a statement about a sealed proof or a key, signed apart from it
 * by someone else than its producer, in the envelope `run-iq.attestation/1`. A reviewer
 * cosigns the digest of a proof it checked; the proof itself keeps its one `signature`.
 * `createAttestation` writes a cosignature (src/attestation/sign.ts), `verifyAttestation`
 * checks one (src/attestation/verify.ts).
 *
 * The envelope is closed, its `kind` open (D-6): a later kind (`timestamp`, `revocation`) is a
 * new value of `kind` in the same format, never a new format. What such a kind needs beyond the
 * members below (a timestamp token, a revocation reason) goes in `claims`, the one member
 * reserved for it: a plain JSON object, covered by the signature. This version verifies
 * `cosignature` alone, which takes no `claims`; any other kind is at best `consistent`, with
 * the issue `attestation kind not supported: <kind>`, its `claims` checked as JSON and signed,
 * never interpreted. Every other member is refused.
 *
 * The signature is ed25519 (RFC 8032) over `utf8(canonicalize(a))`, `a` the attestation without
 * its `signature` (RFC 8785, keys sorted), by the key `keyId` names, in base64url without
 * padding. Its message is a JSON object holding `format`, so it is never the 64 characters of a
 * proof digest that `signProof` signs: a proof's signature never verifies as an attestation,
 * nor one attestation's as another's.
 */

/** The format of a detached attestation (D-6, D-29). */
export const ATTESTATION_FORMAT = 'run-iq.attestation/1';

/**
 * What an attestation is about: a sealed proof, by its digest (`proofDigest`, 64 lowercase hex
 * characters), or a key, by its id (`keyId`, a non-empty string). Exactly one of the two.
 */
export type AttestationSubject = { proofDigest: string } | { keyId: string };

/** A detached attestation, `run-iq.attestation/1`. */
export interface Attestation {
  format: typeof ATTESTATION_FORMAT;
  /**
   * What it attests, an open non-empty string: `cosignature` (its subject a proof digest) is
   * the kind this version verifies.
   */
  kind: string;
  subject: AttestationSubject;
  /** The id of the key that signed it, as `trustedKeys` lists it. */
  keyId: string;
  /** The capacity in which the signer attests (`human-review`), a non-empty string. */
  role?: string;
  /**
   * What a later kind states beyond the members of the envelope: a plain JSON object (strings
   * without lone surrogate, numbers of absolute value below 2^53, at most 1000 levels deep),
   * covered by the signature, read but never interpreted by this version. A `cosignature`
   * takes none.
   */
  claims?: { [key: string]: JsonValue };
  /** When it was signed: an instant in its canonical form (`isInstant`). */
  at: Instant;
  /** The ed25519 signature of its canonical text without `signature`, unpadded base64url. */
  signature: string;
}
