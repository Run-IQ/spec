import { describe, expect, it } from 'vitest';
import { createAttestation, verifyAttestation } from '../src/index.js';
import type { Attestation, ProofVerification } from '../src/index.js';
import { attestationMessage } from '../src/attestation/verify.js';
import { signAttestationBody } from '../src/attestation/sign.js';
import { lastValuesSpent } from '../src/values.js';
import { counted, jsonCopy, nested, revokedProxy, specError } from './helpers.js';
import { RFC_PUBLIC, RFC_SECRET, signed } from './proof-cases.js';

const DIGEST = signed().digest;
const AT = '2026-11-01T10:00:00.000Z';
const TRUSTED = { reviewer: RFC_PUBLIC };
const COSIGNATURE: Attestation = createAttestation(DIGEST, RFC_SECRET, 'reviewer', {
  role: 'human-review',
  at: AT,
});

const verify = (a: unknown, keys: unknown = TRUSTED): ProofVerification =>
  verifyAttestation(a, DIGEST, keys as Record<string, string>);

/** A JSON copy of the cosignature, changed by `change`. */
function changed(change: (copy: Record<string, unknown>) => void): Record<string, unknown> {
  const copy = jsonCopy(COSIGNATURE) as unknown as Record<string, unknown>;
  change(copy);
  return copy;
}

/** Replaces `key` of `target` by a getter that throws `Error('boom')`. */
function throwAt(target: Record<string, unknown>, key: string): void {
  Object.defineProperty(target, key, {
    enumerable: true,
    get(): never {
      throw new Error('boom');
    },
  });
}

/** A Proxy whose every trap throws `Error('boom')`. */
function throwingProxy(target: object): object {
  const fail = (): never => {
    throw new Error('boom');
  };
  return new Proxy(target, {
    get: fail,
    has: fail,
    ownKeys: fail,
    getOwnPropertyDescriptor: fail,
    getPrototypeOf: fail,
  });
}

const invalid = (issues: string[]): ProofVerification => ({ status: 'invalid', issues });

describe('verifyAttestation never throws: a hostile value is a named invalid', () => {
  it('a getter that throws, wherever it is read', () => {
    for (const key of ['format', 'kind', 'subject', 'keyId', 'role', 'at', 'signature']) {
      expect(verify(changed((copy) => throwAt(copy, key))), key).toEqual(
        invalid([`/${key} could not be read: boom`]),
      );
    }
    const subject = changed((copy) =>
      throwAt(copy.subject as Record<string, unknown>, 'proofDigest'),
    );
    expect(verify(subject)).toEqual(invalid(['/subject/proofDigest could not be read: boom']));
  });

  it('a getter that throws a forged SpecError is cited, never passed on', () => {
    const forged = changed((copy) =>
      Object.defineProperty(copy, 'kind', {
        enumerable: true,
        get(): never {
          throw Object.assign(new Error('x'.repeat(10_000)), { code: 'INVALID_KEY' });
        },
      }),
    );
    const result = verify(forged);
    expect(result.status).toBe('invalid');
    expect(result.issues).toEqual([`/kind could not be read: ${'x'.repeat(256)}…`]);
  });

  it('a Proxy whose traps throw, a revoked Proxy', () => {
    expect(verify(throwingProxy({}))).toEqual(invalid(['attestation could not be read: boom']));
    expect(verify(changed((copy) => (copy.subject = throwingProxy({}))))).toEqual(
      invalid(['/subject could not be read: boom']),
    );
    expect(verify(revokedProxy())).toEqual(
      invalid([
        "attestation could not be read: Cannot perform 'IsArray' on a proxy that has been revoked",
      ]),
    );
  });

  it('duplicate keys through a Proxy are refused, never read twice', () => {
    const copy = jsonCopy(COSIGNATURE) as unknown as Record<string, unknown>;
    const twice = new Proxy(copy, {
      ownKeys: () => [...Object.keys(copy), 'kind'],
    });
    const result = verify(twice);
    expect(result.status).toBe('invalid');
    expect(result.issues).toEqual([
      expect.stringMatching(/^attestation could not be read: .*duplicate/) as unknown as string,
    ]);
    const subject = { proofDigest: DIGEST };
    const doubled = changed(
      (c) => (c.subject = new Proxy(subject, { ownKeys: () => ['proofDigest', 'proofDigest'] })),
    );
    expect(verify(doubled).issues).toEqual([
      expect.stringMatching(/^\/subject could not be read: .*duplicate/) as unknown as string,
    ]);
  });

  it('nesting 10 000 levels deep wherever a text or a subject is expected', () => {
    const deep = nested(10_000);
    for (const key of ['format', 'kind', 'keyId', 'role', 'at', 'signature']) {
      const result = verify(changed((copy) => (copy[key] = deep)));
      expect(result.status, key).toBe('invalid');
      expect(result.issues, key).toHaveLength(1);
    }
    expect(verify(changed((copy) => (copy.subject = { proofDigest: deep })))).toEqual(
      invalid(['/subject/proofDigest must be 64 lowercase hex characters']),
    );
    expect(verify(changed((copy) => (copy.subject = deep)))).toEqual(
      invalid([
        '/subject has an unknown key "a"',
        '/subject must hold exactly one of proofDigest and keyId',
      ]),
    );
  });

  it('a wrong-type subject', () => {
    for (const subject of [null, 7, 'x', true, [DIGEST], [], new Date(0)]) {
      expect(verify(changed((copy) => (copy.subject = subject))), String(subject)).toEqual(
        invalid(['/subject must be an object { proofDigest } or { keyId }']),
      );
    }
  });

  it('a non-canonical at', () => {
    for (const at of [
      '2026-11-01T10:00:00Z',
      '2026-11-01T10:00:00.000+00:00',
      '2026-11-01 10:00:00.000Z',
      '2026-13-01T10:00:00.000Z',
      ' 2026-11-01T10:00:00.000Z',
      1_793_520_000_000,
      new Date(AT),
    ]) {
      expect(verify(changed((copy) => (copy.at = at))), String(at)).toEqual(
        invalid(['/at must be an instant in its canonical form YYYY-MM-DDTHH:MM:SS.sssZ']),
      );
    }
  });

  it('an empty or unknown kind', () => {
    expect(verify(changed((copy) => (copy.kind = '')))).toEqual(
      invalid(['/kind must be a non-empty string']),
    );
    const unknown = { ...COSIGNATURE, kind: 'notary' };
    unknown.signature = signAttestationBody({ ...unknown, signature: undefined }, RFC_SECRET);
    expect(verify(unknown)).toEqual({
      status: 'consistent',
      issues: ['attestation kind not supported: notary'],
    });
  });

  it('hostile arguments: the trusted keys and the digest expected', () => {
    expect(verify(COSIGNATURE, throwingProxy({}))).toEqual(
      invalid(['trustedKeys could not be read: boom']),
    );
    const keys = {};
    throwAt(keys, 'reviewer');
    expect(verify(COSIGNATURE, keys)).toEqual(invalid(['trustedKeys could not be read: boom']));
    expect(verifyAttestation(COSIGNATURE, throwingProxy({}) as unknown as string, TRUSTED)).toEqual(
      invalid(['the expected proof digest must be 64 lowercase hex characters']),
    );
    expect(verify(COSIGNATURE, [])).toEqual(
      invalid(['trustedKeys must be an object of hex public keys']),
    );
  });

  it('huge texts: a 10,000,000-character role and key id are named, never thrown', () => {
    const huge = 'r'.repeat(10_000_000);
    const a = { ...COSIGNATURE, role: huge };
    expect(verify(a)).toEqual(invalid(['signature invalid']));
    const resigned = {
      ...a,
      signature: signAttestationBody({ ...a, signature: undefined }, RFC_SECRET),
    };
    expect(verify(resigned)).toEqual({ status: 'authentic', issues: [] });
    expect(verify({ ...COSIGNATURE, keyId: huge })).toEqual({
      status: 'consistent',
      issues: ['untrusted key'],
    });
  });

  it('huge lists where an object or a text is expected: no element is read', () => {
    let reads = 0;
    const claiming = new Proxy<unknown[]>([], {
      get(target, key) {
        if (key === 'length') return 2 ** 32 - 1;
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key) as unknown;
      },
    });
    for (const key of ['subject', 'kind', 'at', 'signature']) {
      const result = verify(changed((copy) => (copy[key] = claiming)));
      expect(result.status, key).toBe('invalid');
    }
    expect(verify(claiming).issues).toEqual([
      'attestation must be an object { format, kind, subject, keyId, role?, at, signature }',
    ]);
    expect(reads).toBe(0);
  });
});

