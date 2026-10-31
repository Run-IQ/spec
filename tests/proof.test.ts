import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import {
  canonicalize,
  canonicalRulePayload,
  computeInputDigest,
  computeRuleChecksum,
  createSigningKeyPair,
  PROOF_FORMAT,
  sealProof,
  sha256Hex,
  signProof,
  SpecError,
  validateProof,
  verifyProof,
} from '../src/index.js';
import type {
  DecisionProof,
  ProofInput,
  RuleDefinitionInput,
  UnsignedProof,
} from '../src/index.js';
import { REFUSED_PROOFS, VALID_PROOFS, VALIDATOR_ONLY_PROOFS } from './proof-cases.js';

const nodeSha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
const b64url = (hex: string): string => Buffer.from(hex, 'hex').toString('base64url');

/** RFC 8032, section 7.1, test 1. */
const RFC_SECRET = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const RFC_PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const TRUSTED = { 'executor-1': RFC_PUBLIC };

const ruleA: RuleDefinitionInput = {
  id: 'r1',
  version: 1,
  model: 'FLAT',
  params: { amount: 150 },
  priority: 1,
  effectiveFrom: '2025-01-01',
  sourceRef: 'art. 1',
};
const ruleB: RuleDefinitionInput = {
  id: 'r2',
  version: 2,
  model: 'PERCENTAGE',
  params: { rate: 0.1, base: 'income' },
  priority: 2,
  effectiveFrom: '2025-01-01',
  condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'income' }, 5000] } },
};
const RULES = [ruleA, ruleB];

const input: ProofInput = {
  data: { income: 1000 },
  meta: {
    tenantId: 't1',
    effectiveDate: '2025-06-01T00:00:00.000Z',
    tags: [],
    dimensions: {},
    context: {},
  },
};

function unsigned(): UnsignedProof {
  return {
    format: PROOF_FORMAT,
    requestId: 'req-1',
    evaluatedAt: '2025-06-01T00:00:00.000Z',
    sealedAt: '2025-06-01T10:00:00.000Z',
    inputDigest: computeInputDigest(input),
    rules: [
      { id: 'r1', version: 1, checksum: computeRuleChecksum(ruleA), sourceRef: 'art. 1' },
      { id: 'r2', version: 2, checksum: computeRuleChecksum(ruleB) },
    ],
    versions: { engine: '1.0.0-next.1', plugins: {}, dsls: { jsonlogic: '0.2.0' } },
    outputs: { value: { type: 'number', combine: 'sum', value: 150, contributors: ['r1'] } },
    applied: [
      {
        ruleId: 'r1',
        version: 1,
        model: 'FLAT',
        output: 'value',
        contribution: 150,
        sourceRef: 'art. 1',
      },
    ],
    skipped: [{ ruleId: 'r2', version: 2, reason: 'CONDITION_FALSE' }],
    exceptions: [],
  };
}

const sealed = (): DecisionProof => sealProof(unsigned());
const signed = (): DecisionProof => signProof(sealed(), RFC_SECRET, 'executor-1');

/** The `SpecError` `call` throws; fails the test when it does not throw one. */
function specError(call: () => unknown): SpecError {
  try {
    call();
  } catch (error) {
    if (error instanceof SpecError) return error;
    throw error;
  }
  throw new Error('expected a SpecError');
}

describe('PROOF_FORMAT', () => {
  it('names version 1 of the format', () => {
    expect(PROOF_FORMAT).toBe('run-iq.proof/1');
  });
});

describe('computeInputDigest', () => {
  it('is the sha256 of the canonical input', () => {
    expect(computeInputDigest(input)).toBe(nodeSha256(canonicalize(input)));
    expect(computeInputDigest(input)).toBe(
      nodeSha256(
        '{"data":{"income":1000},"meta":{"context":{},"dimensions":{},' +
          '"effectiveDate":"2025-06-01T00:00:00.000Z","tags":[],"tenantId":"t1"}}',
      ),
    );
  });

  it('depends neither on key order nor on undefined members', () => {
    // A JavaScript caller can pass `undefined` members, which the types do not allow.
    const reordered = {
      meta: {
        context: {},
        tags: [],
        dimensions: {},
        tenantId: 't1',
        effectiveDate: '2025-06-01T00:00:00.000Z',
      },
      data: { skipped: undefined, income: 1000 },
    } as unknown as ProofInput;
    expect(computeInputDigest(reordered)).toBe(computeInputDigest(input));
  });

  it('changes with any fact', () => {
    expect(computeInputDigest({ ...input, data: { income: 1001 } })).not.toBe(
      computeInputDigest(input),
    );
  });

  it('refuses a value with no JSON form, naming its path', () => {
    const error = specError(() =>
      computeInputDigest({ ...input, data: { x: new Map() } } as unknown as ProofInput),
    );
    expect(error.code).toBe('NON_SERIALIZABLE');
    expect(error.path).toBe('data.x');
  });
});

