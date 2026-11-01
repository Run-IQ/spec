import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  canonicalRulePayload,
  computeInputDigest,
  createSigningKeyPair,
  PROOF_FORMAT,
  PROOF_FORMATS,
  sealProof,
  sha256Hex,
  signProof,
  UNSALTED_SEED,
  validateProof,
  validateProofInput,
  verifyProof,
} from '../src/index.js';
import type { ProofInput, UnsignedProof } from '../src/index.js';
import {
  input,
  RFC_PUBLIC,
  RFC_SECRET,
  ruleA,
  ruleB,
  RULES,
  sealed,
  signed,
  TRUSTED,
  unsigned,
} from './proof-cases.js';
import { handSealed, specError, treeDigestOf, withCounts } from './helpers.js';
import { unsalted } from './proof-cases.js';
import type { PlainProof } from './proof-cases.js';

const nodeSha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
const b64url = (hex: string): string => Buffer.from(hex, 'hex').toString('base64url');

describe('PROOF_FORMAT', () => {
  it('names version 1 of the format', () => {
    expect(PROOF_FORMAT).toBe('run-iq.proof/1');
  });
});

describe('PROOF_FORMATS', () => {
  it('lists the formats accepted for ever, frozen', () => {
    expect(PROOF_FORMATS).toEqual(['run-iq.proof/1']);
    expect(PROOF_FORMATS).toContain(PROOF_FORMAT);
    expect(Object.isFrozen(PROOF_FORMATS)).toBe(true);
  });

  it('an unknown format is the only issue: the rest cannot be read in that format', () => {
    const future = { ...signed(), format: 'run-iq.proof/2', outputs: [], extra: 1 };
    expect(verifyProof(future)).toEqual({
      status: 'invalid',
      issues: ['unknown format: run-iq.proof/2'],
    });
    expect(validateProof(future)).toEqual({
      errors: ['unknown format: run-iq.proof/2'],
      issues: [{ path: 'format', message: 'unknown format: run-iq.proof/2' }],
    });
    // The type allows only PROOF_FORMAT; a JavaScript caller can pass any other format.
    const later = { ...unsigned(), format: 'run-iq.proof/2' } as unknown as UnsignedProof;
    expect(specError(() => sealProof(unsalted(later))).message).toBe(
      'Cannot seal the proof: unknown format: run-iq.proof/2',
    );
  });

  it('cites at most 256 characters of an unknown format', () => {
    const format = `x${'y'.repeat(1_000_000)}`;
    expect(verifyProof({ ...signed(), format })).toEqual({
      status: 'invalid',
      issues: [`unknown format: x${'y'.repeat(255)}…`],
    });
  });

  it('escapes control characters and lone surrogates of an unknown format', () => {
    const format = `run-iq.proof/2\n${String.fromCharCode(0xd800)}`;
    expect(verifyProof({ ...signed(), format })).toEqual({
      status: 'invalid',
      issues: ['unknown format: run-iq.proof/2\\n\\ud800'],
    });
  });

  it('quotes an unknown key with its control characters escaped', () => {
    expect(validateProof({ ...signed(), 'a\tb': 1 }).issues).toEqual([
      { path: 'a\tb', message: 'proof has an unknown key "a\\tb"' },
    ]);
  });

  it('reads format once: an accessor cannot pass one value and show another', () => {
    let reads = 0;
    const proof: Record<string, unknown> = { ...signed() };
    Object.defineProperty(proof, 'format', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? 'run-iq.proof/2' : PROOF_FORMAT;
      },
    });
    expect(verifyProof(proof)).toEqual({
      status: 'invalid',
      issues: ['unknown format: run-iq.proof/2'],
    });
  });
});

