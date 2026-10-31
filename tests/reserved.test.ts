import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import { ENGINE_VARIABLES, isReservedName, OUTPUTS_VARIABLE } from '../src/index.js';
import { BASE_RULE, expectRuleRefused } from './helpers.js';

describe('ENGINE_VARIABLES', () => {
  it('lists the engine variables of D-3, in order', () => {
    expect(ENGINE_VARIABLES).toEqual([
      '$outputs',
      '$dates',
      '$dimensions',
      '$item',
      '$index',
      '$params',
      '$selected',
      '$bounds',
      '$parent',
      '$prev',
      '$children',
      '$segment',
      '$group',
      '$ref',
    ]);
    expect(ENGINE_VARIABLES).toContain(OUTPUTS_VARIABLE);
  });

  it('is frozen and every entry is reserved', () => {
    expect(Object.isFrozen(ENGINE_VARIABLES)).toBe(true);
    for (const name of ENGINE_VARIABLES) expect(isReservedName(name)).toBe(true);
  });
});

describe('isReservedName', () => {
  it('reserves every name that starts with "$"', () => {
    expect(isReservedName('$x')).toBe(true);
    expect(isReservedName('$')).toBe(true);
    expect(isReservedName('x$')).toBe(false);
    expect(isReservedName('')).toBe(false);
    expect(isReservedName('outputs')).toBe(false);
  });

  it('is false for anything that is not a string', () => {
    // A JavaScript caller can pass anything; the signature says string.
    const values: unknown[] = [null, 42, ['$x']];
    for (const value of values) expect(isReservedName(value as string)).toBe(false);
  });
});

describe('both entries', () => {
  it('export the reserved names', () => {
    expect(canonicalEntry.ENGINE_VARIABLES).toBe(ENGINE_VARIABLES);
    expect(canonicalEntry.isReservedName).toBe(isReservedName);
  });
});

describe('empty and reserved names in rules (ruling 9G round 2)', () => {
  const DATE_RESERVED = 'date names starting with "$" are reserved';

  it('refuses an empty tag', () => {
    expectRuleRefused(
      { ...BASE_RULE, tags: ['a', ''] },
      'tags[1]',
      'tags[1] must be a non-empty string',
    );
  });

  it('refuses an empty dimension name, even unset', () => {
    for (const value of ['FR', null]) {
      expectRuleRefused(
        { ...BASE_RULE, dimensions: { '': value } },
        'dimensions',
        'dimensions must not have an empty dimension name',
      );
    }
  });

  it('refuses "-" as a dimension name: no pointer can name it (review M2)', () => {
    expectRuleRefused(
      { ...BASE_RULE, dimensions: { '-': 'FR' } },
      'dimensions',
      'dimensions must not have a dimension name "-"',
    );
  });

  it('refuses an effectiveOn naming a date that starts with $', () => {
    expectRuleRefused(
      { ...BASE_RULE, effectiveOn: '/$dates/$x' },
      'effectiveOn',
      `effectiveOn must not name a date starting with "$": ${DATE_RESERVED}`,
    );
  });
});
