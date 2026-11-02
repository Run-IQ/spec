import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  inclusionPath,
  PROOF_SECTIONS,
  proofLeafHash,
  proofLeafHashes,
  sealProof,
  UNSALTED_SEED,
  verifyProof,
  verifyProofInclusion,
} from '../src/index.js';
import type { DecisionProof, ProofLeaf, UnsaltedProof } from '../src/index.js';
import { fromHex, hex, nodeHmac, nodeSha256, referenceRoot } from './hashing.js';
import { nested, specError, treeDigestOf } from './helpers.js';
import { unsalted, unsigned } from './proof-cases.js';

const SEED = fromHex('f9b972f50267915261e884526c8553bdf4a353eb2e4e9e78ee65716aeceaacfb');
const T = 'run-iq.proof/1\u0000';

/** The small decision of the signing tests, unsalted, to seal under `SEED`. */
const content = (): UnsaltedProof => ({ ...unsalted(unsigned()), inputSalted: true });
const sealedUnder = (): DecisionProof & Record<string, unknown> =>
  sealProof(content(), SEED) as DecisionProof & Record<string, unknown>;

/** The leaves of `p` by D-16, written with canonicalize and node:crypto only. */
function referenceLeaves(p: Record<string, unknown>): Uint8Array[] {
  const header = Object.fromEntries(
    Object.entries(p).filter(
      ([key]) => key !== 'digest' && key !== 'signature' && !PROOF_SECTIONS.includes(key as never),
    ),
  );
  const leaves = [nodeSha256(new Uint8Array([0]), T, canonicalize({ s: 'header', e: header }))];
  for (const section of PROOF_SECTIONS) {
    (p[section] as Record<string, unknown>[]).forEach((e, i) => {
      leaves.push(
        typeof e.redacted === 'string'
          ? fromHex(e.redacted)
          : nodeSha256(new Uint8Array([0]), T, canonicalize({ s: section, i, e })),
      );
    });
  }
  return leaves;
}

function referenceDigest(leaves: readonly Uint8Array[]): string {
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(leaves.length));
  return hex(nodeSha256(new Uint8Array([2]), T, count, referenceRoot(leaves)));
}

