import { describe, expect, it } from 'vitest';
import { computeRuleChecksum, computeRuleFingerprint } from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';

/** Copy of `obj` without `key` (as if the property had never been written). */
function without(obj: object, key: string): RuleDefinitionInput {
  const copy: Record<string, unknown> = { ...obj };
  delete copy[key];
  return copy as RuleDefinitionInput;
}

/** A rule with nested objects everywhere, so key order can be shuffled at every depth. */
const rich: RuleDefinitionInput = {
  id: 'vat-standard',
  version: 3,
  model: 'PROGRESSIVE_BRACKET',
  params: {
    base: 'income',
    brackets: [
      { from: 0, to: 1000, rate: 0, meta: { label: 'zero', band: 1 } },
      { from: 1000, to: null, rate: 0.1, meta: { label: 'ten', band: 2 } },
    ],
    rounding: { mode: 'HALF_UP', scale: 2, options: { currency: 'XOF', strict: true } },
  },
  condition: {
    dsl: 'jsonlogic',
    value: { and: [{ '>': [{ var: 'income' }, 0] }], meta: { origin: 'law', article: 12 } },
  },
  priority: 100,
  effectiveFrom: '2025-01-01',
  effectiveUntil: '2026-01-01',
  output: 'vat',
  dimensions: { country: 'TG', category: 'VAT', regime: 'normal' },
  tags: ['fiscal', 'vat'],
  dominanceGroup: 'VAT',
  exceptions: [
    {
      kind: 'substitute',
      targets: { tags: ['vat', 'fiscal'], dimensions: { country: 'TG', regime: 'normal' } },
      params: { rate: 0.1, scope: { kind: 'all', level: 1 } },
    },
  ],
  sourceRef: 'CGI art. 12',
  jurisdiction: 'NATIONAL',
  extra: { owner: { team: 'tax', contact: { email: 'a@b.c', phone: null } }, flags: [1, 2] },
};

/** Rebuilds a value with every object's keys in reverse order, at every depth. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    );
  }
  return value;
}

/** Rebuilds a value with every object's keys in a seeded pseudo-random order, at every depth. */
function shuffleKeys(value: unknown, seed: number): unknown {
  let s = seed;
  const next = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const entries = Object.entries(v);
      for (let i = entries.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [entries[i], entries[j]] = [entries[j]!, entries[i]!];
      }
      return Object.fromEntries(entries.map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value);
}

const fp = computeRuleFingerprint;
const cs = computeRuleChecksum;

