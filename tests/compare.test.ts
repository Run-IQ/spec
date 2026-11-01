import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import { compareOutputValues } from '../src/index.js';
import type { JsonValue, OutputDeclaration } from '../src/index.js';
import { loose, specError } from './helpers.js';

const RISK: OutputDeclaration = {
  type: 'enum',
  combine: 'max',
  values: ['minimal', 'limited', 'high', 'prohibited'],
};

/** The sign each consecutive pair of `values` compares with, under `declaration`. */
function signs(values: JsonValue[], declaration: OutputDeclaration): number[] {
  return values
    .slice(1)
    .map((value, i) => compareOutputValues(values[i] ?? null, value, declaration));
}

describe('compareOutputValues', () => {
  it('ranks an enum by the order of its values', () => {
    expect(compareOutputValues('high', 'limited', RISK)).toBe(1);
    expect(compareOutputValues('limited', 'high', RISK)).toBe(-1);
    expect(compareOutputValues('high', 'high', RISK)).toBe(0);
    expect(signs(['minimal', 'limited', 'high', 'prohibited'], RISK)).toEqual([-1, -1, -1]);
  });

  it('compares decimals by exact value, never as text', () => {
    const decimal: OutputDeclaration = { type: 'decimal', combine: 'max' };
    expect(compareOutputValues('10', '9', decimal)).toBe(1);
    expect(compareOutputValues('9', '10', decimal)).toBe(-1);
    const ordered = [
      '-100',
      '-10.5',
      '-10.25',
      '-9',
      '-0.001',
      '0',
      '0.001',
      '0.01',
      '0.1',
      '1',
      '1.0000000000000000000000001',
      '9.99',
      '10',
      '123456789012345678901234567890',
    ];
    expect(signs(ordered, decimal)).toEqual(ordered.slice(1).map(() => -1));
    expect(compareOutputValues('1.5', '1.5', decimal)).toBe(0);
    expect(compareOutputValues('-1.5', '-1.50001', decimal)).toBe(1);
  });

  it('compares numbers numerically, -0 equal to 0', () => {
    const number: OutputDeclaration = { type: 'number', combine: 'min' };
    expect(signs([-1e300, -2, -0.5, 0, 0.5, 10, 1e300], number)).toEqual([-1, -1, -1, -1, -1, -1]);
    expect(compareOutputValues(-0, 0, number)).toBe(0);
  });

  it('orders civil dates and instants in time', () => {
    const date: OutputDeclaration = { type: 'date', combine: 'max' };
    expect(
      signs(['0000-01-01', '2026-02-28', '2026-03-01', '2028-02-29', '9999-12-31'], date),
    ).toEqual([-1, -1, -1, -1]);
    const instant: OutputDeclaration = { type: 'dateTime', combine: 'min' };
    expect(
      signs(
        ['2025-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.001Z'],
        instant,
      ),
    ).toEqual([-1, -1]);
    expect(
      compareOutputValues('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', instant),
    ).toBe(0);
  });

  it('applies to a highestPriority output of an ordered type too', () => {
    const decimal: OutputDeclaration = { type: 'decimal', combine: 'highestPriority' };
    expect(compareOutputValues('2', '10', decimal)).toBe(-1);
  });

  it.each(['boolean', 'string', 'list', 'object'] as const)(
    'refuses a %s output: no order',
    (type) => {
      const declaration: OutputDeclaration = { type, combine: 'highestPriority' };
      expect(specError(() => compareOutputValues('a', 'b', declaration))).toMatchObject({
        code: 'INVALID_RULE',
        message: `a ${type} output has no order: only number, decimal, enum, date and dateTime do`,
      });
    },
  );

  it('refuses a value that is not one of the output, on either side', () => {
    // [refused value, a valid value of the same output, the output, how the value is cited]
    const cases: [JsonValue, JsonValue, OutputDeclaration, string][] = [
      ['medium', 'high', RISK, '"medium"'],
      ['10.0', '1', { type: 'decimal', combine: 'max' }, '"10.0"'],
      [10, '1', { type: 'decimal', combine: 'max' }, 'a value of type number'],
      ['2026-02-29', '2026-01-01', { type: 'date', combine: 'max' }, '"2026-02-29"'],
      [
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00.000Z',
        { type: 'dateTime', combine: 'max' },
        '"2026-01-01T00:00:00Z"',
      ],
      [Number.NaN, 1, { type: 'number', combine: 'max' }, 'a value of type number'],
      [1.5, 1, { type: 'number', combine: 'count' }, 'a value of type number'],
    ];
    for (const [value, valid, declaration, cited] of cases) {
      for (const call of [
        () => compareOutputValues(value, valid, declaration),
        () => compareOutputValues(valid, value, declaration),
      ]) {
        expect(specError(call)).toMatchObject({
          code: 'INVALID_RULE',
          message: `cannot compare ${cited}: not a value of this ${declaration.type} output`,
        });
      }
    }
  });

  it('refuses a declaration the validator refuses', () => {
    const error = specError(() =>
      compareOutputValues(1, 2, loose<OutputDeclaration>({ type: 'number', combine: 'all' })),
    );
    expect(error).toMatchObject({
      code: 'INVALID_RULE',
      message:
        'invalid output declaration: ' +
        'output.combine "all" cannot combine a number output: it applies to boolean',
      path: 'output.combine',
    });
  });

  it('the canonical entry exports the same function', () => {
    expect(canonicalEntry.compareOutputValues).toBe(compareOutputValues);
  });
});
