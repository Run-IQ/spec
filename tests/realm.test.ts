import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  computeRuleChecksum,
  isEffectiveAt,
  normalizeRuleDefinition,
} from '../src/index.js';

const nonSerializable = expect.objectContaining({ code: 'NON_SERIALIZABLE' });

const base = {
  id: 'r1',
  version: 1,
  model: 'PERCENTAGE',
  params: { rate: 0.05, base: 'orderTotal' },
  priority: 1,
  effectiveFrom: '2025-01-01',
};

/** Values built in another realm (another global object), as a vm context or iframe gives. */
const foreign = {
  date: (iso: string): Date => runInNewContext(`new Date(${JSON.stringify(iso)})`) as Date,
  object: (): Record<string, unknown> =>
    runInNewContext('({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })') as Record<
      string,
      unknown
    >,
};

describe('Date from another realm (item 4)', () => {
  it('is not an instance of this realm Date', () => {
    expect(foreign.date('2025-01-01T00:00:00Z') instanceof Date).toBe(false);
  });

  it('canonicalize writes it as its ISO string', () => {
    expect(canonicalize({ d: foreign.date('2025-01-01T00:00:00Z') })).toBe(
      '{"d":"2025-01-01T00:00:00.000Z"}',
    );
  });

  it('canonicalize rejects an invalid one', () => {
    expect(() => canonicalize(foreign.date('nope'))).toThrow(nonSerializable);
  });

  it('normalize accepts it for effectiveFrom and effectiveUntil, same checksum', () => {
    const rule = {
      ...base,
      effectiveFrom: foreign.date('2025-01-01T00:00:00Z'),
      effectiveUntil: foreign.date('2026-01-01T00:00:00Z'),
    };
    expect(normalizeRuleDefinition(rule).effectiveFrom).toBe('2025-01-01T00:00:00.000Z');
    expect(computeRuleChecksum(rule)).toBe(
      computeRuleChecksum({ ...base, effectiveUntil: '2026-01-01' }),
    );
  });

  it('normalize rejects an invalid one with INVALID_DATE', () => {
    expect(() => normalizeRuleDefinition({ ...base, effectiveFrom: foreign.date('nope') })).toThrow(
      expect.objectContaining({ code: 'INVALID_DATE' }),
    );
  });

  it('isEffectiveAt accepts it as bound and as at', () => {
    const rule = { effectiveFrom: foreign.date('2025-01-01T00:00:00Z') };
    expect(isEffectiveAt(rule, foreign.date('2025-01-01T00:00:00Z'))).toBe(true);
  });

  it('a fake Date (Symbol.toStringTag) is not taken for a Date', () => {
    const fake = { [Symbol.toStringTag]: 'Date', toISOString: () => '2025-01-01T00:00:00.000Z' };
    expect(() =>
      normalizeRuleDefinition({ ...base, effectiveFrom: fake as unknown as Date }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_DATE' }));
  });
});

describe('plain objects (item 5)', () => {
  it('accepts a plain object from another realm', () => {
    expect(canonicalize(foreign.object())).toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(computeRuleChecksum({ ...base, params: foreign.object() })).toBe(
      computeRuleChecksum({ ...base, params: { a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 } }),
    );
  });

  it('accepts an array from another realm', () => {
    expect(canonicalize(runInNewContext('[3, 1, 2]'))).toBe('[3,1,2]');
  });

  it('rejects an object whose prototype is a null-prototype object with data', () => {
    const proto = Object.create(null) as Record<string, unknown>;
    proto.inherited = 1;
    const child = Object.create(proto) as Record<string, unknown>;
    child.own = 2;
    expect(() => canonicalize(child)).toThrow(nonSerializable);
    expect(() => canonicalize({ params: child })).toThrow(nonSerializable);
  });

  it('rejects an object whose prototype is an empty null-prototype object', () => {
    const child = Object.create(Object.create(null) as object) as Record<string, unknown>;
    child.own = 2;
    expect(() => canonicalize(child)).toThrow(nonSerializable);
  });

  it('rejects such an object as a rule definition', () => {
    const proto = Object.create(null) as Record<string, unknown>;
    proto.params = { rate: 1 };
    const rule = Object.assign(Object.create(proto) as object, { ...base });
    expect(() => normalizeRuleDefinition(rule as typeof base)).toThrow(
      expect.objectContaining({ code: 'INVALID_RULE' }),
    );
  });

  it('still accepts {} literals and Object.create(null)', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.a = 1;
    expect(canonicalize({ x: bare })).toBe('{"x":{"a":1}}');
  });
});
