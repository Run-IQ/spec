import { describe, expect, it, vi } from 'vitest';
import {
  canonicalize,
  PROOF_FORMAT,
  PROOF_FORMATS,
  proofLeafHash,
  proofLeafHashes,
  sealProof,
  verifyProofInclusion,
} from '../src/index.js';
import type { ProofLeaf, UnsaltedProof } from '../src/index.js';
import { hex, nodeSha256, referencePath, referenceRoot } from './hashing.js';
import { specError } from './helpers.js';
import { unsalted, unsigned } from './proof-cases.js';

// A second proof format, listed here only: `PROOF_FORMATS` holds one format today, so the
// format of a proof and the constant `PROOF_FORMAT` are the same string, and no test of the
// real list can tell a function that hashes under the proof's format from one that hashes
// under the constant (ruling 9K2-7).
vi.mock('../src/proof/formats.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/proof/formats.js')>();
  const formats: readonly string[] = Object.freeze([
    ...real.PROOF_FORMATS,
    'run-iq.proof/9-synthetic',
  ]);
  return {
    PROOF_FORMATS: formats,
    isProofFormat: (value: unknown) => formats.some((format) => format === value),
  };
});

const SECOND = 'run-iq.proof/9-synthetic';

/** sha256 by `node:crypto` of a proof leaf under `format`: `0x00 ‖ utf8(format) ‖ 0x00 ‖ JCS`. */
const nodeLeaf = (format: string, leaf: object): string =>
  hex(nodeSha256(Uint8Array.of(0), format, Uint8Array.of(0), canonicalize(leaf)));

/** The digest by `node:crypto`: `sha256(0x02 ‖ utf8(format) ‖ 0x00 ‖ uint64be(n) ‖ root)`. */
function nodeDigest(format: string, leaves: readonly Uint8Array[]): string {
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(leaves.length));
  const root = referenceRoot(leaves);
  return hex(nodeSha256(Uint8Array.of(2), format, Uint8Array.of(0), count, root));
}

describe('every leaf and every inclusion is hashed under the format of its proof', () => {
  const proof = sealProof({ ...unsalted(unsigned()), format: SECOND } as unknown as UnsaltedProof);
  const leaves = proofLeafHashes(proof);

  it('the second format is listed here, and the proof is sealed under it', () => {
    expect(PROOF_FORMATS).toEqual([PROOF_FORMAT, SECOND]);
    expect(proof.format).toBe(SECOND);
    expect(proof.digest).toBe(nodeDigest(SECOND, leaves));
  });

  it('proofLeafHash hashes an entry under the format given, as proofLeafHashes does', () => {
    const entry: ProofLeaf = { s: 'rules', i: 0, e: proof.rules[0] as never };
    const expected = nodeLeaf(SECOND, entry);
    expect(hex(leaves[1] as Uint8Array)).toBe(expected);
    expect(hex(proofLeafHash(entry, SECOND))).toBe(expected);
    expect(hex(proofLeafHash(entry, PROOF_FORMAT))).toBe(nodeLeaf(PROOF_FORMAT, entry));
  });

  it('proofLeafHash hashes the header under the format given, which must be its own', () => {
    const header = headerOf(proof);
    const leaf = { s: 'header', e: header } as unknown as ProofLeaf;
    expect(header.format).toBe(SECOND);
    expect(hex(leaves[0] as Uint8Array)).toBe(nodeLeaf(SECOND, leaf));
    expect(hex(proofLeafHash(leaf, SECOND))).toBe(hex(leaves[0] as Uint8Array));
    expect(specError(() => proofLeafHash(leaf, PROOF_FORMAT)).message).toBe(
      'invalid proof leaf: the header is of format run-iq.proof/9-synthetic, not run-iq.proof/1',
    );
  });

  it('verifyProofInclusion checks a leaf under the format given', () => {
    const path = referencePath(leaves, 1);
    const leaf = leaves[1] as Uint8Array;
    expect(verifyProofInclusion(proof.digest, leaves.length, 1, leaf, path, SECOND)).toBe(true);
    expect(verifyProofInclusion(proof.digest, leaves.length, 1, leaf, path, PROOF_FORMAT)).toBe(
      false,
    );
  });
});

describe('a format not listed is refused by both functions', () => {
  const proof = sealProof(unsalted(unsigned()));
  const leaves = proofLeafHashes(proof);
  const entry: ProofLeaf = { s: 'rules', i: 0, e: proof.rules[0] as never };

  it('proofLeafHash throws INVALID_PROOF, before reading the leaf', () => {
    const error = specError(() => proofLeafHash(entry, 'run-iq.proof/2'));
    expect([error.code, error.message]).toEqual([
      'INVALID_PROOF',
      'invalid proof leaf: unknown format: run-iq.proof/2',
    ]);
    expect(specError(() => proofLeafHash(entry, 7 as never)).message).toBe(
      'invalid proof leaf: format must be one of run-iq.proof/1, run-iq.proof/9-synthetic',
    );
    let reads = 0;
    const watched = new Proxy(entry, {
      get: (target, key, receiver) => {
        reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    specError(() => proofLeafHash(watched, 'run-iq.proof/2'));
    expect(reads).toBe(0);
  });

  it('verifyProofInclusion is false, never a throw', () => {
    const path = referencePath(leaves, 1);
    const leaf = leaves[1] as Uint8Array;
    const n = leaves.length;
    expect(verifyProofInclusion(proof.digest, n, 1, leaf, path, PROOF_FORMAT)).toBe(true);
    for (const format of ['run-iq.proof/2', '', 7, undefined, null]) {
      expect(verifyProofInclusion(proof.digest, n, 1, leaf, path, format as never)).toBe(false);
    }
    // A digest made under an unlisted format, matching the leaves: still refused by its format.
    const forged = nodeDigest('run-iq.proof/2', leaves);
    expect(verifyProofInclusion(forged, n, 1, leaf, path, 'run-iq.proof/2')).toBe(false);
  });
});

/** The header members of a sealed proof: every member but the sections, digest, signature. */
function headerOf(p: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const skip = new Set([
    'rules',
    'outputs',
    'items',
    'applied',
    'skipped',
    'pending',
    'exceptions',
    'factsRead',
    'missingFacts',
    'readsUndeclared',
    'digest',
    'signature',
  ]);
  for (const [key, value] of Object.entries(p)) if (!skip.has(key)) out[key] = value;
  return out;
}
