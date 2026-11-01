import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import { joinStatus, OUTPUT_STATUSES } from '../src/index.js';
import type { OutputStatus } from '../src/index.js';
import { loose, specError } from './helpers.js';

describe('output statuses (D-7)', () => {
  it('lists the four statuses from the weakest to the strongest', () => {
    expect(OUTPUT_STATUSES).toEqual(['determined', 'provisional', 'conflict', 'undetermined']);
  });

  it('cannot be changed by a caller', () => {
    expect(Object.isFrozen(OUTPUT_STATUSES)).toBe(true);
  });

  it('joinStatus gives the stronger of each of the 16 pairs', () => {
    const table = OUTPUT_STATUSES.map((a) => OUTPUT_STATUSES.map((b) => joinStatus(a, b)));
    expect(table).toEqual([
      ['determined', 'provisional', 'conflict', 'undetermined'],
      ['provisional', 'provisional', 'conflict', 'undetermined'],
      ['conflict', 'conflict', 'conflict', 'undetermined'],
      ['undetermined', 'undetermined', 'undetermined', 'undetermined'],
    ]);
  });

  it('refuses anything that is not a status, on either side', () => {
    const cases: [unknown, string][] = [
      ['final', '"final"'],
      ['', '""'],
      [null, 'a value of type null'],
      [2, 'a value of type number'],
    ];
    for (const [value, cited] of cases) {
      for (const call of [
        () => joinStatus(loose<OutputStatus>(value), 'determined'),
        () => joinStatus('determined', loose<OutputStatus>(value)),
      ]) {
        expect(specError(call)).toMatchObject({
          code: 'INVALID_PROOF',
          message:
            `not an output status: ${cited} ` +
            '(expected one of determined, provisional, conflict, undetermined)',
        });
      }
    }
  });

  it('the canonical entry exports the same', () => {
    expect(canonicalEntry.OUTPUT_STATUSES).toBe(OUTPUT_STATUSES);
    expect(canonicalEntry.joinStatus).toBe(joinStatus);
  });
});