describe('computeRuleFingerprint: same data, same fingerprint', () => {
  describe('key order at every depth', () => {
    it('reversed keys everywhere', () => {
      const reversed = reverseKeys(rich) as RuleDefinitionInput;
      expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(rich));
      expect(fp(reversed)).toBe(fp(rich));
      expect(cs(reversed)).toBe(cs(rich));
    });

    it.each([1, 2, 3, 42, 1337, 2024, 99999])('shuffled keys everywhere (seed %i)', (seed) => {
      const shuffled = shuffleKeys(rich, seed) as RuleDefinitionInput;
      expect(fp(shuffled)).toBe(fp(rich));
      expect(cs(shuffled)).toBe(cs(rich));
    });

    it('top-level keys only', () => {
      const top = Object.fromEntries(Object.entries(rich).reverse()) as RuleDefinitionInput;
      expect(fp(top)).toBe(fp(rich));
    });

    it('params, including objects inside arrays', () => {
      expect(
        fp({
          ...rich,
          params: {
            rounding: { options: { strict: true, currency: 'XOF' }, scale: 2, mode: 'HALF_UP' },
            brackets: [
              { meta: { band: 1, label: 'zero' }, rate: 0, to: 1000, from: 0 },
              { meta: { band: 2, label: 'ten' }, rate: 0.1, to: null, from: 1000 },
            ],
            base: 'income',
          },
        }),
      ).toBe(fp(rich));
    });

    it('condition and condition.value', () => {
      expect(
        fp({
          ...rich,
          condition: {
            value: { meta: { article: 12, origin: 'law' }, and: [{ '>': [{ var: 'income' }, 0] }] },
            dsl: 'jsonlogic',
          },
        }),
      ).toBe(fp(rich));
    });

    it('dimensions', () => {
      expect(
        fp({ ...rich, dimensions: { regime: 'normal', category: 'VAT', country: 'TG' } }),
      ).toBe(fp(rich));
    });

    it('exceptions', () => {
      expect(
        fp({
          ...rich,
          exceptions: [
            {
              params: { scope: { level: 1, kind: 'all' }, rate: 0.1 },
              targets: { dimensions: { regime: 'normal', country: 'TG' }, tags: ['fiscal', 'vat'] },
              kind: 'substitute',
            },
          ],
        }),
      ).toBe(fp(rich));
    });

    it('extensions', () => {
      expect(
        fp({
          ...rich,
          extra: {
            flags: [1, 2],
            owner: { contact: { phone: null, email: 'a@b.c' }, team: 'tax' },
          },
        }),
      ).toBe(fp(rich));
    });
  });

  describe('defaults absent or explicit', () => {
    const minimal: RuleDefinitionInput = {
      id: 'r1',
      version: 1,
      model: 'FLAT',
      params: { amount: 10 },
      priority: 1,
      effectiveFrom: '2025-01-01',
    };

    it.each([
      ['tags: []', { tags: [] }],
      ['dimensions: {}', { dimensions: {} }],
      ['effectiveUntil: null', { effectiveUntil: null }],
      ['all three', { tags: [], dimensions: {}, effectiveUntil: null }],
    ])('%s', (_label, patch) => {
      expect(fp({ ...minimal, ...patch })).toBe(fp(minimal));
      expect(cs({ ...minimal, ...patch })).toBe(cs(minimal));
    });
  });

  describe('identity and validity window are left out', () => {
    it('different id', () => {
      expect(fp({ ...rich, id: 'other' })).toBe(fp(rich));
    });

    it('different version', () => {
      expect(fp({ ...rich, version: 99 })).toBe(fp(rich));
    });

    it('different effectiveFrom', () => {
      expect(fp({ ...rich, effectiveFrom: '2025-06-15' })).toBe(fp(rich));
      expect(
        fp({ ...rich, effectiveFrom: '2025-06-15T12:00:00+02:00', effectiveUntil: null }),
      ).toBe(fp(rich));
    });

    it('different effectiveUntil, including null and absent', () => {
      expect(fp({ ...rich, effectiveUntil: '2040-01-01' })).toBe(fp(rich));
      expect(fp({ ...rich, effectiveUntil: null })).toBe(fp(rich));
      expect(fp(without(rich, 'effectiveUntil'))).toBe(fp(rich));
    });

    it('all of them at once', () => {
      expect(
        fp({
          ...rich,
          id: 'copy',
          version: 7,
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
          effectiveUntil: null,
        }),
      ).toBe(fp(rich));
    });

    it('same dates written differently', () => {
      expect(
        fp({
          ...rich,
          effectiveFrom: new Date('2025-01-01T00:00:00Z'),
          effectiveUntil: '2026-01-01T00:00:00.000Z',
        }),
      ).toBe(fp(rich));
    });

    it('checksum is left out', () => {
      expect(fp({ ...rich, checksum: 'whatever' })).toBe(fp(rich));
    });
  });

  describe('tags order and duplicates', () => {
    it.each([
      ['reversed', ['vat', 'fiscal']],
      ['duplicated', ['fiscal', 'vat', 'fiscal', 'vat']],
      ['reversed and duplicated', ['vat', 'vat', 'fiscal']],
    ])('%s', (_label, tags) => {
      expect(fp({ ...rich, tags })).toBe(fp(rich));
      expect(cs({ ...rich, tags })).toBe(cs(rich));
    });

    it('readonly tags are accepted', () => {
      const tags = ['vat', 'fiscal'] as const;
      expect(fp({ ...rich, tags })).toBe(fp(rich));
    });
  });

  describe('undefined property or absent property', () => {
    const minimal: RuleDefinitionInput = {
      id: 'r1',
      version: 1,
      model: 'FLAT',
      params: { amount: 10 },
      priority: 1,
      effectiveFrom: '2025-01-01',
    };

    it.each([
      'condition',
      'effectiveUntil',
      'output',
      'dimensions',
      'tags',
      'dominanceGroup',
      'exceptions',
      'sourceRef',
      'checksum',
      'jurisdiction',
    ])('%s: undefined', (key) => {
      const withUndefined = { ...minimal, [key]: undefined } as RuleDefinitionInput;
      expect(fp(withUndefined)).toBe(fp(minimal));
      expect(cs(withUndefined)).toBe(cs(minimal));
    });

    it('undefined inside params, condition.value, exceptions and extensions', () => {
      const withUndefined: RuleDefinitionInput = {
        ...rich,
        params: { ...(rich.params as object), ghost: undefined },
        condition: {
          dsl: 'jsonlogic',
          value: { ...(rich.condition!.value as object), ghost: undefined },
        },
        exceptions: [{ ...(rich.exceptions as object[])[0], ghost: undefined }],
        extra: { ...(rich.extra as object), ghost: undefined },
      };
      expect(fp(withUndefined)).toBe(fp(rich));
      expect(cs(withUndefined)).toBe(cs(rich));
    });
  });

  it('all variations at once', () => {
    const messy = shuffleKeys(
      {
        ...rich,
        id: 'copy',
        version: 12,
        effectiveFrom: new Date('2019-05-05T05:05:05Z'),
        effectiveUntil: undefined,
        tags: ['vat', 'fiscal', 'vat'],
        checksum: 'stale',
        ghost: undefined,
      },
      7,
    ) as RuleDefinitionInput;
    expect(fp(messy)).toBe(fp(rich));
  });
});