describe('sealProof(p, seed): salted entries, a tree digest (D-14, D-16)', () => {
  it('salts every entry of every section with HMAC-SHA256(seed, "proof:" + section + ":" + index)', () => {
    const sealed = sealedUnder();
    let salted = 0;
    for (const section of PROOF_SECTIONS) {
      (sealed[section] as { salt: string }[]).forEach((entry, i) => {
        expect(entry.salt).toBe(hex(nodeHmac(SEED, `proof:${section}:${i}`).subarray(0, 16)));
        salted += 1;
      });
    }
    expect(salted).toBeGreaterThan(4);
  });

  it('under UNSALTED_SEED by default', () => {
    const sealed = sealProof(unsalted(unsigned())) as DecisionProof & Record<string, unknown>;
    expect((sealed.rules[0] as { salt: string }).salt).toBe(
      hex(nodeHmac(UNSALTED_SEED, 'proof:rules:0').subarray(0, 16)),
    );
    expect(sealProof(unsalted(unsigned()), UNSALTED_SEED)).toEqual(sealed);
  });

  it('commits digest to the header leaf, then one leaf per entry, and their number', () => {
    const sealed = sealedUnder();
    const leaves = referenceLeaves(sealed);
    expect(proofLeafHashes(sealed).map(hex)).toEqual(leaves.map(hex));
    expect(leaves).toHaveLength(
      1 + PROOF_SECTIONS.reduce((n, s) => n + (sealed[s] as unknown[]).length, 0),
    );
    expect(sealed.digest).toBe(referenceDigest(leaves));
    expect(verifyProof(sealed)).toEqual({ status: 'consistent', issues: ['unsigned'] });
  });

  it('is deterministic; sealedAt changes the digest', () => {
    expect(sealedUnder().digest).toBe(sealedUnder().digest);
    const later = sealProof({ ...content(), sealedAt: '2025-06-01T10:00:00.001Z' }, SEED);
    expect(later.digest).not.toBe(sealedUnder().digest);
  });

  it('puts the index in the leaf: two entries swapped change the digest', () => {
    const sealed = sealedUnder();
    const swapped = { ...sealed, rules: [...sealed.rules].reverse() };
    expect(treeDigestOf(swapped)).not.toBe(sealed.digest);
    const [first] = sealed.rules;
    if (!first) throw new Error('a rule');
    expect(hex(proofLeafHash({ s: 'rules', i: 0, e: first }, 'run-iq.proof/1'))).not.toBe(
      hex(proofLeafHash({ s: 'rules', i: 1, e: first }, 'run-iq.proof/1')),
    );
    expect(verifyProof({ ...swapped, digest: sealed.digest }).issues).toContain('digest mismatch');
  });

  it('refuses inputSalted that does not match the seed', () => {
    const message = 'Cannot seal the proof: inputSalted does not match the seed';
    expect(specError(() => sealProof(content(), UNSALTED_SEED))).toMatchObject({
      code: 'INVALID_PROOF',
      message,
    });
    expect(specError(() => sealProof(unsalted(unsigned()), SEED))).toMatchObject({
      code: 'INVALID_PROOF',
      message,
    });
  });

  it('refuses a malformed seed first, then an entry with a salt or redacted', () => {
    expect(specError(() => sealProof(content(), new Uint8Array(31))).code).toBe('INVALID_KEY');
    expect(specError(() => sealProof(null as never, 'x' as never)).code).toBe('INVALID_KEY');
    const salted = { ...content(), rules: sealedUnder().rules } as unknown as UnsaltedProof;
    expect(specError(() => sealProof(salted, SEED)).message).toMatch(
      /^Cannot seal the proof: rules\[0\]/,
    );
    const redacted = {
      ...content(),
      factsRead: [{ redacted: 'ab'.repeat(32) }],
    } as unknown as UnsaltedProof;
    expect(specError(() => sealProof(redacted, SEED)).message).toMatch(
      /^Cannot seal the proof: factsRead\[0\]/,
    );
  });

  it('drops a digest and a signature already there', () => {
    const sealed = sealedUnder();
    const again = sealProof(
      { ...content(), digest: 'x', signature: { alg: 'ed25519', keyId: 'k', value: 'v' } } as never,
      SEED,
    );
    expect(again).toEqual(sealed);
  });
});