describe('read once, at a bounded cost (counted)', () => {
  it('each property of the attestation is read exactly once', () => {
    const counter = { reads: 0 };
    const subjectCounter = { reads: 0 };
    const copy = jsonCopy(COSIGNATURE) as unknown as Record<string, unknown>;
    copy.subject = counted(copy.subject as object, subjectCounter);
    const perKey = new Map<PropertyKey, number>();
    const proxy = new Proxy(copy, {
      get(target, key, receiver) {
        perKey.set(key, (perKey.get(key) ?? 0) + 1);
        counter.reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(verify(proxy)).toEqual({ status: 'authentic', issues: [] });
    expect(Object.fromEntries(perKey)).toEqual({
      format: 1,
      kind: 1,
      subject: 1,
      keyId: 1,
      role: 1,
      at: 1,
      signature: 1,
    });
    expect(subjectCounter.reads).toBe(1);
    // The values counted in the budget: the seven members and the one of the subject.
    expect(lastValuesSpent()).toBe(8);
  });

  it('each trusted key is read once, only the one named', () => {
    const keys = { reviewer: RFC_PUBLIC, other: RFC_PUBLIC };
    const reads = new Map<PropertyKey, number>();
    const proxy = new Proxy(keys, {
      get(target, key, receiver) {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(verify(COSIGNATURE, proxy).status).toBe('authentic');
    expect(Object.fromEntries(reads)).toEqual({ reviewer: 1 });
  });

  it('the message signed is the canonical text of the six members: linear in their size', () => {
    for (const size of [1, 1_000, 1_000_000]) {
      const role = 'r'.repeat(size);
      const message = attestationMessage({ ...COSIGNATURE, role });
      const base = attestationMessage({ ...COSIGNATURE, role: '' });
      expect(message.length - base.length).toBe(size);
    }
  });

  it('createAttestation reads each option once and refuses hostile options by name', () => {
    const counter = { reads: 0 };
    createAttestation(DIGEST, RFC_SECRET, 'reviewer', counted({ role: 'r', at: AT }, counter));
    expect(counter.reads).toBe(2);
    const options = {};
    throwAt(options, 'at');
    const error = specError(() => createAttestation(DIGEST, RFC_SECRET, 'reviewer', options));
    expect([error.code, error.message]).toEqual([
      'INVALID_ATTESTATION',
      'Cannot attest: /at could not be read: boom',
    ]);
    const proxy = specError(() =>
      createAttestation(DIGEST, RFC_SECRET, 'reviewer', throwingProxy({}) as never),
    );
    expect(proxy.message).toBe('Cannot attest: options could not be read: boom');
    const digest = specError(() =>
      createAttestation(throwingProxy({}) as unknown as string, RFC_SECRET, 'reviewer'),
    );
    expect(digest.code).toBe('INVALID_ATTESTATION');
  });
});