describe('computeInputDigest', () => {
  // The tree, its encoding and its vectors are tested in input-tree.test.ts and
  // input-vectors.test.ts; here, what a proof's input digest keeps from before.
  it('is the 64 hex characters of the root of the input tree', () => {
    expect(computeInputDigest(input, UNSALTED_SEED)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeInputDigest(input, UNSALTED_SEED)).not.toBe(nodeSha256(canonicalize(input)));
  });

  it('depends neither on key order nor on undefined members of the format', () => {
    // A JavaScript caller can pass `undefined` members, which the types do not allow: outside
    // `data` and `meta.context` (free-form, where it is refused), such a member is absent.
    const reordered = {
      meta: {
        context: {},
        tags: [],
        assertions: {},
        note: undefined,
        dimensions: { gone: undefined },
        tenantId: 't1',
        dates: { effective: '2025-06-01T00:00:00.000Z', gone: undefined },
      },
      extra: undefined,
      data: { income: 1000 },
    } as unknown as ProofInput;
    expect(computeInputDigest(reordered, UNSALTED_SEED)).toBe(
      computeInputDigest(input, UNSALTED_SEED),
    );
  });

  it('changes with any fact', () => {
    expect(computeInputDigest({ ...input, data: { income: 1001 } }, UNSALTED_SEED)).not.toBe(
      computeInputDigest(input, UNSALTED_SEED),
    );
  });

  it('refuses exactly what validateProofInput refuses, naming the first problem', () => {
    const cases: unknown[] = [
      { ...input, data: { x: new Map() } },
      { ...input, data: { skipped: undefined } },
      { ...input, data: { list: [1, undefined] } },
      { ...input, data: { big: 2 ** 53 } },
      { ...input, data: { $x: 1 } },
      { ...input, data: { at: new Date(0) } },
      { ...input, meta: { ...input.meta, tags: ['b', 'a'] } },
      { ...input, meta: { ...input.meta, tenantId: undefined } },
      { data: {} },
    ];
    for (const value of cases) {
      const [first] = validateProofInput(value);
      expect(first).toBeDefined();
      const error = specError(() => computeInputDigest(value as ProofInput, UNSALTED_SEED));
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toBe(`invalid input: ${first?.message ?? ''}`);
      expect(error.path).toBe(first?.path);
    }
    // A JavaScript caller can pass an `undefined` member, which the types do not allow.
    const skipped = { ...input, data: { skipped: undefined } } as unknown as ProofInput;
    expect(specError(() => computeInputDigest(skipped, UNSALTED_SEED))).toMatchObject({
      path: '/data/skipped',
      message: 'invalid input: /data/skipped is not JSON: undefined',
    });
  });
});

describe('sealProof', () => {
  it('sets digest to the tree digest of the unsigned proof (D-16)', () => {
    const proof = sealed();
    // By an independent Python implementation of JCS and of the proof tree.
    // Refrozen in the review of 9K1: the header commits to the counts of the sections.
    expect(proof.digest).toBe('0fa827f138d1d03dd8e66f28398f4287bfa7a8b97df0e440ecb0d1dc2d241d2d');
    expect(proof.digest).toBe(treeDigestOf(withCounts(unsigned())));
    expect(proof.digest).not.toBe(sha256Hex(canonicalize(unsigned())));
    expect(proof).toEqual({ ...withCounts(unsigned()), digest: proof.digest });
  });

  it('is deterministic, whatever the key order', () => {
    // Object.fromEntries loses the type; the entries are those of an UnsignedProof.
    const reversed = Object.fromEntries(Object.entries(unsigned()).reverse()) as UnsignedProof;
    expect(sealProof(unsalted(reversed))).toEqual(sealed());
    expect(sealProof(unsalted(reversed)).digest).toBe(sealed().digest);
  });

  it('refuses lists out of their order: the producer sorts them, one decision one proof', () => {
    const swapped = unsigned();
    swapped.rules.reverse();
    expect(specError(() => sealProof(unsalted(swapped))).message).toBe(
      'Cannot seal the proof: rules not sorted at 1',
    );
  });

  it('returns detached JSON data and leaves its input unchanged', () => {
    // A JavaScript caller can pass an `undefined` member, which the types do not allow.
    const source = { ...unsigned(), ruleSet: undefined } as unknown as UnsignedProof;
    const before = structuredClone(source);
    const proof = sealProof(unsalted(source)) as PlainProof;
    expect(source).toStrictEqual(before);
    expect(Object.hasOwn(proof, 'ruleSet')).toBe(false);
    proof.rules[0]!.id = 'changed';
    expect((source as PlainProof).rules[0]!.id).toBe('r1');
  });

  it('drops a previous digest and signature', () => {
    const resealed = sealProof(unsalted(signed()));
    expect(resealed).toEqual(sealed());
    expect(resealed.signature).toBeUndefined();
  });

  it('refuses an invalid proof with INVALID_PROOF', () => {
    const error = specError(() => sealProof(unsalted({ ...unsigned(), requestId: '' })));
    expect(error.code).toBe('INVALID_PROOF');
    expect(error.message).toBe('Cannot seal the proof: requestId must be a non-empty string');
  });

  it('refuses an unknown key, which the digest would otherwise cover', () => {
    const error = specError(() =>
      sealProof(unsalted({ ...unsigned(), inputs: input.data } as unknown as UnsignedProof)),
    );
    expect(error.message).toBe('Cannot seal the proof: proof has an unknown key "inputs"');
  });
});

