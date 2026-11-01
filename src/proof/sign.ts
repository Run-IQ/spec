import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { newSpecError } from '../errors.js';
import { contextOf, inconsistencies } from './consistency.js';
import { contentDigest } from './digest.js';
import { proofView } from './redact.js';
import type { DecisionProof } from './types.js';
import { readDecisionProof } from './validate.js';

const KEY_HEX = /^[0-9a-fA-F]{64}$/;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * A fresh ed25519 key pair, each key as 64 lowercase hex characters. Uses the platform's
 * secure random source (`crypto.getRandomValues`), in Node.js and in browsers.
 */
export function createSigningKeyPair(): { privateKey: string; publicKey: string } {
  const { secretKey, publicKey } = ed25519.keygen();
  return { privateKey: bytesToHex(secretKey), publicKey: bytesToHex(publicKey) };
}

/**
 * Signs a sealed proof: returns a copy whose `signature` is
 * `{ alg: 'ed25519', keyId, value }`, where `value` is the ed25519 signature of the 64 ASCII
 * characters of `p.digest`, in base64url without padding. An earlier signature is replaced.
 * ed25519 signatures are deterministic: the same proof and key give the same value.
 *
 * `p` is read once into a plain-JSON copy (each property read exactly once); that copy is what
 * is checked, signed and returned, so the signature always covers the returned content.
 *
 * Throws `SpecError`:
 * - `INVALID_PROOF` when `p` is malformed (see `validateProof`), its `digest` does not match
 *   its content, or it is not internally consistent (an unlisted rule, or strata that do not
 *   match its outputs and trace; see `sealProof`): a proof is never signed for content it does
 *   not hold. A redacted proof has the digest of the proof it was redacted from: it is checked
 *   as `verifyProof` checks one;
 * - `INVALID_KEY` when `privateKeyHex` is not 64 hex characters or `keyId` is empty.
 */
export function signProof(p: DecisionProof, privateKeyHex: string, keyId: string): DecisionProof {
  const { proof, errors } = readDecisionProof(p, true);
  if (!proof) throw newSpecError('INVALID_PROOF', `Cannot sign the proof: ${errors[0]}`);
  if (contentDigest(proof) !== proof.digest) {
    throw newSpecError(
      'INVALID_PROOF',
      'Cannot sign the proof: its digest does not match its content; seal it again',
    );
  }
  const { view, redactions } = proofView(proof);
  const context = contextOf(view, redactions.hidden);
  const [inconsistency] = inconsistencies(view, context, redactions.positions);
  if (inconsistency) {
    throw newSpecError('INVALID_PROOF', `Cannot sign the proof: ${inconsistency}`);
  }
  if (typeof keyId !== 'string' || keyId === '') {
    throw newSpecError('INVALID_KEY', 'keyId must be a non-empty string');
  }
  const secretKey = keyBytes(privateKeyHex);
  if (!secretKey) {
    throw newSpecError(
      'INVALID_KEY',
      'privateKey must be 64 hex characters (an ed25519 secret key)',
    );
  }
  const value = toBase64Url(ed25519.sign(utf8ToBytes(proof.digest), secretKey));
  return { ...proof, signature: { alg: 'ed25519', keyId, value } };
}

/** Internal: the 32 bytes of a hex ed25519 key (either case), or `undefined` if malformed. */
export function keyBytes(hex: unknown): Uint8Array | undefined {
  return typeof hex === 'string' && KEY_HEX.test(hex) ? hexToBytes(hex) : undefined;
}

/**
 * Internal: the bytes of a hex ed25519 public key, or `undefined` when it is not 64 hex
 * characters, does not decode to a curve point (strict RFC 8032 encoding), or is a small-order
 * point, which no honest key is.
 */
export function publicKeyBytes(hex: unknown): Uint8Array | undefined {
  const bytes = keyBytes(hex);
  if (!bytes) return undefined;
  try {
    return ed25519.Point.fromBytes(bytes).isSmallOrder() ? undefined : bytes;
  } catch {
    return undefined;
  }
}

/**
 * Internal: true when `value` (unpadded base64url) is a valid ed25519 signature of the ASCII
 * characters of `digest` under `publicKey`. Verification is strict RFC 8032 (`zip215: false`),
 * so a signature has a single valid encoding.
 */
export function signatureMatches(digest: string, value: string, publicKey: Uint8Array): boolean {
  const signature = fromBase64Url(value);
  if (!signature) return false;
  return ed25519.verify(signature, utf8ToBytes(digest), publicKey, { zip215: false });
}

function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64URL.charAt((n >> 18) & 63) + BASE64URL.charAt((n >> 12) & 63);
    if (b !== undefined) out += BASE64URL.charAt((n >> 6) & 63);
    if (c !== undefined) out += BASE64URL.charAt(n & 63);
  }
  return out;
}

/** Decodes unpadded base64url; `undefined` for any other text or non-zero trailing bits. */
function fromBase64Url(text: string): Uint8Array | undefined {
  if (text.length % 4 === 1) return undefined;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const digit = BASE64URL.indexOf(char);
    if (digit < 0) return undefined;
    buffer = ((buffer << 6) | digit) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) return undefined;
  return Uint8Array.from(bytes);
}
