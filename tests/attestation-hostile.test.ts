import { describe, expect, it } from 'vitest';
import { createAttestation, verifyAttestation } from '../src/index.js';
import type { Attestation, ProofVerification } from '../src/index.js';
import { attestationMessage } from '../src/attestation/verify.js';
import { signAttestationBody } from '../src/attestation/sign.js';
import { lastValuesSpent } from '../src/values.js';
import { counted, jsonCopy, nested, optionError, revokedProxy, specError } from './helpers.js';
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

const SHAPE_ISSUES: Record<string, string> = {
  format: '/format must be a string',
  kind: '/kind must be a non-empty string',
  keyId: '/keyId must be a non-empty string',
  role: '/role must be a non-empty string',
  at: '/at must be an instant in its canonical form YYYY-MM-DDTHH:MM:SS.sssZ',
  signature: '/signature must be an ed25519 signature in unpadded base64url (86 characters)',
  subject: '/subject must be an object { proofDigest } or { keyId }',
};

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
    expect(verify(twice)).toEqual(
      invalid([
        "attestation could not be read: 'ownKeys' on proxy: trap returned duplicate entries",
      ]),
    );
    const subject = { proofDigest: DIGEST };
    const doubled = changed(
      (c) => (c.subject = new Proxy(subject, { ownKeys: () => ['proofDigest', 'proofDigest'] })),
    );
    expect(verify(doubled)).toEqual(
      invalid(["/subject could not be read: 'ownKeys' on proxy: trap returned duplicate entries"]),
    );
  });

  it('nesting 10 000 levels deep wherever a text or a subject is expected', () => {
    const deep = nested(10_000);
    for (const key of ['format', 'kind', 'keyId', 'role', 'at', 'signature']) {
      expect(verify(changed((copy) => (copy[key] = deep))), key).toEqual(
        invalid([SHAPE_ISSUES[key] as string]),
      );
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
      status: 'invalid',
      issues: ['attestation kind not supported: notary'],
    });
  });

  it('hostile arguments: the trusted keys and the digest expected', () => {
    expect(optionError(() => verify(COSIGNATURE, throwingProxy({})))).toMatchObject({
      option: 'trustedKeys',
      message: 'trustedKeys could not be read: boom',
    });
    const keys = {};
    throwAt(keys, 'reviewer');
    expect(optionError(() => verify(COSIGNATURE, keys))).toMatchObject({
      option: 'trustedKeys.reviewer',
      message: 'trustedKeys.reviewer could not be read: boom',
    });
    expect(
      optionError(() =>
        verifyAttestation(COSIGNATURE, throwingProxy({}) as unknown as string, TRUSTED),
      ),
    ).toMatchObject({
      option: 'proofDigest',
      message: 'the expected proof digest must be 64 lowercase hex characters',
    });
    expect(optionError(() => verify(COSIGNATURE, []))).toMatchObject({
      option: 'trustedKeys',
      message: 'trustedKeys must be an object of hex public keys',
    });
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
      expect(verify(changed((copy) => (copy[key] = claiming))), key).toEqual(
        invalid([SHAPE_ISSUES[key] as string]),
      );
    }
    expect(verify(claiming).issues).toEqual([
      'attestation must be an object { format, kind, subject, keyId, role?, claims?, at, signature }',
    ]);
    expect(reads).toBe(0);
  });
});

describe('hostile claims: a named invalid, never a throw, read once', () => {
  /** A timestamp over a key carrying `claims`, signed when `sign` is true. */
  function withClaims(claims: unknown, sign = false): Record<string, unknown> {
    const a = changed((copy) => {
      copy.kind = 'timestamp';
      copy.subject = { keyId: 'executor-1' };
    });
    a.claims = claims;
    if (sign) a.signature = signAttestationBody({ ...a, signature: undefined }, RFC_SECRET);
    return a;
  }

  it('a getter that throws, on the member or inside it', () => {
    const a = withClaims({});
    throwAt(a, 'claims');
    expect(verify(a)).toEqual(invalid(['/claims could not be read: boom']));
    const inner = { token: 'x' };
    throwAt(inner, 'token');
    expect(verify(withClaims(inner))).toEqual(invalid(['/claims/token could not be read: boom']));
  });

  it('a Proxy whose traps throw, a revoked Proxy', () => {
    expect(verify(withClaims(throwingProxy({})))).toEqual(
      invalid(['/claims could not be read: boom']),
    );
    expect(verify(withClaims(revokedProxy()))).toEqual(
      invalid([
        "/claims could not be read: Cannot perform 'IsArray' on a proxy that has been revoked",
      ]),
    );
  });

  it('nesting 10 000 levels deep: one issue at the first container past the limit', () => {
    const result = verify(withClaims(nested(10_000)));
    expect(result).toEqual(
      invalid([
        `/claims${'/a'.repeat(1000)}`.slice(0, 256) + '… is nested deeper than 1000 levels',
      ]),
    );
  });

  it('over the value budget: a list claiming 2^32 - 1 elements, none read', () => {
    let reads = 0;
    const claiming = new Proxy<unknown[]>([], {
      get(target, key) {
        if (key === 'length') return 2 ** 32 - 1;
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key) as unknown;
      },
    });
    expect(verify(withClaims({ list: claiming }))).toEqual(
      invalid(['/claims/list is too large: more than 10000000 values']),
    );
    expect(reads).toBe(0);
  });

  it('on a cosignature, claims are refused unread, whatever they hold', () => {
    let reads = 0;
    const claims = new Proxy(
      { n: Number.NaN },
      {
        get: () => {
          reads += 1;
          throw new Error('boom');
        },
      },
    );
    expect(verify(changed((copy) => (copy.claims = claims)))).toEqual(
      invalid(['cosignature takes no claims']),
    );
    expect(reads).toBe(0);
  });

  it('not an object', () => {
    for (const claims of [null, 7, 'x', [], [{}], new Map()]) {
      expect(verify(withClaims(claims)), String(claims)).toEqual(
        invalid(['/claims must be a plain JSON object']),
      );
    }
  });

  it('each property of the claims is read once, and counted', () => {
    const counter = { reads: 0 };
    const a = withClaims({ a: 1, inner: { b: 2 }, list: [1, 2] }, true);
    a.claims = counted({ a: 1, inner: counted({ b: 2 }, counter), list: [1, 2] }, counter);
    expect(verify(a)).toEqual({
      status: 'invalid',
      issues: ['attestation kind not supported: timestamp', 'attestation not about this proof'],
    });
    // a, inner, list, then b: four member reads, each once.
    expect(counter.reads).toBe(4);
    // Seven members, claims, the subject's one, then a, inner, list, b and two elements.
    expect(lastValuesSpent()).toBe(8 + 1 + 6);
  });
});

