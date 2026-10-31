import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  normalizeRuleDefinition,
  validateRuleDefinition,
} from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';
import { REFUSED_DIMENSIONS } from './dimension-cases.js';
import { specError } from './helpers.js';

const base = {
  id: 'r1',
  version: 1,
  model: 'FLAT',
  params: { amount: 10 },
  priority: 1,
  effectiveFrom: '2025-01-01',
};

/** A rule whose dimension `pays` is `spec`, typed loosely so refused shapes can be written. */
function withPays(spec: unknown): RuleDefinitionInput {
  return { ...base, dimensions: { pays: spec } } as unknown as RuleDefinitionInput;
}

describe('dimension specs: normal form and checksum', () => {
  it('writes a lone anyOf value as the value itself', () => {
    expect(normalizeRuleDefinition(withPays({ anyOf: ['FR'] })).dimensions).toEqual({
      pays: 'FR',
    });
    expect(computeRuleChecksum(withPays({ anyOf: ['FR'] }))).toBe(
      computeRuleChecksum(withPays('FR')),
    );
  });

  it('sorts and deduplicates anyOf, drops an empty except and match any', () => {
    const written = { ref: 'ue', anyOf: ['UE', 'NO', 'UE'], except: [], match: 'any' };
    expect(normalizeRuleDefinition(withPays(written)).dimensions).toEqual({
      pays: { ref: 'ue', anyOf: ['NO', 'UE'] },
    });
  });

  it('gives the same checksum whatever the written order', () => {
    const checksums = [
      { ref: 'ue', anyOf: ['UE', 'NO', 'UE'], except: [], match: 'any' },
      { ref: 'ue', anyOf: ['NO', 'UE'] },
      { anyOf: ['UE', 'NO'], ref: 'ue', match: 'any' },
    ].map((spec) => computeRuleChecksum(withPays(spec)));
    expect(new Set(checksums).size).toBe(1);
  });

  it('sorts and deduplicates except', () => {
    const written = { ref: 'ue', anyOf: ['MONDE'], except: ['UE', 'DK', 'UE'] };
    expect(normalizeRuleDefinition(withPays(written)).dimensions).toEqual({
      pays: { ref: 'ue', anyOf: ['MONDE'], except: ['DK', 'UE'] },
    });
  });

  it("keeps match: 'all', even on a single value", () => {
    expect(normalizeRuleDefinition(withPays({ anyOf: ['FR'], match: 'all' })).dimensions).toEqual({
      pays: { anyOf: ['FR'], match: 'all' },
    });
    expect(computeRuleChecksum(withPays({ anyOf: ['FR'], match: 'all' }))).not.toBe(
      computeRuleChecksum(withPays('FR')),
    );
  });

  it('keeps a lone value with ref as an object: it names a referential', () => {
    expect(normalizeRuleDefinition(withPays({ ref: 'ue', anyOf: ['UE'] })).dimensions).toEqual({
      pays: { ref: 'ue', anyOf: ['UE'] },
    });
  });

  it('keeps several values without ref, sorted', () => {
    expect(normalizeRuleDefinition(withPays({ anyOf: ['FR', 'DE'] })).dimensions).toEqual({
      pays: { anyOf: ['DE', 'FR'] },
    });
  });

  it('accepts a qualified value', () => {
    expect(validateRuleDefinition(withPays('nace-2.1:62.10')).valid).toBe(true);
    expect(normalizeRuleDefinition(withPays({ anyOf: ['nace-2.1:62.10'] })).dimensions).toEqual({
      pays: 'nace-2.1:62.10',
    });
    expect(validateRuleDefinition(withPays('a:b:c')).valid).toBe(true);
  });

  it('keeps the checksum of a rule with text dimensions (pinned at ca5f1c2, before 9E)', () => {
    const rule = { ...base, dimensions: { pays: 'FR', regime: 'nace-2.1:62.10' } };
    expect(computeRuleChecksum(rule)).toBe(
      '40e19d89faeb888a7ca67e8af47e1221e61f4697635cd95c7cc97e42cd4ae961',
    );
  });

  it('never shares a list with the input', () => {
    const anyOf = ['UE', 'NO'];
    const def = normalizeRuleDefinition(withPays({ ref: 'ue', anyOf }));
    anyOf.push('XX');
    expect(def.dimensions).toEqual({ pays: { ref: 'ue', anyOf: ['NO', 'UE'] } });
  });
});

describe('dimension specs: refused', () => {
  it.each(REFUSED_DIMENSIONS)('refuses %s', (_label, spec, path, message) => {
    const result = validateRuleDefinition(withPays(spec));
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toEqual({ path, message });
    const error = specError(() => normalizeRuleDefinition(withPays(spec)));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe(message);
  });

  it('reports every problem of one spec', () => {
    const spec = { ref: '', anyOf: [], match: 'x', extra: 1 };
    expect(validateRuleDefinition(withPays(spec)).issues).toEqual([
      { path: 'dimensions.pays.extra', message: 'dimensions.pays has an unknown key "extra"' },
      { path: 'dimensions.pays.ref', message: 'dimensions.pays.ref must be a non-empty string' },
      {
        path: 'dimensions.pays.anyOf',
        message: 'dimensions.pays.anyOf must list at least one value',
      },
      { path: 'dimensions.pays.match', message: 'dimensions.pays.match must be "any" or "all"' },
    ]);
  });

  it('refuses a lone surrogate inside a spec as INVALID_RULE', () => {
    const spec = { ref: 'ue', anyOf: ['UE', 'D\uD800'] };
    const message = 'dimensions.pays.anyOf[1] contains a lone UTF-16 surrogate';
    expect(validateRuleDefinition(withPays(spec)).issues).toEqual([
      { path: 'dimensions.pays.anyOf[1]', message },
    ]);
    expect(specError(() => normalizeRuleDefinition(withPays(spec))).message).toBe(message);
  });

  it('names a spec that cannot be read, without throwing', () => {
    const spec = {
      get anyOf(): never {
        throw new Error('boom');
      },
    };
    const message = 'dimensions.pays could not be read: boom';
    expect(validateRuleDefinition(withPays(spec)).issues).toEqual([
      { path: 'dimensions.pays', message },
    ]);
    expect(specError(() => normalizeRuleDefinition(withPays(spec))).message).toBe(message);
  });

  it('reads each property of a spec once', () => {
    let reads = 0;
    const spec = {
      get anyOf(): string[] {
        reads++;
        return reads === 1 ? ['FR'] : [];
      },
    };
    expect(normalizeRuleDefinition(withPays(spec)).dimensions).toEqual({ pays: 'FR' });
    expect(reads).toBe(1);
  });

  it('keeps a null dimension as unset', () => {
    const rule = { ...base, dimensions: { pays: null, regime: { anyOf: ['A'] } } };
    expect(normalizeRuleDefinition(rule as unknown as RuleDefinitionInput).dimensions).toEqual({
      regime: 'A',
    });
  });
});
