import { describe, expect, it } from 'vitest';
import { isEffectiveAt } from '../src/index.js';

const from = '2025-01-01';
const until = '2026-01-01';

describe('isEffectiveAt: half-open window [from, until)', () => {
  it('at equal to from is effective', () => {
    expect(
      isEffectiveAt(
        { effectiveFrom: from, effectiveUntil: until },
        new Date('2025-01-01T00:00:00Z'),
      ),
    ).toBe(true);
  });

  it('at equal to until is not effective', () => {
    expect(
      isEffectiveAt(
        { effectiveFrom: from, effectiveUntil: until },
        new Date('2026-01-01T00:00:00Z'),
      ),
    ).toBe(false);
  });

  it('a null until is open-ended', () => {
    expect(
      isEffectiveAt(
        { effectiveFrom: from, effectiveUntil: null },
        new Date('2999-01-01T00:00:00Z'),
      ),
    ).toBe(true);
  });

  it('an absent or undefined until is open-ended', () => {
    expect(isEffectiveAt({ effectiveFrom: from }, new Date('2999-01-01T00:00:00Z'))).toBe(true);
    expect(
      isEffectiveAt(
        { effectiveFrom: from, effectiveUntil: undefined },
        new Date('2999-01-01T00:00:00Z'),
      ),
    ).toBe(true);
  });

  it('one millisecond before from is not effective', () => {
    expect(
      isEffectiveAt(
        { effectiveFrom: from, effectiveUntil: until },
        new Date('2024-12-31T23:59:59.999Z'),
      ),
    ).toBe(false);
  });

  it('one millisecond before until is effective', () => {
    expect(
      isEffectiveAt(
        { effectiveFrom: from, effectiveUntil: until },
        new Date('2025-12-31T23:59:59.999Z'),
      ),
    ).toBe(true);
  });

  it('accepts Date bounds and offset date-times', () => {
    const rule = {
      effectiveFrom: new Date('2025-01-01T00:00:00Z'),
      effectiveUntil: '2025-01-01T02:00:00+01:00',
    };
    expect(isEffectiveAt(rule, new Date('2025-01-01T00:59:59.999Z'))).toBe(true);
    expect(isEffectiveAt(rule, new Date('2025-01-01T01:00:00Z'))).toBe(false);
  });

  it('a successor starting when the predecessor ends leaves no gap and no overlap', () => {
    const old = { effectiveFrom: '2024-01-01', effectiveUntil: '2025-01-01' };
    const next = { effectiveFrom: '2025-01-01', effectiveUntil: null };
    const at = new Date('2025-01-01T00:00:00Z');
    expect(isEffectiveAt(old, at)).toBe(false);
    expect(isEffectiveAt(next, at)).toBe(true);
  });

  it('rejects invalid dates', () => {
    const invalidDate = expect.objectContaining({ code: 'INVALID_DATE' });
    expect(() => isEffectiveAt({ effectiveFrom: '2025-01-01T00:00' }, new Date())).toThrow(
      invalidDate,
    );
    expect(() => isEffectiveAt({ effectiveFrom: from, effectiveUntil: 'x' }, new Date())).toThrow(
      invalidDate,
    );
    expect(() => isEffectiveAt({ effectiveFrom: from }, new Date('x'))).toThrow(invalidDate);
  });
});
