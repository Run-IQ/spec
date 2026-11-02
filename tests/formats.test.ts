import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_FORMAT,
  canonicalize,
  DISCLOSURE_FORMAT,
  PROOF_FORMAT,
  PROOF_FORMATS,
  PROOF_SECTIONS,
  proofLeafHashes,
  REFERENTIAL_FORMAT,
  sealProof,
  signProof,
  validateProof,
  verifyAttestation,
  verifyFactDisclosure,
  verifyProof,
} from '../src/index.js';
import type { UnsaltedProof } from '../src/index.js';
import { hex, nodeSha256, referenceRoot } from './hashing.js';
import { specError } from './helpers.js';
import { RFC_PUBLIC, RFC_SECRET, unsalted, unsigned } from './proof-cases.js';

/** The content of the signing tests' proof, written in `format`. */
const contentIn = (format: string): UnsaltedProof =>
  ({ ...unsalted(unsigned()), format }) as UnsaltedProof;

describe('the format policy (D-6)', () => {
  it('PROOF_FORMATS lists the formats read for ever, frozen: run-iq.proof/1 today', () => {
    expect(PROOF_FORMATS).toEqual(['run-iq.proof/1']);
    expect(PROOF_FORMATS).toContain(PROOF_FORMAT);
    expect(Object.isFrozen(PROOF_FORMATS)).toBe(true);
  });

  it('the annex formats are versioned apart', () => {
    expect([REFERENTIAL_FORMAT, DISCLOSURE_FORMAT, ATTESTATION_FORMAT]).toEqual([
      'run-iq.referential/1',
      'run-iq.disclosure/1',
      'run-iq.attestation/1',
    ]);
  });

  it.each(PROOF_FORMATS)('verifyProof reads every listed format: %s', (format) => {
    const proof = sealProof(contentIn(format));
    expect(proof.format).toBe(format);
    expect(validateProof(proof)).toEqual({ errors: [], issues: [] });
    expect(verifyProof(proof)).toEqual({ status: 'consistent', issues: ['unsigned'] });
    const trusted = { 'executor-1': RFC_PUBLIC };
    expect(
      verifyProof(signProof(proof, RFC_SECRET, 'executor-1'), { trustedKeys: trusted }),
    ).toEqual({ status: 'authentic', issues: [] });
  });

  it.each(PROOF_FORMATS)('the domain tag of D-16 is the format of the proof: %s', (format) => {
    const proof = sealProof(contentIn(format)) as unknown as Record<string, unknown>;
    // T = utf8(format) ‖ 0x00, written here with node:crypto alone.
    const T = `${format}\u0000`;
    const header = Object.fromEntries(
      Object.entries(proof).filter(
        ([key]) =>
          ![
            'digest',
            'signature',
            'rules',
            'outputs',
            'items',
            'applied',
            'skipped',
            'pending',
          ].includes(key) &&
          !['exceptions', 'factsRead', 'missingFacts', 'readsUndeclared'].includes(key),
      ),
    );
    const leaves = proofLeafHashes(proof as never);
    expect(hex(leaves[0] as Uint8Array)).toBe(
      hex(nodeSha256(new Uint8Array([0]), T, canonicalize({ s: 'header', e: header }))),
    );
    const rules = proof.rules as unknown[];
    expect(hex(leaves[1] as Uint8Array)).toBe(
      hex(nodeSha256(new Uint8Array([0]), T, canonicalize({ s: 'rules', i: 0, e: rules[0] }))),
    );
    // Every leaf, then the RFC 6962 root (`referenceRoot`, node:crypto), rebuilt here alone.
    const nodeLeaves = [
      nodeSha256(new Uint8Array([0]), T, canonicalize({ s: 'header', e: header })),
    ];
    for (const section of PROOF_SECTIONS) {
      (proof[section] as unknown[]).forEach((e, i) =>
        nodeLeaves.push(nodeSha256(new Uint8Array([0]), T, canonicalize({ s: section, i, e }))),
      );
    }
    expect(nodeLeaves.map(hex)).toEqual(leaves.map(hex));
    const count = new Uint8Array(8);
    new DataView(count.buffer).setBigUint64(0, BigInt(nodeLeaves.length));
    const root = referenceRoot(nodeLeaves);
    expect(proof.digest).toBe(hex(nodeSha256(new Uint8Array([2]), T, count, root)));
  });

  it('a format not listed is read by no function: one issue, nothing else checked', () => {
    const later = { ...sealProof(contentIn(PROOF_FORMAT)), format: 'run-iq.proof/2' };
    expect(verifyProof(later)).toEqual({
      status: 'invalid',
      issues: ['unknown format: run-iq.proof/2'],
    });
    expect(validateProof(later).errors).toEqual(['unknown format: run-iq.proof/2']);
    expect(specError(() => sealProof(contentIn('run-iq.proof/2'))).message).toBe(
      'Cannot seal the proof: unknown format: run-iq.proof/2',
    );
    const disclosure = verifyFactDisclosure({ format: 'run-iq.disclosure/2' }, '0'.repeat(64));
    expect(disclosure.issues).toEqual(['unknown format: run-iq.disclosure/2']);
    const attestation = verifyAttestation({ format: 'run-iq.attestation/2' }, '0'.repeat(64), {});
    expect(attestation).toEqual({
      status: 'invalid',
      issues: ['unknown format: run-iq.attestation/2'],
    });
  });
});