describe('proofLeafHashes and proofLeafHash', () => {
  it('ignore digest and signature, and refuse a malformed proof', () => {
    const sealed = sealedUnder();
    const bare: Record<string, unknown> = { ...sealed };
    delete bare.digest;
    expect(proofLeafHashes(bare as never).map(hex)).toEqual(proofLeafHashes(sealed).map(hex));
    expect(specError(() => proofLeafHashes({ ...sealed, format: 'x' } as never))).toMatchObject({
      code: 'INVALID_PROOF',
    });
    expect(specError(() => proofLeafHashes(null as never)).message).toMatch(
      /^Cannot hash the proof: /,
    );
  });

  it('gives each leaf of proofLeafHashes, the header under its format', () => {
    const sealed = sealedUnder();
    const leaves = proofLeafHashes(sealed);
    const header = Object.fromEntries(
      Object.entries(sealed).filter(
        ([key]) => key !== 'digest' && !PROOF_SECTIONS.includes(key as never),
      ),
    );
    expect(hex(proofLeafHash({ s: 'header', e: header } as never, 'run-iq.proof/1'))).toBe(
      hex(leaves[0]!),
    );
    let at = 1;
    for (const section of PROOF_SECTIONS) {
      (sealed[section] as object[]).forEach((e, i) => {
        expect(hex(proofLeafHash({ s: section, i, e } as ProofLeaf, 'run-iq.proof/1'))).toBe(
          hex(leaves[at]!),
        );
        at += 1;
      });
    }
    const redacted = { redacted: hex(leaves[1]!) };
    expect(hex(proofLeafHash({ s: 'rules', i: 0, e: redacted }, 'run-iq.proof/1'))).toBe(
      redacted.redacted,
    );
  });

  it.each([
    ['not an object', 1, /^invalid proof leaf: /],
    ['an unknown section', { s: 'secret', i: 0, e: {} }, /^invalid proof leaf: /],
    ['an entry without index', { s: 'rules', e: {} }, /^invalid proof leaf: /],
    ['a header with an index', { s: 'header', i: 0, e: {} }, /^invalid proof leaf: /],
    ['a negative index', { s: 'rules', i: -1, e: {} }, /^invalid proof leaf: /],
    ['an entry of another section', { s: 'factsRead', i: 0, e: { ruleId: 'r' } }, /^invalid/],
    ['a short redacted hash', { s: 'rules', i: 0, e: { redacted: 'ab' } }, /^invalid proof leaf: /],
    ['an unknown member', { s: 'rules', i: 0, e: {}, x: 1 }, /^invalid proof leaf: /],
  ])('refuses a leaf: %s', (_name, leaf, message) => {
    const error = specError(() => proofLeafHash(leaf as never, 'run-iq.proof/1'));
    expect(error.code).toBe('INVALID_PROOF');
    expect(error.message).toMatch(message);
  });
});

describe('verifyProofInclusion: one leaf against the signed digest', () => {
  it('proves every leaf at its place, and nothing else', () => {
    const sealed = sealedUnder();
    const leaves = proofLeafHashes(sealed);
    leaves.forEach((leaf, index) => {
      const path = inclusionPath(leaves, index);
      expect(
        verifyProofInclusion(sealed.digest, leaves.length, index, leaf, path, 'run-iq.proof/1'),
      ).toBe(true);
      const other = (index + 1) % leaves.length;
      expect(
        verifyProofInclusion(sealed.digest, leaves.length, other, leaf, path, 'run-iq.proof/1'),
      ).toBe(false);
    });
  });

  it('is false under another size, a wrong digest, or a wrong path; never throws', () => {
    const sealed = sealedUnder();
    const leaves = proofLeafHashes(sealed);
    const path = inclusionPath(leaves, 1);
    const n = leaves.length;
    expect(verifyProofInclusion(sealed.digest, n + 1, 1, leaves[1]!, path, 'run-iq.proof/1')).toBe(
      false,
    );
    expect(verifyProofInclusion('0'.repeat(64), n, 1, leaves[1]!, path, 'run-iq.proof/1')).toBe(
      false,
    );
    expect(
      verifyProofInclusion(sealed.digest.toUpperCase(), n, 1, leaves[1]!, path, 'run-iq.proof/1'),
    ).toBe(false);
    expect(
      verifyProofInclusion(sealed.digest, n, 1, leaves[1]!, path.slice(1), 'run-iq.proof/1'),
    ).toBe(false);
    for (const hostile of [null, undefined, 1.5, -1, {}, [], 'x', Symbol('s'), 1n]) {
      expect(verifyProofInclusion(hostile as never, n, 1, leaves[1]!, path, 'run-iq.proof/1')).toBe(
        false,
      );
      expect(
        verifyProofInclusion(
          sealed.digest,
          hostile as never,
          1,
          leaves[1]!,
          path,
          'run-iq.proof/1',
        ),
      ).toBe(false);
      expect(
        verifyProofInclusion(
          sealed.digest,
          n,
          hostile as never,
          leaves[1]!,
          path,
          'run-iq.proof/1',
        ),
      ).toBe(false);
      expect(
        verifyProofInclusion(sealed.digest, n, 1, hostile as never, path, 'run-iq.proof/1'),
      ).toBe(false);
      expect(
        verifyProofInclusion(sealed.digest, n, 1, leaves[1]!, hostile as never, 'run-iq.proof/1'),
      ).toBe(false);
    }
  });

  it('checks a disclosed entry without the other leaves: the header and one rule', () => {
    const sealed = sealedUnder();
    const leaves = proofLeafHashes(sealed);
    const [rule] = sealed.rules;
    const leaf = proofLeafHash({ s: 'rules', i: 0, e: rule! }, 'run-iq.proof/1');
    expect(
      verifyProofInclusion(
        sealed.digest,
        leaves.length,
        1,
        leaf,
        inclusionPath(leaves, 1),
        'run-iq.proof/1',
      ),
    ).toBe(true);
    const forged = proofLeafHash(
      { s: 'rules', i: 0, e: { ...rule!, priority: 99 } as never },
      'run-iq.proof/1',
    );
    expect(
      verifyProofInclusion(
        sealed.digest,
        leaves.length,
        1,
        forged,
        inclusionPath(leaves, 1),
        'run-iq.proof/1',
      ),
    ).toBe(false);
  });
});

