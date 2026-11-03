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
  it('instants équivalents, même checksum', () => {
    const instant = { ...base, effectiveFrom: '2025-01-01T00:00:00.000Z' };
    const h = computeRuleChecksum(instant);
    expect(computeRuleChecksum({ ...base, effectiveFrom: new Date('2025-01-01T00:00:00Z') })).toBe(
      h,
    );
    expect(computeRuleChecksum({ ...base, effectiveFrom: '2025-01-01T00:00:00Z' })).toBe(h);
    expect(computeRuleChecksum({ ...base, effectiveFrom: '2025-01-01T01:00:00+01:00' })).toBe(h);
    expect(computeRuleChecksum({ ...base, effectiveFrom: '2024-12-31T19:00:00-05:00' })).toBe(h);
  });

  it('une date civile reste civile : checksum différent de celui de son minuit UTC (D-13)', () => {
    expect(computeRuleChecksum(base)).not.toBe(
      computeRuleChecksum({ ...base, effectiveFrom: '2025-01-01T00:00:00.000Z' }),
    );
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
    expect(computeRuleChecksum({ ...base, extensions: { jurisdiction: 'NATIONAL' } })).not.toBe(
      computeRuleChecksum({ ...base, extensions: { jurisdiction: 'REGIONAL' } }),
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
    // D-13: '2025-01-01' stays civil, so this checksum changed with Task 9D.
    expect(computeRuleChecksum(base)).toMatchInlineSnapshot(
      `"9e0794daa99ac486a3deb903c5e21b5a6cf45303aa69f42c997b32e48bb718f3"`,
    );
  });

  it("valeur de référence d'une borne instant, inchangée depuis avant D-13", () => {
    // The value `base` had when '2025-01-01' was read as UTC midnight.
    expect(computeRuleChecksum({ ...base, effectiveFrom: '2025-01-01T00:00:00.000Z' })).toBe(
      'fe6cf3c88e0ee9a78cb98aec238999209d82ee44c4ee7b0c0ed69e334e0bca99',
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

  it('forEach and ruleSet enter the checksum (Task 9F)', () => {
    const h = computeRuleChecksum(base);
    const forEach = { path: '/enfants', key: 'id' };
    expect(computeRuleChecksum({ ...base, forEach })).not.toBe(h);
    expect(computeRuleChecksum({ ...base, ruleSet: 'rgpd' })).not.toBe(h);
    expect(computeRuleChecksum({ ...base, forEach: undefined, ruleSet: 'local' })).toBe(h);
  });

  it('valeur de référence figée avec forEach et ruleSet (Task 9F)', () => {
    // sha256 of the JCS text, computed outside the library:
    // {"dimensions":{},"effectiveFrom":"2025-01-01","effectiveUntil":null,"forEach":{"key":"id",
    // "orderBy":[{"dir":"asc","path":"/naissance","type":"date"}],"path":"/foyers/*/personnes"},
    // "id":"r1","model":"PERCENTAGE","params":{"base":"orderTotal","rate":0.05},"priority":1,
    // "ruleSet":"rgpd","tags":[],"version":1}
    const rule = {
      ...base,
      ruleSet: 'rgpd',
      forEach: {
        path: '/foyers/*/personnes',
        key: ['id', 'id'],
        orderBy: [{ path: '/naissance', type: 'date', dir: 'asc' }],
        dimensions: {},
      },
    };
    expect(computeRuleChecksum(rule)).toBe(
      '984d250df0ba2f16a2a89b0ca5f7681de259bee370a58bf179163718909c6da1',
    );
  });

  it('forEach, ruleSet, timeZone and effectiveOn are no longer extensions', () => {
    for (const [field, value] of [
      ['forEach', 'any extension value'],
      ['ruleSet', { any: 'extension value' }],
      ['timeZone', 'any extension value'],
      ['effectiveOn', 'any extension value'],
    ] as const) {
      expect(() => computeRuleChecksum({ ...base, [field]: value })).toThrow(
        expect.objectContaining({ code: 'INVALID_RULE' }),
      );
    }
  });

  it('is a 64-character lowercase sha256 hex string', () => {
    expect(computeRuleChecksum(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyRuleChecksum', () => {
  it('accepts a rule sealed with its own checksum, however its dates are written', () => {
    const checksum = computeRuleChecksum(base);
    expect(verifyRuleChecksum({ ...base, checksum })).toBe(true);
    const instant = computeRuleChecksum({ ...base, effectiveFrom: '2025-01-01T00:00:00Z' });
    expect(
      verifyRuleChecksum({
        ...base,
        effectiveFrom: new Date('2025-01-01T00:00:00Z'),
        checksum: instant,
      }),
    ).toBe(true);
    expect(
      verifyRuleChecksum({ ...base, effectiveFrom: new Date('2025-01-01T00:00:00Z'), checksum }),
    ).toBe(false);
  });

  it('compares exact lowercase hex: an uppercase copy does not match', () => {
    const checksum = computeRuleChecksum(base);
    expect(verifyRuleChecksum({ ...base, checksum: checksum.toUpperCase() })).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 123],
    ['an object', { value: 'x' }],
  ])('throws INVALID_RULE when checksum is %s', (_label, checksum) => {
    expect(() =>
      verifyRuleChecksum({ ...base, checksum } as unknown as Parameters<
        typeof verifyRuleChecksum
      >[0]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_RULE' }));
  });

  it('refuses a tampered rule', () => {
    const checksum = computeRuleChecksum(base);
    expect(
      verifyRuleChecksum({ ...base, params: { rate: 0.5, base: 'orderTotal' }, checksum }),
    ).toBe(false);
    expect(verifyRuleChecksum({ ...base, checksum: 'x' })).toBe(false);
  });
});