describe('computeRuleFingerprint: different content, different fingerprint', () => {
  const ref = fp(rich);

  it('a param value changes', () => {
    expect(fp({ ...rich, params: { ...(rich.params as object), base: 'revenue' } })).not.toBe(ref);
  });

  it('a nested param value changes', () => {
    expect(
      fp({
        ...rich,
        params: {
          ...(rich.params as object),
          rounding: { mode: 'HALF_UP', scale: 3, options: { currency: 'XOF', strict: true } },
        },
      }),
    ).not.toBe(ref);
  });

  it('a param is added', () => {
    expect(fp({ ...rich, params: { ...(rich.params as object), cap: 10 } })).not.toBe(ref);
  });

  it('the model changes', () => {
    expect(fp({ ...rich, model: 'FLAT_RATE' })).not.toBe(ref);
  });

  it('an extension value changes', () => {
    expect(fp({ ...rich, jurisdiction: 'REGIONAL' })).not.toBe(ref);
  });

  it('a nested extension value changes', () => {
    expect(
      fp({
        ...rich,
        extra: { owner: { team: 'ops', contact: { email: 'a@b.c', phone: null } }, flags: [1, 2] },
      }),
    ).not.toBe(ref);
  });

  it('an extension is added or removed', () => {
    expect(fp({ ...rich, schemaVersion: 2 })).not.toBe(ref);
    expect(fp(without(rich, 'jurisdiction'))).not.toBe(ref);
  });

  it('the condition value changes', () => {
    expect(
      fp({ ...rich, condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'income' }, 1] } } }),
    ).not.toBe(ref);
  });

  it('the condition dsl changes', () => {
    expect(fp({ ...rich, condition: { dsl: 'other', value: rich.condition!.value } })).not.toBe(
      ref,
    );
  });

  it('the condition is removed', () => {
    expect(fp({ ...rich, condition: undefined })).not.toBe(ref);
  });

  it('array order inside params changes', () => {
    const brackets = (rich.params as { brackets: unknown[] }).brackets;
    expect(
      fp({ ...rich, params: { ...(rich.params as object), brackets: [...brackets].reverse() } }),
    ).not.toBe(ref);
  });

  it('array order inside an extension changes', () => {
    expect(fp({ ...rich, extra: { ...(rich.extra as object), flags: [2, 1] } })).not.toBe(ref);
  });

  it.each([
    ['priority', { priority: 101 }],
    ['output', { output: 'vat2' }],
    ['a dimension value', { dimensions: { country: 'BJ', category: 'VAT', regime: 'normal' } }],
    [
      'a dimension added',
      { dimensions: { country: 'TG', category: 'VAT', regime: 'normal', x: 'y' } },
    ],
    ['a tag added', { tags: ['fiscal', 'vat', 'new'] }],
    ['a tag removed', { tags: ['fiscal'] }],
    ['dominanceGroup', { dominanceGroup: 'OTHER' }],
    [
      'an exception parameter',
      {
        exceptions: [
          {
            kind: 'substitute',
            targets: { tags: ['vat', 'fiscal'], dimensions: { country: 'TG', regime: 'normal' } },
            params: { rate: 0.2, scope: { kind: 'all', level: 1 } },
          },
        ],
      },
    ],
    [
      'an exception target',
      {
        exceptions: [
          {
            kind: 'substitute',
            targets: { tags: ['vat'], dimensions: { country: 'TG', regime: 'normal' } },
            params: { rate: 0.1, scope: { kind: 'all', level: 1 } },
          },
        ],
      },
    ],
    ['sourceRef', { sourceRef: 'CGI art. 13' }],
  ])('%s changes', (_label, patch) => {
    expect(fp({ ...rich, ...patch } as RuleDefinitionInput)).not.toBe(ref);
  });

  it('a string and a number with the same digits differ', () => {
    expect(fp({ ...rich, priority: 1, params: { v: 1 } })).not.toBe(
      fp({ ...rich, priority: 1, params: { v: '1' } }),
    );
  });
});

describe('computeRuleFingerprint vs checksum', () => {
  it('is a sha256 hex string distinct from the checksum', () => {
    expect(fp(rich)).toMatch(/^[0-9a-f]{64}$/);
    expect(fp(rich)).not.toBe(cs(rich));
  });

  it('copies of a rule under another id and window share the fingerprint, not the checksum', () => {
    const copy = {
      ...rich,
      id: 'copy',
      version: 1,
      effectiveFrom: '2027-01-01',
      effectiveUntil: null,
    };
    expect(fp(copy)).toBe(fp(rich));
    expect(cs(copy)).not.toBe(cs(rich));
  });

  it('applies the same validation as the checksum', () => {
    expect(() => fp({ ...rich, params: { rate: NaN } })).toThrow(
      expect.objectContaining({ code: 'NON_SERIALIZABLE' }),
    );
    expect(() => fp({ ...rich, effectiveFrom: '2025-01-01T00:00' })).toThrow(
      expect.objectContaining({ code: 'INVALID_DATE' }),
    );
  });
});