describe('every leaf is the sha256 of its canonical text, short or long', () => {
  const step = (contribution: unknown) => ({
    ruleId: 'r1',
    version: 1,
    model: 'M',
    output: 'value',
    contribution,
    status: 'determined',
    stratum: 0,
    salt: 'a'.repeat(32),
  });
  const reference = (leaf: object): string =>
    hex(nodeSha256(new Uint8Array([0]), T, canonicalize(leaf)));

  it.each([
    ['escapes', 'q"b\\s\u0000\u001f\u007f\n/~0~1'],
    ['astral characters and the last BMP one', '\u{1F600}￿é'],
    ['keys in UTF-16 order', { '￿': 1, '\u{1F600}': 2, é: 3, z: 4, Z: 5, '': 6, a1: 7 }],
    ['numbers', [0, -0, 1.5, -2.25, 1e21, 1e-7, 0.1 + 0.2, 2 ** 53, -1e300]],
    ['nested lists', [[1, [2, [3, [4, [5]]]]], []]],
    ['deep objects (past the short depth)', nested(12)],
    ['a long string (past the short length)', 'x'.repeat(5_000)],
    ['a long string needing escapes', '"\n'.repeat(3_000)],
    ['many members', Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`k${i}`, i]))],
    ['null, booleans, an empty object', [null, true, false, {}]],
  ])('%s', (_name, contribution) => {
    const leaf = { s: 'applied', i: 10, e: step(contribution) } as const;
    expect(hex(proofLeafHash(leaf as never, 'run-iq.proof/1'))).toBe(reference(leaf));
  });

  // A short text with control characters and neither quote nor backslash: the fast path still
  // escapes it (review of 9K1, M1). The reference is JSON.stringify, as RFC 8785 writes strings.
  it.each(['a\nb', '\u0001\u001f', 'tab\there', '\b\f\r', '\u0000', 'x\u007f\u2028é😀'])(
    'a short sourceRef %j',
    (sourceRef) => {
      const rule = { id: 'R1', version: 1, checksum: 'ab'.repeat(32), ruleSet: 'local' };
      const leaf = {
        s: 'rules',
        i: 0,
        e: { ...rule, priority: 0, sourceRef, salt: 'a'.repeat(32) },
      };
      const text =
        `{"e":{"checksum":"${rule.checksum}","id":"R1","priority":0,"ruleSet":"local",` +
        `"salt":"${'a'.repeat(32)}","sourceRef":${JSON.stringify(sourceRef)},"version":1},` +
        `"i":0,"s":"rules"}`;
      expect(hex(proofLeafHash(leaf as never, 'run-iq.proof/1'))).toBe(
        hex(nodeSha256(new Uint8Array([0]), T, text)),
      );
    },
  );
});