describe('createSigningKeyPair', () => {
  it('returns a fresh hex key pair that signs and verifies', () => {
    const keys = createSigningKeyPair();
    expect(keys.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(createSigningKeyPair().privateKey).not.toBe(keys.privateKey);
    const proof = signProof(sealed(), keys.privateKey, 'k');
    expect(verifyProof(proof, { trustedKeys: { k: keys.publicKey } })).toEqual({
      status: 'authentic',
      issues: [],
    });
  });

  it('derives the public key as node:crypto does', () => {
    const { privateKey, publicKey } = createSigningKeyPair();
    const jwk = createPublicKey(
      createPrivateKey({
        key: { kty: 'OKP', crv: 'Ed25519', d: b64url(privateKey), x: b64url(publicKey) },
        format: 'jwk',
      }),
    ).export({ format: 'jwk' });
    expect(jwk.x).toBe(b64url(publicKey));
  });
});

describe('signProof', () => {
  const nodeKey = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: b64url(RFC_SECRET), x: b64url(RFC_PUBLIC) },
    format: 'jwk',
  });

  it('signs the digest string with ed25519, in unpadded base64url', () => {
    const proof = signed();
    const expected = sign(null, Buffer.from(proof.digest, 'utf8'), nodeKey).toString('base64url');
    expect(proof.signature).toEqual({ alg: 'ed25519', keyId: 'executor-1', value: expected });
    expect(proof.signature?.value).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(
      verify(
        null,
        Buffer.from(proof.digest, 'utf8'),
        createPublicKey(nodeKey),
        Buffer.from(proof.signature!.value, 'base64url'),
      ),
    ).toBe(true);
  });

  it('keeps the content and digest, and leaves its input unchanged', () => {
    const source = sealed();
    const before = structuredClone(source);
    const proof = signProof(source, RFC_SECRET, 'executor-1');
    expect(source).toStrictEqual(before);
    expect({ ...proof, signature: undefined }).toEqual({ ...source, signature: undefined });
  });

  it('replaces an earlier signature', () => {
    const keys = createSigningKeyPair();
    const resigned = signProof(signed(), keys.privateKey, 'k2');
    expect(resigned.signature?.keyId).toBe('k2');
    expect(verifyProof(resigned, { trustedKeys: { k2: keys.publicKey } }).status).toBe('authentic');
  });

  it('refuses to sign a proof whose digest does not match its content', () => {
    const proof = sealed();
    proof.requestId = 'req-x';
    const error = specError(() => signProof(proof, RFC_SECRET, 'executor-1'));
    expect(error.code).toBe('INVALID_PROOF');
    expect(error.message).toBe(
      'Cannot sign the proof: its digest does not match its content; seal it again',
    );
  });

  it('refuses to sign a proof citing a rule it does not list', () => {
    const content = unsigned();
    content.applied.push({ ...content.applied[0]!, ruleId: 'r9', contribution: 0 });
    const proof = handSealed(content);
    const error = specError(() => signProof(proof, RFC_SECRET, 'executor-1'));
    expect(error.code).toBe('INVALID_PROOF');
    expect(error.message).toBe('Cannot sign the proof: cited rule not listed: r9@1');
  });

  it('signs the content it read, read once', () => {
    let reads = 0;
    const proof = sealed();
    const genuineDigest = proof.digest;
    Object.defineProperty(proof, 'digest', {
      enumerable: true,
      get: () => (++reads <= 2 ? genuineDigest : 'f'.repeat(64)),
    });
    const result = signProof(proof, RFC_SECRET, 'executor-1');
    expect(result).toEqual(signed());
    expect(Object.getOwnPropertyDescriptor(result, 'digest')?.get).toBeUndefined();
  });

  it('refuses to sign a malformed proof', () => {
    const error = specError(() =>
      signProof({ ...sealed(), digest: 'x' }, RFC_SECRET, 'executor-1'),
    );
    expect(error.code).toBe('INVALID_PROOF');
    expect(error.message).toBe(
      'Cannot sign the proof: digest must be a lowercase sha256 hex string',
    );
  });

  it.each([
    ['short', 'ab'],
    ['not hex', 'z'.repeat(64)],
    ['prefixed with 0x', `0x${RFC_SECRET.slice(2)}`],
  ])('refuses a private key that is %s', (_name, key) => {
    const error = specError(() => signProof(sealed(), key, 'executor-1'));
    expect(error.code).toBe('INVALID_KEY');
    expect(error.message).toBe('privateKey must be 64 hex characters (an ed25519 secret key)');
  });

  it('refuses an empty keyId', () => {
    const error = specError(() => signProof(sealed(), RFC_SECRET, ''));
    expect(error.code).toBe('INVALID_KEY');
    expect(error.message).toBe('keyId must be a non-empty string');
  });
});

