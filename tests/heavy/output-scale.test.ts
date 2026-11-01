import { describe, expect, it } from 'vitest';
import {
  normalizeOutputDeclaration,
  validateOutputDeclaration,
  valueMatchesOutputType,
} from '../../src/index.js';
import type { OutputDeclaration } from '../../src/index.js';
import { lastValuesSpent, MAX_JSON_VALUES } from '../../src/values.js';
import { specError } from '../helpers.js';

/** An enum declaration with `n` distinct values: 3 members, then the `n` items of the list. */
function enumWith(n: number): OutputDeclaration {
  const values = Array.from({ length: n }, (_, i) => `v${i}`);
  return { type: 'enum', combine: 'max', values };
}

describe(`output declarations: the boundary of ${MAX_JSON_VALUES} values`, () => {
  it('validate, normalize and valueMatchesOutputType agree at 10M and 10M + 1 values', () => {
    const fits = enumWith(MAX_JSON_VALUES - 3);
    expect(validateOutputDeclaration(fits)).toEqual([]);
    expect(lastValuesSpent()).toBe(MAX_JSON_VALUES);
    expect(normalizeOutputDeclaration(fits).values).toHaveLength(MAX_JSON_VALUES - 3);
    expect(valueMatchesOutputType(`v${MAX_JSON_VALUES - 4}`, fits)).toBe(true);
    expect(lastValuesSpent()).toBe(MAX_JSON_VALUES);

    fits.values?.push('one more');
    const tooLarge = 'output.values is too large: more than 10000000 values';
    expect(validateOutputDeclaration(fits)).toEqual([{ path: 'output.values', message: tooLarge }]);
    for (const call of [
      () => normalizeOutputDeclaration(fits),
      () => valueMatchesOutputType('v0', fits),
    ]) {
      expect(specError(call)).toMatchObject({
        code: 'INVALID_RULE',
        message: `invalid output declaration: ${tooLarge}`,
        path: 'output.values',
      });
    }
  }, 120_000);
});