describe('sealProof', () => {
  it('sets digest to the sha256 of the canonical unsigned proof', () => {
    const proof = sealed();
    expect(proof.digest).toBe(sha256Hex(canonicalize(unsigned())));
    expect(proof.digest).toBe(nodeSha256(canonicalize(unsigned())));
    expect(proof).toEqual({ ...unsigned(), digest: proof.digest });
  });

  it('is deterministic, whatever the key order', () => {
    // Object.fromEntries loses the type; the entries are those of an UnsignedProof.
    const reversed = Object.fromEntries(Object.entries(unsigned()).reverse()) as UnsignedProof;
    expect(sealProof(reversed)).toEqual(sealed());
    expect(sealProof(reversed).digest).toBe(sealed().digest);
  });

  it('does not sort lists: the producer does', () => {
    const swapped = unsigned();
    swapped.rules.reverse();
    expect(sealProof(swapped).rules.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(sealProof(swapped).digest).not.toBe(sealed().digest);
  });

  it('returns detached JSON data and leaves its input unchanged', () => {
    // A JavaScript caller can pass an `undefined` member, which the types do not allow.
    const source = { ...unsigned(), ruleSet: undefined } as unknown as UnsignedProof;
    const before = structuredClone(source);
    const proof = sealProof(source);
    expect(source).toStrictEqual(before);
    expect(Object.hasOwn(proof, 'ruleSet')).toBe(false);
    proof.rules[0]!.id = 'changed';
    expect(source.rules[0]!.id).toBe('r1');
  });

  it('drops a previous digest and signature', () => {
    const resealed = sealProof(signed());
    expect(resealed).toEqual(sealed());
    expect(resealed.signature).toBeUndefined();
  });

  it('refuses an invalid proof with INVALID_PROOF', () => {
    const error = specError(() => sealProof({ ...unsigned(), requestId: '' }));
    expect(error.code).toBe('INVALID_PROOF');
    expect(error.message).toBe('Cannot seal the proof: requestId must be a non-empty string');
  });

  it('refuses an unknown key, which the digest would otherwise cover', () => {
    const error = specError(() =>
      sealProof({ ...unsigned(), inputs: input.data } as unknown as UnsignedProof),
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
    proof.outputs.value!.value = 1;
    const error = specError(() => signProof(proof, RFC_SECRET, 'executor-1'));
    expect(error.code).toBe('INVALID_PROOF');
    expect(error.message).toBe(
      'Cannot sign the proof: its digest does not match its content; seal it again',
    );
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
    const resigned = signProof(sealProof(proof), RFC_SECRET, 'executor-1');
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

describe('verifyProof: invalid, with a readable issue', () => {
  it('an output changed after sealing', () => {
    const proof = signed();
    proof.outputs.value!.value = 1;
    expect(verifyProof(proof, { trustedKeys: TRUSTED })).toEqual({
      status: 'invalid',
      issues: ['digest mismatch'],
    });
    const unsignedProof = sealed();
    unsignedProof.outputs.value!.value = 1;
    expect(verifyProof(unsignedProof)).toEqual({
      status: 'invalid',
      issues: ['digest mismatch', 'unsigned'],
    });
  });

  it('a rule removed from the proof after sealing', () => {
    const proof = signed();
    proof.rules.pop();
    expect(verifyProof(proof, { trustedKeys: TRUSTED, rules: RULES })).toEqual({
      status: 'invalid',
      issues: ['digest mismatch', 'cited rule not listed: r2@2', 'unexpected rule: r2@2'],
    });
    expect(verifyProof(proof, { trustedKeys: TRUSTED })).toEqual({
      status: 'invalid',
      issues: ['digest mismatch', 'cited rule not listed: r2@2'],
    });
  });

  it.each([
    ['applied', (p: UnsignedProof) => p.applied.push({ ...p.applied[0]!, version: 2 }), 'r1@2'],
    [
      'skipped',
      (p: UnsignedProof) => p.skipped.push({ ruleId: 'r3', version: 1, reason: 'INACTIVE_DATE' }),
      'r3@1',
    ],
    [
      'exceptions',
      (p: UnsignedProof) =>
        p.exceptions.push({ ruleId: 'r4', version: 1, kind: 'inhibit', affected: ['r1'] }),
      'r4@1',
    ],
  ])('a rule cited in %s but not listed in rules', (_name, cite, key) => {
    const content = unsigned();
    cite(content);
    // sealProof refuses such a proof: seal it by hand, as a faulty producer would.
    const proof: DecisionProof = { ...content, digest: sha256Hex(canonicalize(content)) };
    const resigned = { ...proof, signature: signed().signature };
    expect(verifyProof(proof)).toEqual({
      status: 'invalid',
      issues: [`cited rule not listed: ${key}`, 'unsigned'],
    });
    expect(verifyProof(resigned, { trustedKeys: TRUSTED }).issues).toContain(
      `cited rule not listed: ${key}`,
    );
    expect(verifyProof(resigned, { trustedKeys: TRUSTED }).status).toBe('invalid');
    const error = specError(() => sealProof(content));
    expect(error.code).toBe('INVALID_PROOF');
    expect(error.message).toBe(`Cannot seal the proof: cited rule not listed: ${key}`);
  });

  it('reports a rule cited several times once', () => {
    const content = unsigned();
    content.applied.push({ ...content.applied[0]!, ruleId: 'r5' });
    content.skipped.push({ ruleId: 'r5', version: 1, reason: 'DOMINATED' });
    const proof: DecisionProof = { ...content, digest: sha256Hex(canonicalize(content)) };
    expect(verifyProof(proof).issues).toEqual(['cited rule not listed: r5@1', 'unsigned']);
  });

  it('a digest recomputed after tampering, without a new signature', () => {
    const proof = signed();
    proof.outputs.value!.value = 1;
    const tampered = { ...proof, digest: sealProof(proof).digest };
    expect(verifyProof(tampered, { trustedKeys: TRUSTED })).toEqual({
      status: 'invalid',
      issues: ['signature invalid'],
    });
  });

  it('the signature of another digest', () => {
    const other = signProof(
      sealProof({ ...unsigned(), requestId: 'req-2' }),
      RFC_SECRET,
      'executor-1',
    );
    const proof = { ...signed(), signature: other.signature };
    expect(verifyProof(proof, { trustedKeys: TRUSTED })).toEqual({
      status: 'invalid',
      issues: ['signature invalid'],
    });
  });

  it('a signature checked against the wrong trusted key', () => {
    const { publicKey } = createSigningKeyPair();
    expect(verifyProof(signed(), { trustedKeys: { 'executor-1': publicKey } })).toEqual({
      status: 'invalid',
      issues: ['signature invalid'],
    });
  });

  it('a trusted key of the right length that is not a curve point', () => {
    expect(verifyProof(signed(), { trustedKeys: { 'executor-1': 'f'.repeat(64) } })).toEqual({
      status: 'invalid',
      issues: ['signature invalid'],
    });
  });

  it('a rule missing from the given rules', () => {
    expect(verifyProof(signed(), { trustedKeys: TRUSTED, rules: [ruleA] })).toEqual({
      status: 'invalid',
      issues: ['rule missing: r2@2'],
    });
  });

  it('an extra rule in the given rules', () => {
    const extra = { ...ruleA, id: 'r3' };
    expect(verifyProof(signed(), { trustedKeys: TRUSTED, rules: [...RULES, extra] })).toEqual({
      status: 'invalid',
      issues: ['unexpected rule: r3@1'],
    });
  });

  it('a given rule whose checksum differs', () => {
    const changed = { ...ruleA, params: { amount: 151 } };
    expect(verifyProof(signed(), { trustedKeys: TRUSTED, rules: [changed, ruleB] })).toEqual({
      status: 'invalid',
      issues: ['rule checksum mismatch: r1@1'],
    });
  });

  it('a rule given twice', () => {
    expect(verifyProof(signed(), { trustedKeys: TRUSTED, rules: [...RULES, ruleA] })).toEqual({
      status: 'invalid',
      issues: ['duplicate rule: r1@1'],
    });
  });

  it('a given rule spec refuses', () => {
    const broken = { ...ruleA, effectiveFrom: 'yesterday' };
    expect(verifyProof(signed(), { trustedKeys: TRUSTED, rules: [broken, ruleB] })).toEqual({
      status: 'invalid',
      issues: [
        'rule invalid: rules[0]: effectiveFrom must be a Date, YYYY-MM-DD, or an ISO date-time ' +
          'with Z or an offset; got "yesterday"',
        'rule missing: r1@1',
      ],
    });
  });

  it('every problem at once, in a fixed order', () => {
    const proof = sealed();
    proof.outputs.value!.value = 1;
    const changed = { ...ruleA, params: { amount: 151 } };
    expect(verifyProof(proof, { rules: [changed, { ...ruleB, id: 'r9' }] })).toEqual({
      status: 'invalid',
      issues: [
        'digest mismatch',
        'unsigned',
        'rule checksum mismatch: r1@1',
        'rule missing: r2@2',
        'unexpected rule: r9@2',
      ],
    });
  });

  it('an unknown format or a missing field', () => {
    expect(verifyProof({ ...signed(), format: 'run-iq.proof/2' })).toEqual({
      status: 'invalid',
      issues: ['format must be "run-iq.proof/1"'],
    });
    const withoutOutputs: Record<string, unknown> = { ...signed() };
    delete withoutOutputs.outputs;
    expect(verifyProof(withoutOutputs)).toEqual({
      status: 'invalid',
      issues: ['outputs is required'],
    });
  });

  it('malformed options', () => {
    const bad = { trustedKeys: 'key', rules: 'r1' } as unknown as Parameters<typeof verifyProof>[1];
    expect(verifyProof(signed(), bad)).toEqual({
      status: 'invalid',
      issues: ['trustedKeys must be an object of hex public keys', 'rules must be an array'],
    });
  });

  it('options that are not an object', () => {
    const bad = 'trusted' as unknown as Parameters<typeof verifyProof>[1];
    expect(verifyProof(signed(), bad)).toEqual({
      status: 'invalid',
      issues: ['options must be an object { trustedKeys?, rules? }', 'untrusted key'],
    });
  });

  it('never throws, whatever the input', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('boom');
        },
      },
    );
    const values: unknown[] = [undefined, null, 'proof', 42, [], {}, new Map(), hostile];
    for (const value of values) {
      const result = verifyProof(value);
      expect(result.status).toBe('invalid');
      expect(result.issues.length).toBeGreaterThan(0);
    }
    expect(verifyProof(null)).toEqual({
      status: 'invalid',
      issues: ['a decision proof must be a plain object'],
    });
    expect(verifyProof(hostile)).toEqual({
      status: 'invalid',
      issues: ['proof could not be read: boom'],
    });
  });
});

describe('validateProof', () => {
  it.each(VALID_PROOFS)('accepts %s', (_name, value) => {
    expect(validateProof(value)).toEqual({ errors: [], issues: [] });
  });

  it.each([...REFUSED_PROOFS, ...VALIDATOR_ONLY_PROOFS])(
    'refuses %s with one issue',
    (_name, value, path, message) => {
      expect(validateProof(value)).toEqual({ errors: [message], issues: [{ path, message }] });
    },
  );

  it('accepts sealed and signed proofs', () => {
    expect(validateProof(sealed())).toEqual({ errors: [], issues: [] });
    expect(validateProof(signed())).toEqual({ errors: [], issues: [] });
  });

  it('reports every problem, unknown keys first, then fields in order', () => {
    expect(
      validateProof({ ...sealed(), extra: 1, requestId: 7, rules: [{ id: '' }] }).issues,
    ).toEqual([
      { path: 'extra', message: 'proof has an unknown key "extra"' },
      { path: 'requestId', message: 'requestId must be a non-empty string' },
      { path: 'rules[0].id', message: 'rules[0].id must be a non-empty string' },
      { path: 'rules[0].version', message: 'rules[0].version is required' },
      { path: 'rules[0].checksum', message: 'rules[0].checksum is required' },
    ]);
  });

  it('refuses a value with no JSON form, naming its path', () => {
    const proof = sealed();
    proof.applied[0]!.contribution = { rates: [0.1, Number.NaN] };
    expect(validateProof(proof).issues).toEqual([
      {
        path: 'applied[0].contribution.rates[1]',
        message:
          'Value at "applied[0].contribution.rates[1]" cannot be serialized to canonical JSON: NaN',
      },
    ]);
  });

  it('treats an undefined member as absent, like the digest', () => {
    expect(validateProof({ ...sealed(), ruleSet: undefined, signature: undefined }).issues).toEqual(
      [],
    );
    expect(validateProof({ ...sealed(), outputs: undefined }).issues).toEqual([
      { path: 'outputs', message: 'outputs is required' },
    ]);
  });

  it('refuses a Date where an ISO string is expected', () => {
    expect(validateProof({ ...sealed(), sealedAt: new Date(0) }).issues).toEqual([
      {
        path: 'sealedAt',
        message: 'sealedAt must be an ISO date: YYYY-MM-DD, or a date-time with Z or an offset',
      },
    ]);
  });
});

describe('both entries', () => {
  it('export the whole proof API', () => {
    expect(canonicalEntry.PROOF_FORMAT).toBe(PROOF_FORMAT);
    expect(canonicalEntry.verifyProof(signed(), { trustedKeys: TRUSTED }).status).toBe('authentic');
    const proof = canonicalEntry.signProof(
      canonicalEntry.sealProof(unsigned()),
      RFC_SECRET,
      'executor-1',
    );
    expect(proof).toEqual(signed());
    expect(canonicalEntry.computeInputDigest(input)).toBe(computeInputDigest(input));
    expect(canonicalEntry.validateProof(proof)).toEqual({ errors: [], issues: [] });
    expect(typeof canonicalEntry.createSigningKeyPair().publicKey).toBe('string');
  });
});