describe('verifyProof: authentic', () => {
  it('a proof signed with a trusted key', () => {
    expect(verifyProof(signed(), { trustedKeys: TRUSTED })).toEqual({
      status: 'authentic',
      issues: [],
    });
  });

  it('accepts an uppercase trusted key', () => {
    const trusted = { 'executor-1': RFC_PUBLIC.toUpperCase() };
    expect(verifyProof(signed(), { trustedKeys: trusted }).status).toBe('authentic');
  });

  it('a signed proof with its exact rules, in any order', () => {
    for (const rules of [RULES, [ruleB, ruleA]]) {
      expect(verifyProof(signed(), { trustedKeys: TRUSTED, rules })).toEqual({
        status: 'authentic',
        issues: [],
      });
    }
  });

  it('recomputes each checksum as sha256Hex(canonicalRulePayload(rule))', () => {
    const proof = unsigned();
    proof.rules[0]!.checksum = sha256Hex(canonicalRulePayload(ruleA));
    const resigned = signProof(sealProof(unsalted(proof)), RFC_SECRET, 'executor-1');
    expect(verifyProof(resigned, { trustedKeys: TRUSTED, rules: RULES }).status).toBe('authentic');
  });

  it('survives a JSON round trip', () => {
    const copy: unknown = JSON.parse(JSON.stringify(signed()));
    expect(verifyProof(copy, { trustedKeys: TRUSTED, rules: RULES }).status).toBe('authentic');
  });
});

describe('verifyProof: consistent, never authentic', () => {
  it('a sealed proof without signature', () => {
    expect(verifyProof(sealed())).toEqual({ status: 'consistent', issues: ['unsigned'] });
    expect(verifyProof(sealed(), { trustedKeys: TRUSTED, rules: RULES })).toEqual({
      status: 'consistent',
      issues: ['unsigned'],
    });
  });

  it('a valid signature whose key is not listed', () => {
    expect(verifyProof(signed())).toEqual({ status: 'consistent', issues: ['untrusted key'] });
    expect(verifyProof(signed(), { trustedKeys: { other: RFC_PUBLIC } })).toEqual({
      status: 'consistent',
      issues: ['untrusted key'],
    });
  });

  it('does not take an inherited property for a trusted key', () => {
    const proof = signProof(sealed(), RFC_SECRET, 'toString');
    expect(verifyProof(proof, { trustedKeys: {} })).toEqual({
      status: 'consistent',
      issues: ['untrusted key'],
    });
  });

  it('a trusted key that is not a hex ed25519 public key', () => {
    expect(verifyProof(signed(), { trustedKeys: { 'executor-1': 'abc' } })).toEqual({
      status: 'consistent',
      issues: ['trusted key malformed'],
    });
  });
});
