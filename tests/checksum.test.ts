import { describe, expect, it } from 'vitest';
import { computeRuleChecksum, verifyRuleChecksum } from '../src/index.js';

const base = {
  id: 'r1',
  version: 1,
  model: 'PERCENTAGE',
  params: { rate: 0.05, base: 'orderTotal' },
  priority: 1,
  effectiveFrom: '2025-01-01',
};

describe('computeRuleChecksum', () => {
  it('dates équivalentes, même checksum', () => {
    const h = computeRuleChecksum(base);
    expect(computeRuleChecksum({ ...base, effectiveFrom: new Date('2025-01-01T00:00:00Z') })).toBe(
      h,
    );
    expect(computeRuleChecksum({ ...base, effectiveFrom: '2025-01-01T00:00:00.000Z' })).toBe(h);
    expect(computeRuleChecksum({ ...base, effectiveFrom: '2025-01-01T00:00Z' })).toBe(h);
    expect(computeRuleChecksum({ ...base, effectiveFrom: '2025-01-01T01:00:00+01:00' })).toBe(h);
    expect(computeRuleChecksum({ ...base, effectiveFrom: '2024-12-31T19:00:00-05:00' })).toBe(h);
  });

  it('défauts absents ou explicites, même checksum', () => {
    expect(computeRuleChecksum({ ...base, effectiveUntil: null, tags: [], dimensions: {} })).toBe(
      computeRuleChecksum(base),
    );
  });

  it("l'ordre des clés ne compte pas", () => {
    expect(computeRuleChecksum({ ...base, params: { base: 'orderTotal', rate: 0.05 } })).toBe(
      computeRuleChecksum(base),
    );
  });

  it("un champ d'extension entre dans le checksum", () => {
    expect(computeRuleChecksum({ ...base, jurisdiction: 'NATIONAL' })).not.toBe(
      computeRuleChecksum({ ...base, jurisdiction: 'REGIONAL' }),
    );
  });

  it('le champ checksum est ignoré', () => {
    expect(computeRuleChecksum({ ...base, checksum: 'x' } as never)).toBe(
      computeRuleChecksum(base),
    );
  });

  it('NaN et Infinity sont refusés', () => {
    expect(() => computeRuleChecksum({ ...base, params: { rate: NaN } })).toThrow(
      expect.objectContaining({ code: 'NON_SERIALIZABLE' }),
    );
    expect(() => computeRuleChecksum({ ...base, params: { rate: Infinity } })).toThrow(
      expect.objectContaining({ code: 'NON_SERIALIZABLE' }),
    );
  });

  it('date invalide refusée', () => {
    expect(() => computeRuleChecksum({ ...base, effectiveFrom: 'pas une date' })).toThrow(
      expect.objectContaining({ code: 'INVALID_DATE' }),
    );
  });

  it('valeur de référence figée', () => {
    expect(computeRuleChecksum(base)).toMatchInlineSnapshot(
      `"fe6cf3c88e0ee9a78cb98aec238999209d82ee44c4ee7b0c0ed69e334e0bca99"`,
    );
  });

  it('tags order and duplicates do not change the checksum', () => {
    expect(computeRuleChecksum({ ...base, tags: ['b', 'a', 'b'] })).toBe(
      computeRuleChecksum({ ...base, tags: ['a', 'b'] }),
    );
  });

  it('id, version and dates enter the checksum', () => {
    const h = computeRuleChecksum(base);
    expect(computeRuleChecksum({ ...base, id: 'r2' })).not.toBe(h);
    expect(computeRuleChecksum({ ...base, version: 2 })).not.toBe(h);
    expect(computeRuleChecksum({ ...base, effectiveFrom: '2025-01-02' })).not.toBe(h);
    expect(computeRuleChecksum({ ...base, effectiveUntil: '2026-01-01' })).not.toBe(h);
  });

  it('is a 64-character lowercase sha256 hex string', () => {
    expect(computeRuleChecksum(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyRuleChecksum', () => {
  it('accepts a rule sealed with its own checksum, however its dates are written', () => {
    const checksum = computeRuleChecksum(base);
    expect(verifyRuleChecksum({ ...base, checksum })).toBe(true);
    expect(
      verifyRuleChecksum({ ...base, effectiveFrom: new Date('2025-01-01T00:00:00Z'), checksum }),
    ).toBe(true);
  });

  it('refuses a tampered rule', () => {
    const checksum = computeRuleChecksum(base);
    expect(
      verifyRuleChecksum({ ...base, params: { rate: 0.5, base: 'orderTotal' }, checksum }),
    ).toBe(false);
    expect(verifyRuleChecksum({ ...base, checksum: 'x' })).toBe(false);
  });
});
