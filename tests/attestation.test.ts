import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_FORMAT,
  canonicalize,
  createAttestation,
  createSigningKeyPair,
  verifyAttestation,
} from '../src/index.js';
import type { Attestation, ProofVerification } from '../src/index.js';
import * as canonicalEntry from '../src/canonical-entry.js';
import { signAttestationBody } from '../src/attestation/sign.js';
import { jsonCopy, specError } from './helpers.js';
import { RFC_PUBLIC, RFC_SECRET, signed } from './proof-cases.js';
import vector from './vectors/attestation-v1.json';
import proofVector from './vectors/proof-v1.json';

const DIGEST = signed().digest;
const OTHER_DIGEST = 'f'.repeat(64);
const AT = '2026-11-01T10:00:00.000Z';
const TRUSTED = { reviewer: RFC_PUBLIC };
const OTHER_KEYS = createSigningKeyPair();

/** The reviewer's cosignature of the signed proof of `proof-cases`. */
const COSIGNATURE: Attestation = createAttestation(DIGEST, RFC_SECRET, 'reviewer', {
  role: 'human-review',
  at: AT,
});

/** `body` (an attestation without `signature`) signed by the RFC 8032 key. */
function signedBody(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, signature: signAttestationBody(body, RFC_SECRET) };
}

/** The cosignature's members without its signature, changed by `patch`. */
function bodyWith(patch: Record<string, unknown>): Record<string, unknown> {
  const body = jsonCopy(COSIGNATURE) as unknown as Record<string, unknown>;
  delete body.signature;
  return { ...body, ...patch };
}

const verify = (a: unknown, digest: unknown = DIGEST, keys: unknown = TRUSTED): ProofVerification =>
  verifyAttestation(a, digest as string, keys as Record<string, string>);

