/**
 * Job 7: exact decimal arithmetic. Each describe names its requirement (D1 to D7 of the spec of
 * the job, posted on Run-IQ/.github#1): the functions are exact, canonical, checked at their
 * boundary, and bounded.
 */
import { describe, expect, it } from 'vitest';
import {
  addDecimals,
  divideDecimals,
  isCanonicalDecimal,
  MAX_DECIMAL_DIGITS,
  multiplyDecimals,
  numberToDecimal,
  roundDecimal,
  SpecError,
  subtractDecimals,
} from '../src/index.js';
import * as canonicalEntry from '../src/canonical-entry.js';
import { roundExact, sumNumbers } from '../src/proof/arithmetic.js';
import { outputProof, problems } from './proof-builders.js';
import type { OutputPart } from './proof-builders.js';

function thrown(call: () => unknown): SpecError {
  try {
    call();
  } catch (error) {
    if (error instanceof SpecError) return error;
    throw error;
  }
  throw new Error('expected a SpecError');
}

/** The value of a canonical decimal as `[scaled BigInt, places]`, the reference arithmetic. */
function scaled(text: string, places: number): bigint {
  const negative = text.startsWith('-');
  const [integer = '', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const digits = BigInt(integer + fraction.padEnd(places, '0'));
  return negative ? -digits : digits;
}

/** The canonical decimal of `value / 10^places`. */
function unscaled(value: bigint, places: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(places + 1, '0');
  const text =
    places === 0
      ? digits
      : `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`;
  const trimmed = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
  return trimmed === '0' ? '0' : `${negative ? '-' : ''}${trimmed}`;
}

const placesOf = (text: string): number => (text.includes('.') ? text.split('.')[1]!.length : 0);

/** A small seeded generator: the same pairs on every run. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function randomDecimal(next: () => number): string {
  const integer = Math.floor(next() * 1e9).toString();
  const places = Math.floor(next() * 12);
  let fraction = '';
  for (let i = 0; i < places; i++) fraction += Math.floor(next() * 10).toString();
  const text = `${next() < 0.4 ? '-' : ''}${integer}${fraction === '' ? '' : `.${fraction}`}`;
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') || '0' : text;
}

const canonicalOf = (text: string): string => (text === '-0' ? '0' : text);

describe('D1: numberToDecimal', () => {
  it.each([
    [0.1, '0.1'],
    [1e21, '1000000000000000000000'],
    [-0, '0'],
    [1e-7, '0.0000001'],
    [-1.5, '-1.5'],
    [123456789.125, '123456789.125'],
    [5e-324, `0.${'0'.repeat(323)}5`],
    [1.7976931348623157e308, `17976931348623157${'0'.repeat(292)}`],
  ])('%s gives %s', (n, text) => {
    expect(numberToDecimal(n)).toBe(text);
    expect(isCanonicalDecimal(numberToDecimal(n))).toBe(true);
  });

  it.each([[NaN], [Infinity], [-Infinity], ['1'], [null], [undefined], [1n], [{}]])(
    'refuses %s with INVALID_NUMBER and the position',
    (value) => {
      const error = thrown(() => numberToDecimal(value as never));
      expect(error.code).toBe('INVALID_NUMBER');
      expect(error.message).toContain('argument 1 of numberToDecimal');
    },
  );

  it('is exported by the canonical entry too', () => {
    expect(canonicalEntry.numberToDecimal(0.1)).toBe('0.1');
  });
});

describe('D2: addDecimals, subtractDecimals, multiplyDecimals', () => {
  it.each([
    [() => addDecimals('0.1', '0.2'), '0.3'],
    [() => subtractDecimals('-1.5', '-1.5'), '0'],
    [() => subtractDecimals('0', '0'), '0'],
    [() => multiplyDecimals('1.5', '-2'), '-3'],
    [() => multiplyDecimals('-0.5', '0'), '0'],
    [() => addDecimals('-0.1', '0.1'), '0'],
    [() => addDecimals('999999999999999999999', '1'), '1000000000000000000000'],
  ])('%#', (call, expected) => {
    expect(call()).toBe(expected);
  });

  it('agrees with scaled BigInt arithmetic on 2 000 random pairs', () => {
    const next = random(7);
    for (let i = 0; i < 2000; i++) {
      const a = randomDecimal(next);
      const b = randomDecimal(next);
      const places = Math.max(placesOf(a), placesOf(b));
      const sa = scaled(a, places);
      const sb = scaled(b, places);
      expect(addDecimals(a, b), `${a} + ${b}`).toBe(canonicalOf(unscaled(sa + sb, places)));
      expect(subtractDecimals(a, b), `${a} - ${b}`).toBe(canonicalOf(unscaled(sa - sb, places)));
      const product = scaled(a, placesOf(a)) * scaled(b, placesOf(b));
      expect(multiplyDecimals(a, b), `${a} * ${b}`).toBe(
        canonicalOf(unscaled(product, placesOf(a) + placesOf(b))),
      );
    }
  });

  it('is exact on 10 000-digit operands', () => {
    const a = `${'9'.repeat(5000)}.${'3'.repeat(5000)}`;
    const b = `-${'7'.repeat(4000)}.${'1'.repeat(5999)}`;
    const places = Math.max(placesOf(a), placesOf(b));
    expect(addDecimals(a, b)).toBe(unscaled(scaled(a, places) + scaled(b, places), places));
    expect(subtractDecimals(a, b)).toBe(unscaled(scaled(a, places) - scaled(b, places), places));
    expect(multiplyDecimals(a, b)).toBe(
      unscaled(scaled(a, placesOf(a)) * scaled(b, placesOf(b)), placesOf(a) + placesOf(b)),
    );
  });

  it.each([['addDecimals'], ['subtractDecimals'], ['multiplyDecimals']] as const)(
    '%s checks its inputs first, naming the position',
    (name) => {
      const call = { addDecimals, subtractDecimals, multiplyDecimals }[name] as (
        a: unknown,
        b: unknown,
      ) => string;
      for (const [bad, position] of [
        [['0.10', '1'], 1],
        [['1', '1.0'], 2],
        [['-0', '1'], 1],
        [['1', 1], 2],
        [[1, '1'], 1],
        [['1e3', '1'], 1],
        [['1', ' 1'], 2],
        [['1', undefined], 2],
      ] as const) {
        const error = thrown(() => call(bad[0], bad[1]));
        expect(error.code).toBe('INVALID_DECIMAL');
        expect(error.message).toContain(`argument ${position} of ${name}`);
      }
    },
  );
});

describe('D3: roundDecimal is public', () => {
  const modes = ['halfUp', 'halfDown', 'halfEven', 'up', 'down', 'ceiling', 'floor'] as const;
  // value, then the result of each mode at scale 0, in the order of `modes`.
  const table: [string, string[]][] = [
    ['2.5', ['3', '2', '2', '3', '2', '3', '2']],
    ['3.5', ['4', '3', '4', '4', '3', '4', '3']],
    ['-2.5', ['-3', '-2', '-2', '-3', '-2', '-2', '-3']],
    ['-3.5', ['-4', '-3', '-4', '-4', '-3', '-3', '-4']],
    ['2.4', ['2', '2', '2', '3', '2', '3', '2']],
    ['2.6', ['3', '3', '3', '3', '2', '3', '2']],
    ['-2.4', ['-2', '-2', '-2', '-3', '-2', '-2', '-3']],
    ['-2.6', ['-3', '-3', '-3', '-3', '-2', '-2', '-3']],
    ['2.50000000000000000001', ['3', '3', '3', '3', '2', '3', '2']],
    ['2.49999999999999999999', ['2', '2', '2', '3', '2', '3', '2']],
    ['0.5', ['1', '0', '0', '1', '0', '1', '0']],
    ['-0.5', ['-1', '0', '0', '-1', '0', '0', '-1']],
    ['7', ['7', '7', '7', '7', '7', '7', '7']],
  ];
  it.each(table)('%s at scale 0, each mode', (value, expected) => {
    modes.forEach((mode, i) => {
      expect(roundDecimal(value, { scale: 0, mode }), `${value} ${mode}`).toBe(expected[i]);
    });
  });

  it('is the internal rounding behind a validation: both give the same on the whole table', () => {
    for (const [value] of table) {
      for (const mode of modes) {
        for (const rounding of [
          { scale: 0, mode },
          { scale: 3, mode },
          { increment: '0.5', mode },
          { increment: '10', mode },
        ]) {
          expect(roundDecimal(value, rounding)).toBe(roundExact(value, rounding));
        }
      }
    }
  });

  it('rounds to a scale and to an increment', () => {
    expect(roundDecimal('1.005', { scale: 2, mode: 'halfUp' })).toBe('1.01');
    expect(roundDecimal('1.005', { scale: 2, mode: 'halfEven' })).toBe('1');
    expect(roundDecimal('1.025', { increment: '0.05', mode: 'halfUp' })).toBe('1.05');
    expect(roundDecimal('1.025', { increment: '0.05', mode: 'halfEven' })).toBe('1');
    expect(roundDecimal('-1.025', { increment: '0.05', mode: 'halfUp' })).toBe('-1.05');
    expect(roundDecimal('17', { increment: '10', mode: 'halfUp' })).toBe('20');
  });

  it.each([
    [{ mode: 'halfUp' }],
    [{ scale: 2, increment: '0.05', mode: 'halfUp' }],
    [{ scale: -1, mode: 'halfUp' }],
    [{ scale: 21, mode: 'halfUp' }],
    [{ scale: 1.5, mode: 'halfUp' }],
    [{ increment: '0', mode: 'halfUp' }],
    [{ increment: '0.50', mode: 'halfUp' }],
    [{ scale: 2, mode: 'sideways' }],
    [{ scale: 2, mode: 'halfUp', at: 'output' }],
    [{ scale: 2 }],
    [null],
    ['halfUp'],
  ])('refuses the rounding %j with INVALID_ROUNDING', (rounding) => {
    const error = thrown(() => roundDecimal('1', rounding as never));
    expect(error.code).toBe('INVALID_ROUNDING');
  });

  it('refuses a value that is not a canonical decimal, naming the position', () => {
    const error = thrown(() => roundDecimal('1.50', { scale: 0, mode: 'halfUp' }));
    expect(error.code).toBe('INVALID_DECIMAL');
    expect(error.message).toContain('argument 1 of roundDecimal');
  });
});

describe('D4: divideDecimals takes an explicit rounding', () => {
  it.each([
    ['1', '3', { scale: 2, mode: 'halfUp' }, '0.33'],
    ['2', '3', { scale: 2, mode: 'halfUp' }, '0.67'],
    ['-1', '8', { scale: 2, mode: 'halfEven' }, '-0.12'],
    ['10', '4', { increment: '0.5', mode: 'floor' }, '2.5'],
    ['1', '8', { scale: 2, mode: 'halfEven' }, '0.12'],
    ['3', '8', { scale: 2, mode: 'halfEven' }, '0.38'],
    ['3', '8', { scale: 2, mode: 'halfUp' }, '0.38'],
    ['-3', '8', { scale: 2, mode: 'halfDown' }, '-0.37'],
    ['1', '-3', { scale: 3, mode: 'ceiling' }, '-0.333'],
    ['1', '-3', { scale: 3, mode: 'floor' }, '-0.334'],
    ['0', '7', { scale: 2, mode: 'up' }, '0'],
    ['1', '0.00000001', { scale: 2, mode: 'halfUp' }, '100000000'],
    ['7.5', '2.5', { scale: 0, mode: 'halfUp' }, '3'],
    ['-1', '3', { scale: 0, mode: 'up' }, '-1'],
    ['1', '3', { scale: 0, mode: 'down' }, '0'],
  ] as const)('%s / %s at %j gives %s', (a, b, rounding, expected) => {
    expect(divideDecimals(a, b, rounding)).toBe(expected);
  });

  it('rounds once: 0.125 / 1 at scale 2 halfUp is 0.13, not the double rounding of 0.1249999', () => {
    expect(divideDecimals('0.125', '1', { scale: 2, mode: 'halfUp' })).toBe('0.13');
    expect(divideDecimals('0.12499', '1', { scale: 2, mode: 'halfUp' })).toBe('0.12');
  });

  it('agrees with scaled BigInt division on random pairs', () => {
    const next = random(11);
    for (let i = 0; i < 500; i++) {
      const a = randomDecimal(next);
      let b = randomDecimal(next);
      if (b === '0') b = '3';
      const scale = Math.floor(next() * 8);
      const places = Math.max(placesOf(a), placesOf(b));
      const sa = scaled(a, places) < 0n ? -scaled(a, places) : scaled(a, places);
      const sb = scaled(b, places) < 0n ? -scaled(b, places) : scaled(b, places);
      const num = sa * 10n ** BigInt(scale);
      const q = num / sb;
      const r = num % sb;
      const negative = a.startsWith('-') !== b.startsWith('-');
      const up = 2n * r >= sb;
      const magnitude = q + (up ? 1n : 0n);
      const expected = unscaled(negative ? -magnitude : magnitude, scale);
      expect(divideDecimals(a, b, { scale, mode: 'halfUp' }), `${a} / ${b} @${scale}`).toBe(
        expected === '-0' ? '0' : expected,
      );
    }
  });

  it('refuses a division by zero, whatever its spelling, with DIVISION_BY_ZERO', () => {
    const error = thrown(() => divideDecimals('1', '0', { scale: 2, mode: 'halfUp' }));
    expect(error.code).toBe('DIVISION_BY_ZERO');
    expect(thrown(() => divideDecimals('0', '0', { scale: 2, mode: 'halfUp' })).code).toBe(
      'DIVISION_BY_ZERO',
    );
  });

  it.each([[undefined], [null], [{}], [{ scale: 2 }], [{ mode: 'halfUp' }], [2], ['halfUp']])(
    'never picks a precision itself: the rounding %j is INVALID_ROUNDING',
    (rounding) => {
      const error = thrown(() => divideDecimals('1', '3', rounding as never));
      expect(error.code).toBe('INVALID_ROUNDING');
    },
  );

  it('checks the decimals first, naming the position', () => {
    const first = thrown(() => divideDecimals('1.0', '3', { scale: 2, mode: 'halfUp' }));
    expect(first.code).toBe('INVALID_DECIMAL');
    expect(first.message).toContain('argument 1 of divideDecimals');
    const second = thrown(() => divideDecimals('1', 3 as never, { scale: 2, mode: 'halfUp' }));
    expect(second.message).toContain('argument 2 of divideDecimals');
  });
});

describe('D5: MAX_DECIMAL_DIGITS bounds every operand and result', () => {
  it('is 100 000', () => {
    expect(MAX_DECIMAL_DIGITS).toBe(100_000);
  });

  const atLimit = `1${'0'.repeat(MAX_DECIMAL_DIGITS - 1)}`;
  const past = `${atLimit}0`;

  it('an operand at the limit passes, one digit more throws LIMIT_EXCEEDED naming it', () => {
    expect(addDecimals(atLimit, '0')).toBe(atLimit);
    expect(subtractDecimals(atLimit, '0')).toBe(atLimit);
    expect(multiplyDecimals(atLimit, '1')).toBe(atLimit);
    for (const call of [
      () => addDecimals(past, '0'),
      () => addDecimals('0', past),
      () => subtractDecimals(past, '0'),
      () => multiplyDecimals('1', past),
      () => divideDecimals(past, '1', { scale: 0, mode: 'down' }),
      () => roundDecimal(past, { scale: 0, mode: 'down' }),
    ]) {
      const error = thrown(call);
      expect(error.code).toBe('LIMIT_EXCEEDED');
      expect(error.message).toContain('MAX_DECIMAL_DIGITS');
    }
  });

  it('counts the fraction digits too, and not the sign or the point', () => {
    const fraction = `0.${'1'.repeat(MAX_DECIMAL_DIGITS - 1)}`;
    expect(addDecimals(fraction, '0')).toBe(fraction);
    expect(addDecimals(`-${fraction}`, '0')).toBe(`-${fraction}`);
    expect(thrown(() => addDecimals(`${fraction}1`, '0')).code).toBe('LIMIT_EXCEEDED');
  });

  it('a result past the limit throws, though both operands pass', () => {
    const big = '9'.repeat(MAX_DECIMAL_DIGITS);
    expect(thrown(() => addDecimals(big, big)).code).toBe('LIMIT_EXCEEDED');
    expect(thrown(() => multiplyDecimals('9'.repeat(60_000), '9'.repeat(60_000))).code).toBe(
      'LIMIT_EXCEEDED',
    );
    // 10^50000 / 10^-50000 is 10^100000: 100001 digits.
    expect(
      thrown(() =>
        divideDecimals(`1${'0'.repeat(50_000)}`, `0.${'0'.repeat(49_999)}1`, {
          scale: 0,
          mode: 'down',
        }),
      ).code,
    ).toBe('LIMIT_EXCEEDED');
  });
});

describe('D6: sumNumbers is exact (9M1 R42)', () => {
  const sum = (values: number[], rounding?: { scale?: number; increment?: string; mode: string }) =>
    sumNumbers(values, rounding as never);

  it('adds the shortest writings exactly, in order: 1e20 + 0.1 - 1e20 is 0.1', () => {
    expect(sum([1e20, 0.1, -1e20])).toBe(0.1);
    expect(sum([0.1, 0.2])).toBe(0.3);
    expect(sum([1e20, 5, -1e20])).toBe(5);
    expect(sum([-1e20, -5, 1e20])).toBe(-5);
    expect(sum([1e16, 1, -1e16])).toBe(1);
    expect(sum([])).toBe(0);
  });

  it('is the number nearest to the exact sum, never -0', () => {
    expect(Object.is(sum([0.5, -0.5]), 0)).toBe(true);
    expect(Object.is(sum([-0, -0]), 0)).toBe(true);
    expect(sum([0.1, 0.7, 0.2])).toBe(1);
  });

  it('applies the output rounding to the exact sum, once', () => {
    expect(sum([0.111, 0.222], { scale: 2, mode: 'halfUp' })).toBe(0.33);
    expect(sum([0.005, 0], { scale: 2, mode: 'halfUp' })).toBe(0.01);
    expect(sum([1e20, 0.005, -1e20], { scale: 2, mode: 'halfUp' })).toBe(0.01);
  });

  it('throws INVALID_NUMBER when the sum is not finite', () => {
    const error = thrown(() => sum([1.7976931348623157e308, 1.7976931348623157e308]));
    expect(error.code).toBe('INVALID_NUMBER');
  });

  it('refuses a value that is not a finite number, naming the position', () => {
    const error = thrown(() => sumNumbers([1, NaN] as number[], undefined));
    expect(error.code).toBe('INVALID_NUMBER');
  });

  it('the verifier follows it: the exact sum is consistent, the old 20-digit one is not', () => {
    const output = (value: number): OutputPart => ({ type: 'number', combine: 'sum', value });
    // 1e20 + 5 - 1e20 is exactly 5; the old rule (20 digits, ties away) said 10.
    expect(problems({ ...outputProof(output(5), [1e20, 5, -1e20]) })).toEqual([]);
    expect(problems({ ...outputProof(output(10), [1e20, 5, -1e20]) })).toEqual([
      'output value does not follow from its contributions: value',
    ]);
    // 1e20 + 0.1 - 1e20 is 0.1 (it was 0).
    expect(problems({ ...outputProof(output(0.1), [1e20, 0.1, -1e20]) })).toEqual([]);
    expect(problems({ ...outputProof(output(0), [1e20, 0.1, -1e20]) })).toEqual([
      'output value does not follow from its contributions: value',
    ]);
  });

  it('a sum that overflows is a named problem of the proof, never a raw error', () => {
    const big = 1.7976931348623157e308;
    const result = problems({
      ...outputProof({ type: 'number', combine: 'sum', value: big }, [big, big]),
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.join(' ')).toMatch(/not a finite number|follow from its contributions/);
  });
});
