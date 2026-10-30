import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  computeRuleChecksum,
  fromStoredRecord,
  normalizeRuleDefinition,
  SpecError,
  toExecutableRule,
  toStoredPayload,
} from '../src/index.js';
import type { StoredRuleRecord } from '../src/index.js';

const base = {
  id: 'vat-std',
  version: 2,
  model: 'PERCENTAGE',
  params: { rate: 0.05, base: 'orderTotal' },
  condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'orderTotal' }, 0] } },
  priority: 10,
  effectiveFrom: '2025-01-01',
  effectiveUntil: '2026-01-01T00:00:00+01:00',
  dimensions: { country: 'TG' },
  tags: ['vat', 'b2c', 'vat'],
  jurisdiction: 'NATIONAL',
};

function storedRecordOf(input: Parameters<typeof toStoredPayload>[0]): StoredRuleRecord {
  const { payload, checksum } = toStoredPayload(input);
  return { id: input.id, version: input.version, checksum, payload };
}

function thrown(fn: () => unknown): SpecError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SpecError);
    return error as SpecError;
  }
  throw new Error('expected a SpecError');
}

describe('toExecutableRule', () => {
  it('normalizes, turns the dates into Date objects and adds the checksum', () => {
    const rule = toExecutableRule(base);
    expect(rule).toEqual({
      id: 'vat-std',
      version: 2,
      model: 'PERCENTAGE',
      params: { rate: 0.05, base: 'orderTotal' },
      condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'orderTotal' }, 0] } },
      priority: 10,
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      effectiveUntil: new Date('2025-12-31T23:00:00.000Z'),
      dimensions: { country: 'TG' },
      tags: ['b2c', 'vat'],
      jurisdiction: 'NATIONAL',
      checksum: computeRuleChecksum(base),
    });
    expect(rule.effectiveFrom).toBeInstanceOf(Date);
  });

  it('keeps effectiveUntil null for an open-ended rule', () => {
    const rule = toExecutableRule({ ...base, effectiveUntil: null });
    expect(rule.effectiveUntil).toBeNull();
  });

  it('ignores a checksum given in the input and computes its own', () => {
    expect(toExecutableRule({ ...base, checksum: 'stale' }).checksum).toBe(
      computeRuleChecksum(base),
    );
  });

  it('rejects an invalid definition', () => {
    expect(() => toExecutableRule({ ...base, priority: 'high' as unknown as number })).toThrow(
      SpecError,
    );
  });
});

describe('toStoredPayload', () => {
  it('payload is the canonical normalized definition, checksum its sha256', () => {
    const { payload, checksum } = toStoredPayload(base);
    expect(payload).toBe(canonicalize(normalizeRuleDefinition(base)));
    expect(checksum).toBe(computeRuleChecksum(base));
    expect(JSON.parse(payload)).not.toHaveProperty('checksum');
  });
});

describe('round trip', () => {
  it('toExecutableRule -> toStoredPayload -> fromStoredRecord gives an equal rule', () => {
    const rule = toExecutableRule(base);
    const record = storedRecordOf(rule);
    const back = fromStoredRecord(record);
    expect(back).toEqual(rule);
    expect(back.checksum).toBe(rule.checksum);
    expect(record.checksum).toBe(rule.checksum);
  });

  it('round trips an open-ended rule without optional fields', () => {
    const minimal = {
      id: 'r1',
      version: 1,
      model: 'FLAT',
      params: null,
      priority: 0,
      effectiveFrom: '2025-01-01',
    };
    const rule = toExecutableRule(minimal);
    expect(fromStoredRecord(storedRecordOf(rule))).toEqual(rule);
  });
});