describe('an object shared by the subject and the claims is read once', () => {
  it('one read, and the same value in both members', () => {
    let reads = 0;
    const shared = {
      get keyId(): string {
        reads++;
        return `k${reads}`;
      },
    };
    const a = changed((copy) => {
      copy.kind = 'timestamp';
    });
    a.subject = shared;
    a.claims = { s: shared };
    // What a single read gives: k1 in the subject and in the claims, signed by the reviewer.
    const once = { ...a, subject: { keyId: 'k1' }, claims: { s: { keyId: 'k1' } } };
    a.signature = signAttestationBody({ ...once, signature: undefined }, RFC_SECRET);
    expect(verify(a)).toEqual({
      status: 'invalid',
      issues: ['attestation kind not supported: timestamp', 'attestation not about this proof'],
    });
    expect(reads).toBe(1);
  });

  it('a subject that cannot be read is reported once, and not read again as claims', () => {
    let reads = 0;
    const shared = {
      get keyId(): string {
        reads++;
        throw new Error('boom');
      },
    };
    const a = changed((copy) => {
      copy.kind = 'timestamp';
    });
    a.subject = shared;
    a.claims = { s: shared };
    expect(verify(a)).toEqual(invalid(['/subject/keyId could not be read: boom']));
    expect(reads).toBe(1);
  });
});

describe('a shared subject is read once at any depth of the claims', () => {
  /** `shared` under `levels` objects `{ a: … }`, as the claims. */
  function under(shared: object, levels: number): Record<string, unknown> {
    let value: unknown = shared;
    for (let i = 0; i < levels; i++) value = { a: value };
    return value as Record<string, unknown>;
  }
  function counting(): { subject: object; reads: () => number } {
    let reads = 0;
    const subject = {
      get keyId(): string {
        reads++;
        return 'k1';
      },
    };
    return { subject, reads: () => reads };
  }
  function attestation(subject: object, claims: unknown): Record<string, unknown> {
    const a = changed((copy) => {
      copy.kind = 'timestamp';
    });
    a.subject = subject;
    a.claims = claims;
    return a;
  }

  it('at depth 1000, one container past the limit: read once, the depth reported', () => {
    const { subject, reads } = counting();
    const result = verify(attestation(subject, under(subject, 1000)));
    expect(result).toEqual(
      invalid([
        `/claims${'/a'.repeat(1000)}`.slice(0, 256) + '… is nested deeper than 1000 levels',
      ]),
    );
    expect(reads()).toBe(1);
  });

  it('at depth 999, the deepest that fits: read once, the claims accepted', () => {
    const { subject, reads } = counting();
    const a = attestation(subject, under(subject, 999));
    // What a single read gives: k1 in the subject and at the foot of the claims, signed.
    const once = {
      ...a,
      subject: { keyId: 'k1' },
      claims: under({ keyId: 'k1' }, 999),
      signature: undefined,
    };
    a.signature = signAttestationBody(once, RFC_SECRET);
    expect(verify(a)).toEqual({
      status: 'invalid',
      issues: ['attestation kind not supported: timestamp', 'attestation not about this proof'],
    });
    expect(reads()).toBe(1);
  });
});

describe('a subject whose members cannot all be read, shared with the claims', () => {
  it('a member that throws, other than proofDigest: one read, one issue', () => {
    let reads = 0;
    const shared = {
      get keyId(): string {
        reads++;
        throw new Error('boom');
      },
    };
    const a = changed((copy) => {
      copy.kind = 'timestamp';
    });
    a.subject = shared;
    a.claims = { s: shared };
    expect(verify(a)).toEqual(invalid(['/subject/keyId could not be read: boom']));
    expect(reads).toBe(1);
  });

  it('a subject with no known member is not marked: a closed object, named once', () => {
    const a = changed((copy) => {
      copy.kind = 'timestamp';
    });
    a.subject = { other: 1 };
    a.claims = { s: a.subject };
    expect(verify(a)).toEqual(
      invalid([
        '/subject has an unknown key "other"',
        '/subject must hold exactly one of proofDigest and keyId',
      ]),
    );
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

  it('each trusted key is read once, every one of them (a broken anchor is never ignored)', () => {
    const keys = { reviewer: RFC_PUBLIC, other: RFC_PUBLIC };
    const reads = new Map<PropertyKey, number>();
    const proxy = new Proxy(keys, {
      get(target, key, receiver) {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(verify(COSIGNATURE, proxy).status).toBe('authentic');
    expect(Object.fromEntries(reads)).toEqual({ reviewer: 1, other: 1 });
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
    expect([digest.code, digest.message]).toEqual([
      'INVALID_ATTESTATION',
      'proofDigest must be 64 lowercase hex characters',
    ]);
  });
});