/** The ed25519 private key `secretHex` (RFC 8032 seed) as node:crypto reads it. */
function nodePrivateKey(secretHex: string): ReturnType<typeof createPrivateKey> {
  // PKCS#8 of an ed25519 seed: a fixed 16-byte prefix, then the 32 bytes.
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  return createPrivateKey({
    key: Buffer.concat([prefix, Buffer.from(secretHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
}

describe('createAttestation: a detached cosignature of a proof (D-29)', () => {
  it('gives the envelope run-iq.attestation/1, kind cosignature, subject the proof digest', () => {
    expect(ATTESTATION_FORMAT).toBe('run-iq.attestation/1');
    expect(COSIGNATURE).toEqual({
      format: 'run-iq.attestation/1',
      kind: 'cosignature',
      subject: { proofDigest: DIGEST },
      keyId: 'reviewer',
      role: 'human-review',
      at: AT,
      signature: expect.stringMatching(/^[A-Za-z0-9_-]{85}[AQgw]$/) as unknown as string,
    });
  });

  it('is authentic under the trusted key, with no issue', () => {
    expect(verify(COSIGNATURE)).toEqual({ status: 'authentic', issues: [] });
  });

  it('the signature is ed25519 over canonicalize of the attestation without signature', () => {
    const { signature, ...body } = COSIGNATURE;
    const message = canonicalize(body);
    expect(message).toBe(
      `{"at":"${AT}","format":"run-iq.attestation/1","keyId":"reviewer","kind":"cosignature",` +
        `"role":"human-review","subject":{"proofDigest":"${DIGEST}"}}`,
    );
    // Recomputed by node:crypto alone, from the RFC 8032 seed.
    const expected = nodeSign(null, Buffer.from(message, 'utf8'), nodePrivateKey(RFC_SECRET));
    expect(signature).toBe(expected.toString('base64url'));
  });

  it('is deterministic, and leaves role out when none is given', () => {
    const again = createAttestation(DIGEST, RFC_SECRET, 'reviewer', {
      role: 'human-review',
      at: AT,
    });
    expect(again).toEqual(COSIGNATURE);
    const bare = createAttestation(DIGEST, RFC_SECRET, 'reviewer', { at: AT });
    expect(Object.keys(bare)).toEqual(['format', 'kind', 'subject', 'keyId', 'at', 'signature']);
    expect(verify(bare)).toEqual({ status: 'authentic', issues: [] });
  });

  it('dates it now when no at is given, in the canonical form', () => {
    const before = Date.now();
    const a = createAttestation(DIGEST, RFC_SECRET, 'reviewer');
    const after = Date.now();
    expect(a.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const at = Date.parse(a.at);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    expect(verify(a).status).toBe('authentic');
  });

  it('matches the frozen vector, recomputed with node:crypto', () => {
    expect(vector.proofDigest).toBe(proofVector.sealed.digest);
    const made = createAttestation(vector.proofDigest, vector.secret, vector.keyId, {
      role: vector.role,
      at: vector.at,
    });
    expect(made).toEqual(vector.attestation);
    expect(canonicalize({ ...made, signature: undefined })).toBe(vector.message);
    const independent = nodeSign(
      null,
      Buffer.from(vector.message, 'utf8'),
      nodePrivateKey(vector.secret),
    ).toString('base64url');
    expect(independent).toBe(vector.attestation.signature);
    expect(
      verify(vector.attestation, vector.proofDigest, { [vector.keyId]: vector.public }),
    ).toEqual({ status: 'authentic', issues: [] });
  });

  it('refuses a malformed digest, key, key id or option with a named SpecError', () => {
    const digestError = specError(() => createAttestation('ABC', RFC_SECRET, 'reviewer'));
    expect([digestError.code, digestError.message]).toEqual([
      'INVALID_ATTESTATION',
      'proofDigest must be 64 lowercase hex characters',
    ]);
    for (const digest of [`x${DIGEST}`, `${DIGEST}0`, DIGEST.toUpperCase()]) {
      const error = specError(() => createAttestation(digest, RFC_SECRET, 'r'));
      expect([error.code, error.message], digest).toEqual([
        'INVALID_ATTESTATION',
        'proofDigest must be 64 lowercase hex characters',
      ]);
    }
    const nullOptions = specError(() => createAttestation(DIGEST, RFC_SECRET, 'r', null as never));
    expect(nullOptions.message).toBe('Cannot attest: options must be an object { role?, at? }');
    const key = specError(() => createAttestation(DIGEST, 'xyz', 'reviewer'));
    expect([key.code, key.message]).toEqual([
      'INVALID_KEY',
      'privateKey must be 64 hex characters (an ed25519 secret key)',
    ]);
    for (const keyId of ['', 7, undefined, '\ud800']) {
      const error = specError(() => createAttestation(DIGEST, RFC_SECRET, keyId as string));
      expect([error.code, error.message]).toEqual([
        'INVALID_KEY',
        'keyId must be a non-empty string without lone surrogate',
      ]);
    }
    const at = specError(() =>
      createAttestation(DIGEST, RFC_SECRET, 'reviewer', { at: '2026-11-01T11:00:00+01:00' }),
    );
    expect([at.code, at.message]).toEqual([
      'INVALID_ATTESTATION',
      'Cannot attest: /at must be an instant in its canonical form YYYY-MM-DDTHH:MM:SS.sssZ',
    ]);
    const role = specError(() =>
      createAttestation(DIGEST, RFC_SECRET, 'reviewer', { role: '', at: AT }),
    );
    expect(role.message).toBe('Cannot attest: /role must be a non-empty string');
    const unknown = specError(() =>
      createAttestation(DIGEST, RFC_SECRET, 'reviewer', { kind: 'timestamp' } as never),
    );
    expect(unknown.message).toBe('Cannot attest: options has an unknown key "kind"');
    const notObject = specError(() =>
      createAttestation(DIGEST, RFC_SECRET, 'reviewer', 'now' as never),
    );
    expect(notObject.message).toBe('Cannot attest: options must be an object { role?, at? }');
  });

  it('both entries export it', () => {
    expect(canonicalEntry.createAttestation).toBe(createAttestation);
    expect(canonicalEntry.verifyAttestation).toBe(verifyAttestation);
    expect(canonicalEntry.ATTESTATION_FORMAT).toBe(ATTESTATION_FORMAT);
  });
});

describe('verifyAttestation: what it proves about which proof', () => {
  it('for another proof: invalid', () => {
    expect(verify(COSIGNATURE, OTHER_DIGEST)).toEqual({
      status: 'invalid',
      issues: ['attestation for another proof'],
    });
  });

  it('a key not listed: consistent; a listed key that is malformed: invalid', () => {
    expect(verify(COSIGNATURE, DIGEST, {})).toEqual({
      status: 'consistent',
      issues: ['untrusted key'],
    });
    expect(verifyAttestation(COSIGNATURE, DIGEST, undefined as never)).toEqual({
      status: 'consistent',
      issues: ['untrusted key'],
    });
    // A trusted key that is malformed is a configuration error, not a missing key.
    expect(verify(COSIGNATURE, DIGEST, { reviewer: 'zz' })).toEqual({
      status: 'invalid',
      issues: ['trustedKeys.reviewer is malformed'],
    });
    // A key of Object.prototype is not listed; an object of another prototype is refused.
    const toString = signedBody(bodyWith({ keyId: 'toString' }));
    expect(verify(toString, DIGEST, {}).issues).toEqual(['untrusted key']);
    const inherited = Object.create({ reviewer: RFC_PUBLIC }) as Record<string, string>;
    expect(verify(COSIGNATURE, DIGEST, inherited)).toEqual({
      status: 'invalid',
      issues: ['trustedKeys must be an object of hex public keys'],
    });
  });

  it('signed by another key, or with any member changed: signature invalid', () => {
    expect(verify(COSIGNATURE, DIGEST, { reviewer: OTHER_KEYS.publicKey })).toEqual({
      status: 'invalid',
      issues: ['signature invalid'],
    });
    for (const patch of [
      { role: 'auditor' },
      { at: '2026-11-01T10:00:00.001Z' },
      { keyId: 'executor-1' },
    ]) {
      const changed = { ...COSIGNATURE, ...patch };
      const keys = { reviewer: RFC_PUBLIC, 'executor-1': RFC_PUBLIC };
      expect(verify(changed, DIGEST, keys)).toEqual({
        status: 'invalid',
        issues: ['signature invalid'],
      });
    }
    const withoutRole = { ...COSIGNATURE } as Partial<Attestation>;
    delete withoutRole.role;
    expect(verify(withoutRole).issues).toEqual(['signature invalid']);
  });

  it('a proof signature never verifies as an attestation: the messages differ', () => {
    const proofSignature = signed().signature?.value;
    expect(verify({ ...COSIGNATURE, signature: proofSignature }).issues).toEqual([
      'signature invalid',
    ]);
  });

  it('checks its arguments: the digest expected and the trusted keys', () => {
    for (const digest of [`${DIGEST}0`, `x${DIGEST}`]) {
      expect(verify(COSIGNATURE, digest).issues).toEqual([
        'the expected proof digest must be 64 lowercase hex characters',
      ]);
    }
    expect(verify({ ...COSIGNATURE, subject: { proofDigest: `${DIGEST}0` } }).issues).toEqual([
      '/subject/proofDigest must be 64 lowercase hex characters',
    ]);
    expect(verify(COSIGNATURE, 'ABC')).toEqual({
      status: 'invalid',
      issues: ['the expected proof digest must be 64 lowercase hex characters'],
    });
    expect(verify(COSIGNATURE, DIGEST, 'keys')).toEqual({
      status: 'invalid',
      issues: ['trustedKeys must be an object of hex public keys'],
    });
  });
});

describe('the kind is open (D-6) but only cosignature is verified: any other is invalid (D-29)', () => {
  for (const kind of ['timestamp', 'revocation', 'cosignature-v2']) {
    it(`${kind} over a key: invalid, the kind named, and not about this proof`, () => {
      const a = signedBody(bodyWith({ kind, subject: { keyId: 'executor-1' } }));
      expect(verify(a)).toEqual({
        status: 'invalid',
        issues: [`attestation kind not supported: ${kind}`, 'attestation not about this proof'],
      });
    });
  }

  it('a revocation of the signer key is never a weak yes for the proof', () => {
    const a = signedBody(bodyWith({ kind: 'revocation', subject: { keyId: 'reviewer' } }));
    expect(verify(a).status).toBe('invalid');
    expect(verify(a, OTHER_DIGEST).status).toBe('invalid');
  });

  it('a cosignature of a key is invalid by its shape, a keyId subject of another kind by its subject', () => {
    expect(verify(signedBody(bodyWith({ subject: { keyId: 'k' } })))).toEqual({
      status: 'invalid',
      issues: ['cosignature needs subject.proofDigest'],
    });
  });

  it('an unsupported kind over a proof is invalid, and still compared with the proof expected', () => {
    const a = signedBody(bodyWith({ kind: 'timestamp' }));
    expect(verify(a)).toEqual({
      status: 'invalid',
      issues: ['attestation kind not supported: timestamp'],
    });
    expect(verify(a, OTHER_DIGEST)).toEqual({
      status: 'invalid',
      issues: ['attestation kind not supported: timestamp', 'attestation for another proof'],
    });
  });

  it('an unsupported kind is still signed: a bad signature is invalid', () => {
    const a = { ...signedBody(bodyWith({ kind: 'timestamp' })), role: 'other' };
    expect(verify(a)).toEqual({
      status: 'invalid',
      issues: ['attestation kind not supported: timestamp', 'signature invalid'],
    });
  });

  it('an empty kind is invalid', () => {
    expect(verify(signedBody(bodyWith({ kind: '' })))).toEqual({
      status: 'invalid',
      issues: ['/kind must be a non-empty string'],
    });
  });

  it('a cosignature needs subject.proofDigest', () => {
    const a = signedBody(bodyWith({ subject: { keyId: 'executor-1' } }));
    expect(verify(a)).toEqual({
      status: 'invalid',
      issues: ['cosignature needs subject.proofDigest'],
    });
  });

  it('cites a long kind in at most 256 characters', () => {
    const kind = `k${'x'.repeat(10_000)}`;
    const a = signedBody(bodyWith({ kind, subject: { keyId: 'executor-1' } }));
    expect(verify(a).issues).toEqual([
      `attestation kind not supported: k${'x'.repeat(255)}…`,
      'attestation not about this proof',
    ]);
  });
});

describe('claims: the one signed member reserved for later kinds (ruling 9K2-8)', () => {
  const CLAIMS = { token: 'MIIB', reasons: ['key-compromise'], serial: 7 };
  const timestamp = signedBody(
    bodyWith({ kind: 'timestamp', subject: { keyId: 'executor-1' }, claims: CLAIMS }),
  );

  it('an unsupported kind with claims: invalid, the kind named', () => {
    expect(verify(timestamp)).toEqual({
      status: 'invalid',
      issues: ['attestation kind not supported: timestamp', 'attestation not about this proof'],
    });
  });

  it('the signature covers the claims, in their canonical form', () => {
    const { signature, ...body } = timestamp;
    expect(canonicalize(body)).toBe(
      `{"at":"${AT}","claims":{"reasons":["key-compromise"],"serial":7,"token":"MIIB"},` +
        '"format":"run-iq.attestation/1","keyId":"reviewer","kind":"timestamp",' +
        '"role":"human-review","subject":{"keyId":"executor-1"}}',
    );
    expect(signature).toBe(signAttestationBody(body, RFC_SECRET));
    const changed = { ...timestamp, claims: { ...CLAIMS, serial: 8 } };
    expect(verify(changed)).toEqual({
      status: 'invalid',
      issues: [
        'attestation kind not supported: timestamp',
        'attestation not about this proof',
        'signature invalid',
      ],
    });
    const dropped = { ...timestamp, claims: undefined };
    expect(verify(dropped)).toEqual({
      status: 'invalid',
      issues: [
        'attestation kind not supported: timestamp',
        'attestation not about this proof',
        'signature invalid',
      ],
    });
  });

  it('a cosignature takes no claims, even empty', () => {
    for (const claims of [{}, CLAIMS]) {
      expect(verify(signedBody(bodyWith({ claims })))).toEqual({
        status: 'invalid',
        issues: ['cosignature takes no claims'],
      });
    }
  });

  it('claims are a plain JSON object', () => {
    for (const claims of [[], 'x', 7, null, true, new Date(0)]) {
      const a = signedBody(bodyWith({ kind: 'timestamp', claims }));
      expect(verify(a), String(claims)).toEqual({
        status: 'invalid',
        issues: ['/claims must be a plain JSON object'],
      });
    }
    const values: [unknown, string][] = [
      [{ n: 2 ** 53 }, 'number beyond 2^53 at /claims/n'],
      [{ n: Number.NaN }, '/claims/n is not JSON: NaN'],
      [{ t: 'a\ud800' }, '/claims/t contains a lone UTF-16 surrogate'],
      [{ l: [1, undefined] }, '/claims/l/1 is not JSON: undefined'],
    ];
    for (const [claims, issue] of values) {
      const a = { ...timestamp, claims };
      expect(verify(a), issue).toEqual({ status: 'invalid', issues: [issue] });
    }
  });

  it('every other unknown member is still refused: the envelope stays closed', () => {
    expect(verify({ ...timestamp, evidence: 'x' })).toEqual({
      status: 'invalid',
      issues: ['attestation has an unknown key "evidence"'],
    });
  });

  it('an attestation without claims signs the same bytes as before: the vector holds', () => {
    expect('claims' in COSIGNATURE).toBe(false);
    const made = createAttestation(vector.proofDigest, vector.secret, vector.keyId, {
      role: vector.role,
      at: vector.at,
    });
    expect(made.signature).toBe(vector.attestation.signature);
    expect(canonicalize({ ...made, signature: undefined })).toBe(vector.message);
    expect(vector.message).not.toContain('claims');
  });
});

describe('the format of an attestation', () => {
  it('an unknown format is the only issue', () => {
    expect(verify({ ...COSIGNATURE, format: 'run-iq.attestation/2', kind: 7 })).toEqual({
      status: 'invalid',
      issues: ['unknown format: run-iq.attestation/2'],
    });
  });

  it('cites an unknown format in at most 256 characters', () => {
    expect(verify({ ...COSIGNATURE, format: `x${'y'.repeat(10_000)}` }).issues).toEqual([
      `unknown format: x${'y'.repeat(255)}…`,
    ]);
  });

  it('every member has its shape, each problem at its path', () => {
    const cases: [string, unknown, string[]][] = [
      [
        'not an object',
        [],
        [
          'attestation must be an object { format, kind, subject, keyId, role?, claims?, at, signature }',
        ],
      ],
      [
        'null',
        null,
        [
          'attestation must be an object { format, kind, subject, keyId, role?, claims?, at, signature }',
        ],
      ],
      [
        'no member',
        {},
        [
          '/format is required',
          '/kind is required',
          '/subject is required',
          '/keyId is required',
          '/at is required',
          '/signature is required',
        ],
      ],
      ['format not a text', { ...COSIGNATURE, format: 1 }, ['/format must be a string']],
      ['an unknown key', { ...COSIGNATURE, extra: 1 }, ['attestation has an unknown key "extra"']],
      ['kind not a text', { ...COSIGNATURE, kind: 1 }, ['/kind must be a non-empty string']],
      [
        'subject not an object',
        { ...COSIGNATURE, subject: DIGEST },
        ['/subject must be an object { proofDigest } or { keyId }'],
      ],
      [
        'subject empty',
        { ...COSIGNATURE, subject: {} },
        ['/subject must hold exactly one of proofDigest and keyId'],
      ],
      [
        'subject with both',
        { ...COSIGNATURE, subject: { proofDigest: DIGEST, keyId: 'k' } },
        ['/subject must hold exactly one of proofDigest and keyId'],
      ],
      [
        'subject with an unknown key',
        { ...COSIGNATURE, subject: { digest: DIGEST } },
        [
          '/subject has an unknown key "digest"',
          '/subject must hold exactly one of proofDigest and keyId',
        ],
      ],
      [
        'subject digest upper case',
        { ...COSIGNATURE, subject: { proofDigest: DIGEST.toUpperCase() } },
        ['/subject/proofDigest must be 64 lowercase hex characters'],
      ],
      [
        'subject key empty',
        { ...COSIGNATURE, kind: 'revocation', subject: { keyId: '' } },
        ['/subject/keyId must be a non-empty string'],
      ],
      ['keyId empty', { ...COSIGNATURE, keyId: '' }, ['/keyId must be a non-empty string']],
      ['role empty', { ...COSIGNATURE, role: '' }, ['/role must be a non-empty string']],
      [
        'role a lone surrogate',
        { ...COSIGNATURE, role: 'a\udc00' },
        ['/role contains a lone UTF-16 surrogate'],
      ],
      [
        'at with an offset',
        { ...COSIGNATURE, at: '2026-11-01T11:00:00+01:00' },
        ['/at must be an instant in its canonical form YYYY-MM-DDTHH:MM:SS.sssZ'],
      ],
      [
        'at a civil date',
        { ...COSIGNATURE, at: '2026-11-01' },
        ['/at must be an instant in its canonical form YYYY-MM-DDTHH:MM:SS.sssZ'],
      ],
      [
        'at a day that does not exist',
        { ...COSIGNATURE, at: '2026-02-29T10:00:00.000Z' },
        ['/at must be an instant in its canonical form YYYY-MM-DDTHH:MM:SS.sssZ'],
      ],
      [
        'signature short',
        { ...COSIGNATURE, signature: 'abc' },
        ['/signature must be an ed25519 signature in unpadded base64url (86 characters)'],
      ],
      [
        'signature padded',
        { ...COSIGNATURE, signature: `${COSIGNATURE.signature.slice(0, 86)}==` },
        ['/signature must be an ed25519 signature in unpadded base64url (86 characters)'],
      ],
    ];
    for (const [name, value, issues] of cases) {
      expect(verify(value), name).toEqual({ status: 'invalid', issues });
    }
  });

  it('a member whose value is undefined is absent', () => {
    expect(verify({ ...COSIGNATURE, role: undefined }).issues).toEqual(['signature invalid']);
    const bare = createAttestation(DIGEST, RFC_SECRET, 'reviewer', {
      at: AT,
      role: undefined,
    } as never);
    expect(verify(bare)).toEqual({ status: 'authentic', issues: [] });
  });
});

describe('the JSON schema accepts and refuses the same attestations', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../schema/attestation.schema.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const schemaAccepts = ajv.compile(schema);

  /** Accepted by both: each well formed, signed. */
  const ACCEPTED: [string, unknown][] = [
    ['the cosignature', COSIGNATURE],
    ['without role', signedBody(bodyWith({ role: undefined }))],
    ['a leap day', signedBody(bodyWith({ at: '2028-02-29T23:59:59.999Z' }))],
    ['year 0000, a leap year', signedBody(bodyWith({ at: '0000-02-29T00:00:00.000Z' }))],
    ['a role of any text', signedBody(bodyWith({ role: 'réviseur 🧾' }))],
  ];

  /** Refused by both. */
  const REFUSED: [string, unknown][] = [
    ['an array', []],
    ['a string', 'x'],
    ['another format', { ...COSIGNATURE, format: 'run-iq.attestation/2' }],
    ['no format', { ...COSIGNATURE, format: undefined }],
    ['an unknown key', { ...COSIGNATURE, extra: 1 }],
    ['an empty kind', { ...COSIGNATURE, kind: '' }],
    ['a numeric kind', { ...COSIGNATURE, kind: 1 }],
    ['no kind', { ...COSIGNATURE, kind: undefined }],
    ['a cosignature over a key', { ...COSIGNATURE, subject: { keyId: 'k' } }],
    ['a subject string', { ...COSIGNATURE, subject: DIGEST }],
    ['a subject null', { ...COSIGNATURE, subject: null }],
    ['an empty subject', { ...COSIGNATURE, subject: {} }],
    ['a subject with both', { ...COSIGNATURE, subject: { proofDigest: DIGEST, keyId: 'k' } }],
    ['a subject with another key', { ...COSIGNATURE, subject: { proofDigest: DIGEST, x: 1 } }],
    ['a short digest', { ...COSIGNATURE, subject: { proofDigest: 'ab' } }],
    ['an upper-case digest', { ...COSIGNATURE, subject: { proofDigest: DIGEST.toUpperCase() } }],
    ['an empty subject key', { ...COSIGNATURE, kind: 'revocation', subject: { keyId: '' } }],
    ['an empty keyId', { ...COSIGNATURE, keyId: '' }],
    ['no keyId', { ...COSIGNATURE, keyId: undefined }],
    ['an empty role', { ...COSIGNATURE, role: '' }],
    ['a numeric role', { ...COSIGNATURE, role: 1 }],
    ['an offset', { ...COSIGNATURE, at: '2026-11-01T11:00:00+01:00' }],
    ['two decimals', { ...COSIGNATURE, at: '2026-11-01T10:00:00.00Z' }],
    ['a lower z', { ...COSIGNATURE, at: '2026-11-01T10:00:00.000z' }],
    ['second 60', { ...COSIGNATURE, at: '2026-11-01T10:00:60.000Z' }],
    ['hour 24', { ...COSIGNATURE, at: '2026-11-01T24:00:00.000Z' }],
    ['29 February 2026', { ...COSIGNATURE, at: '2026-02-29T10:00:00.000Z' }],
    ['29 February 1900', { ...COSIGNATURE, at: '1900-02-29T10:00:00.000Z' }],
    ['31 April', { ...COSIGNATURE, at: '2026-04-31T10:00:00.000Z' }],
    ['five-digit year', { ...COSIGNATURE, at: '+12026-11-01T10:00:00.000Z' }],
    ['a short signature', { ...COSIGNATURE, signature: 'abc' }],
    ['a padded signature', { ...COSIGNATURE, signature: `${COSIGNATURE.signature}==` }],
    ['trailing bits', { ...COSIGNATURE, signature: `${COSIGNATURE.signature.slice(0, 85)}B` }],
    ['a base64 signature', { ...COSIGNATURE, signature: `+${COSIGNATURE.signature.slice(1)}` }],
    ['no signature', { ...COSIGNATURE, signature: undefined }],
    ['claims on a cosignature', { ...COSIGNATURE, claims: {} }],
    ['claims a list', { ...COSIGNATURE, kind: 'timestamp', claims: [] }],
    ['claims a string', { ...COSIGNATURE, kind: 'timestamp', claims: 'x' }],
    ['claims null', { ...COSIGNATURE, kind: 'timestamp', claims: null }],
  ];

  /** Refused by the verifier alone: what JSON Schema cannot express. */
  const VERIFIER_ONLY: [string, unknown][] = [
    ['a timestamp over a proof (kind not supported)', signedBody(bodyWith({ kind: 'timestamp' }))],
    [
      'a revocation over a key (kind not supported, not about a proof)',
      signedBody(bodyWith({ kind: 'revocation', subject: { keyId: 'k' } })),
    ],
    [
      'any kind text (kind not supported)',
      signedBody(bodyWith({ kind: 'Some kind', subject: { keyId: 'k' } })),
    ],
    [
      'a timestamp with claims (kind not supported)',
      signedBody(bodyWith({ kind: 'timestamp', claims: { token: 'MIIB', n: [1, { a: null }] } })),
    ],
    [
      'empty claims on a revocation (kind not supported)',
      signedBody(bodyWith({ kind: 'revocation', claims: {} })),
    ],
    ['a lone surrogate in kind', { ...COSIGNATURE, kind: 'x\ud800', subject: { keyId: 'k' } }],
    ['a lone surrogate in keyId', { ...COSIGNATURE, keyId: '\udc00' }],
    ['a lone surrogate in role', { ...COSIGNATURE, role: 'a\ud800' }],
    [
      'a lone surrogate in the subject key',
      { ...COSIGNATURE, kind: 'x', subject: { keyId: '\ud800' } },
    ],
    ['a lone surrogate in claims', { ...COSIGNATURE, kind: 'x', claims: { t: '\ud800' } }],
    ['a number of 2^53 in claims', { ...COSIGNATURE, kind: 'x', claims: { n: 2 ** 53 } }],
  ];

  it.each(ACCEPTED)('accepts %s', (_name, value) => {
    expect(schemaAccepts(jsonCopy(value))).toBe(true);
    expect(verify(value).status).not.toBe('invalid');
  });

  it.each(REFUSED)('refuses %s', (_name, value) => {
    expect(schemaAccepts(jsonCopy(value))).toBe(false);
    expect(verify(value).status).toBe('invalid');
  });

  it.each(VERIFIER_ONLY)('verifier only: refuses %s (the schema cannot)', (_name, value) => {
    expect(verify(value).status).toBe('invalid');
    expect(schemaAccepts(value)).toBe(true);
  });

  it('the schema documents the verifier-only checks', () => {
    expect(schema.description).toMatch(/lone UTF-16 surrogate/);
    expect(schema.description).toMatch(/signature/);
    expect(schema.description).toMatch(/refuses it as invalid/);
    expect(schema.description).toMatch(/never about a proof/);
  });

  it('the package exports the schema', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, unknown>;
      files: string[];
    };
    expect(pkg.exports['./schema/attestation.schema.json']).toBe(
      './schema/attestation.schema.json',
    );
    expect(pkg.files).toContain('schema');
  });
});
