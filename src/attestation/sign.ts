import { newSpecError, reasonOf, unreadableMessage } from '../errors.js';
import { checkText, childPointer, expectPlainObject, readFields, runCheck } from '../input/read.js';
import { keyBytes, signText } from '../proof/sign.js';
import type { Instant } from '../time/civil.js';
import { hasLoneSurrogate, withValueBudget } from '../values.js';
import { ATTESTATION_FORMAT } from './types.js';
import type { Attestation } from './types.js';
import { attestationMessage, checkInstant, HEX_DIGEST } from './verify.js';

/**
 * Cosigns a sealed proof (D-29): returns the attestation `{ format: 'run-iq.attestation/1',
 * kind: 'cosignature', subject: { proofDigest }, keyId, role?, at, signature }`, where
 * `signature` is the ed25519 signature, by `privateKeyHex`, of `canonicalize` of the
 * attestation without `signature`, in base64url without padding. ed25519 is deterministic: the
 * same arguments give the same attestation. `at` defaults to the current time; `role` is left
 * out when not given.
 *
 * It signs a digest, never a proof: check the proof first (`verifyProof`), then cosign its
 * `digest`. `verifyAttestation` checks the result against the digest and the trusted keys.
 *
 * Throws `SpecError`:
 * - `INVALID_ATTESTATION` when `proofDigest` is not 64 lowercase hex characters, when `o` is not
 *   an object `{ role?, at? }` (read once: `Cannot attest: <problem>`, a role that is not a
 *   non-empty string without lone surrogate, an `at` that is not a canonical instant, an
 *   unknown key, a member that cannot be read), or when the attestation is too long to be
 *   written as one string;
 * - `INVALID_KEY` when `keyId` is not a non-empty string without lone surrogate, or
 *   `privateKeyHex` is not 64 hex characters.
 */
export function createAttestation(
  proofDigest: string,
  privateKeyHex: string,
  keyId: string,
  o?: { role?: string; at?: Instant },
): Attestation {
  return withValueBudget(() => {
    const digest: unknown = proofDigest;
    if (typeof digest !== 'string' || !HEX_DIGEST.test(digest)) {
      throw newSpecError('INVALID_ATTESTATION', 'proofDigest must be 64 lowercase hex characters');
    }
    const id: unknown = keyId;
    if (typeof id !== 'string' || id === '' || hasLoneSurrogate(id)) {
      throw newSpecError('INVALID_KEY', 'keyId must be a non-empty string without lone surrogate');
    }
    const { role, at } = readOptions(o);
    const body = {
      format: ATTESTATION_FORMAT as typeof ATTESTATION_FORMAT,
      kind: 'cosignature',
      subject: { proofDigest: digest },
      keyId: id,
      ...(role === undefined ? {} : { role }),
      at: at ?? new Date().toISOString(),
    };
    return { ...body, signature: signAttestationBody(body, privateKeyHex) };
  });
}

const OPTION_KEYS: readonly string[] = ['role', 'at'];

/** The options, each member read once, or a thrown `INVALID_ATTESTATION`. */
function readOptions(o: unknown): { role?: string; at?: string } {
  if (o === undefined) return {};
  const read: { role?: string; at?: string } = {};
  const { issues } = runCheck(
    (reader) => {
      const { add } = reader;
      if (!expectPlainObject(o, 'options', 'an object { role?, at? }', add)) return;
      const fields = readFields(o, 'options', 'options', OPTION_KEYS, reader, {
        join: (_path, key) => childPointer('', key),
      });
      if (fields === undefined) return;
      const role = fields.values.get('role');
      if (fields.values.has('role') && checkText(role, '/role', add)) read.role = role;
      const at = fields.values.get('at');
      if (fields.values.has('at') && checkInstant(at, '/at', add)) read.at = at;
    },
    (error) => ({ path: '', message: unreadableMessage('options', error) }),
  );
  const [first] = issues;
  if (first !== undefined) {
    throw newSpecError('INVALID_ATTESTATION', `Cannot attest: ${first.message}`);
  }
  return read;
}

/**
 * Internal: the signature of the attestation `body` (its members but `signature`, which is
 * left out if present) by the hex ed25519 secret key `privateKeyHex`: ed25519 over
 * `utf8(canonicalize(body))`, unpadded base64url. Throws `INVALID_KEY` for a malformed key,
 * `INVALID_ATTESTATION` when the canonical text cannot be written as one string.
 */
export function signAttestationBody(body: object, privateKeyHex: string): string {
  const secretKey = keyBytes(privateKeyHex);
  if (!secretKey) {
    throw newSpecError(
      'INVALID_KEY',
      'privateKey must be 64 hex characters (an ed25519 secret key)',
    );
  }
  let message: string;
  try {
    message = attestationMessage(body);
  } catch (error) {
    throw newSpecError('INVALID_ATTESTATION', `Cannot attest: ${reasonOf(error)}`);
  }
  return signText(message, secretKey);
}