describe('fromStoredRecord: errors name the rule and the reason (A7)', () => {
  it('a tampered payload (rate 0.06) fails the checksum', () => {
    const record = storedRecordOf(base);
    const tampered = { ...record, payload: record.payload.replace('0.05', '0.06') };
    expect(tampered.payload).not.toBe(record.payload);
    const error = thrown(() => fromStoredRecord(tampered));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toContain('vat-std@2');
    expect(error.message).toMatch(/checksum mismatch/);
  });

  it('a wrong record checksum fails', () => {
    const record = { ...storedRecordOf(base), checksum: '0'.repeat(64) };
    const error = thrown(() => fromStoredRecord(record));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toMatch(/checksum mismatch/);
  });

  it('bad JSON', () => {
    const record = { ...storedRecordOf(base), payload: '{not json' };
    const error = thrown(() => fromStoredRecord(record));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toContain('vat-std@2');
    expect(error.message).toMatch(/not valid JSON/);
  });

  it('a payload that is not an object', () => {
    const record = { ...storedRecordOf(base), payload: '[1,2]' };
    const error = thrown(() => fromStoredRecord(record));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toMatch(/invalid definition/);
  });

  it('id mismatch between record and payload', () => {
    const record = { ...storedRecordOf(base), id: 'other' };
    const error = thrown(() => fromStoredRecord(record));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toContain('other@2');
    expect(error.message).toMatch(/id\/version mismatch/);
  });

  it('version mismatch between record and payload', () => {
    const record = { ...storedRecordOf(base), version: 3 };
    const error = thrown(() => fromStoredRecord(record));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toContain('vat-std@3');
    expect(error.message).toMatch(/id\/version mismatch/);
  });

  it('an invalid definition is reported as INVALID_RULE, even for a bad date', () => {
    const payload = JSON.stringify({ ...JSON.parse(storedRecordOf(base).payload), priority: 'x' });
    const error = thrown(() =>
      fromStoredRecord({ id: 'vat-std', version: 2, checksum: 'x', payload }),
    );
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toContain('vat-std@2');
    expect(error.message).toMatch(/invalid definition/);

    const badDate = JSON.stringify({
      ...JSON.parse(storedRecordOf(base).payload),
      effectiveFrom: '2025-01-01T00:00',
    });
    const dateError = thrown(() =>
      fromStoredRecord({ id: 'vat-std', version: 2, checksum: 'x', payload: badDate }),
    );
    expect(dateError.code).toBe('INVALID_RULE');
    expect(dateError.message).toMatch(/invalid definition.*effectiveFrom/);
  });

  it('a malformed record', () => {
    for (const record of [
      null,
      { id: 'r', version: 1, checksum: 'x' },
      { id: 'r', version: 1, checksum: 1, payload: '{}' },
      { id: 1, version: 1, checksum: 'x', payload: '{}' },
    ]) {
      expect(thrown(() => fromStoredRecord(record as unknown as StoredRuleRecord)).code).toBe(
        'INVALID_RULE',
      );
    }
  });
});

describe('fromStoredRecord: the payload must be canonical', () => {
  const record = storedRecordOf(base);
  const parsed = JSON.parse(record.payload) as Record<string, unknown>;
  const reversed = Object.fromEntries(Object.entries(parsed).reverse());
  const variants: [string, string][] = [
    ['reordered keys', JSON.stringify(reversed)],
    ['a date-only date', record.payload.replace('2025-01-01T00:00:00.000Z', '2025-01-01')],
    ['unsorted and duplicate tags', record.payload.replace('["b2c","vat"]', '["vat","b2c","vat"]')],
    [
      'an embedded checksum field',
      record.payload.replace('{', `{"checksum":"${record.checksum}",`),
    ],
    ['a null extension', record.payload.replace('{', '{"extra":null,')],
    ['duplicate JSON keys', record.payload.replace('"model":', '"model":"OTHER","model":')],
  ];

  it('a record produced by toStoredPayload passes', () => {
    expect(fromStoredRecord(record).checksum).toBe(record.checksum);
  });

  it.each(variants)('rejects %s, whichever checksum the record holds', (_name, payload) => {
    expect(payload).not.toBe(record.payload);
    // Same content once normalized: only the canonical check can catch it.
    expect(canonicalize(normalizeRuleDefinition(JSON.parse(payload)))).toBe(record.payload);
    for (const checksum of [record.checksum, sha256(payload)]) {
      const error = thrown(() => fromStoredRecord({ ...record, checksum, payload }));
      expect(error.code).toBe('INVALID_RULE');
      expect(error.message).toContain('vat-std@2: payload is not canonical');
    }
  });

  it('the checksum is the sha256 of the stored payload', () => {
    expect(record.checksum).toBe(sha256(record.payload));
  });
});

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
