import { describe, expect, it } from 'vitest';
import { createAttestation, verifyAttestation } from '../../src/index.js';
import { MAX_JSON_VALUES } from '../../src/values.js';
import { RFC_PUBLIC, RFC_SECRET, signed } from '../proof-cases.js';

const DIGEST = signed().digest;
const TRUSTED = { reviewer: RFC_PUBLIC };
const verify = (a: unknown): ReturnType<typeof verifyAttestation> =>
  verifyAttestation(a, DIGEST, TRUSTED);
const invalid = (issues: string[]): ReturnType<typeof verifyAttestation> => ({
  status: 'invalid',
  issues,
});

describe('verifyAttestation at the value budget', () => {
  it('an object of more keys than the budget is refused before any is read', () => {
    let reads = 0;
    const keys = Array.from({ length: MAX_JSON_VALUES + 1 }, (_, i) => `k${i}`);
    const wide = new Proxy(
      {},
      {
        ownKeys: () => keys,
        getOwnPropertyDescriptor: () => ({ value: 1, enumerable: true, configurable: true }),
        get: () => {
          reads += 1;
          return 1;
        },
      },
    );
    expect(verify(wide)).toEqual(
      invalid([`attestation is too large: more than ${MAX_JSON_VALUES} values`]),
    );
    expect(reads).toBe(0);
  }, 60_000);

  it('a role of 2^29 - 24 code units: too long to sign, named, never thrown', () => {
    const role = 'r'.repeat(2 ** 29 - 24);
    const error = (() => {
      try {
        createAttestation(DIGEST, RFC_SECRET, 'reviewer', { role, at: '2026-11-01T10:00:00.000Z' });
      } catch (e) {
        return e as { code: string; message: string };
      }
      return undefined;
    })();
    expect(error?.code).toBe('INVALID_ATTESTATION');
    expect(error?.message).toMatch(/^Cannot attest: .*too long to write as one string$/);
    const a = createAttestation(DIGEST, RFC_SECRET, 'reviewer', { at: '2026-11-01T10:00:00.000Z' });
    const result = verify({ ...a, role });
    expect(result.status).toBe('invalid');
    expect(result.issues).toEqual([
      expect.stringMatching(/^attestation too long to verify: .*too long to write as one string$/),
    ]);
  }, 120_000);
});
