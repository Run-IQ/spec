import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../src/index.js';
import { outputProof, problems } from './proof-builders.js';
import type { OutputPart } from './proof-builders.js';

const NOT_FOLLOWING = 'output value does not follow from its contributions: value';

/** What a proof of one output `value` fed by `r0`, `r1`… with `contributions` gives. */
const found = (output: OutputPart, contributions: JsonValue[]): string[] =>
  problems({ ...outputProof(output, contributions) });

describe('a number sum is exact: the decimals of the shortest writings, added in order (9M1 R42)', () => {
  const sum = (value: number, contributors?: string[]): OutputPart => ({
    type: 'number',
    combine: 'sum',
    value,
    ...(contributors === undefined ? {} : { contributors }),
  });

  it('0.1 + 0.2 is 0.3, and the binary 0.30000000000000004 is refused', () => {
    expect(found(sum(0.3), [0.1, 0.2])).toEqual([]);
    expect(found(sum(0.30000000000000004), [0.1, 0.2])).toEqual([NOT_FOLLOWING]);
  });

  it('1e20 + 5 - 1e20 is exactly 5 (the 20-digit rule said 10)', () => {
    expect(found(sum(5), [1e20, 5, -1e20])).toEqual([]);
    expect(found(sum(10), [1e20, 5, -1e20])).toEqual([NOT_FOLLOWING]);
    expect(found(sum(0), [1e20, 5, -1e20])).toEqual([NOT_FOLLOWING]);
  });

  it('-1e20 - 5 + 1e20 is exactly -5', () => {
    expect(found(sum(-5), [-1e20, -5, 1e20])).toEqual([]);
    expect(found(sum(-10), [-1e20, -5, 1e20])).toEqual([NOT_FOLLOWING]);
  });

  it('1e20 + 0.1 - 1e20 is exactly 0.1 (it was 0)', () => {
    expect(found(sum(0.1), [1e20, 0.1, -1e20])).toEqual([]);
    expect(found(sum(0), [1e20, 0.1, -1e20])).toEqual([NOT_FOLLOWING]);
  });
});

describe('the contribution order is normative (D-5): one decision, one proof', () => {
  // The rules r0, r1… of `outputProof` have the same priority: identity orders them.
  const ORDER = 'contributors not in contribution order: value';

  it('a number sum is exact, so its value does not depend on it, and it has one order all the same', () => {
    const output: OutputPart = { type: 'number', combine: 'sum', value: 5 };
    expect(found(output, [1e20, 5, -1e20])).toEqual([]);
    // Summed as r0, r2, r1 the exact sum is 5 too: only the order is refused.
    const reordered = { ...output, contributors: ['r0', 'r2', 'r1'] };
    expect(found(reordered, [1e20, 5, -1e20])).toEqual([ORDER]);
    expect(found({ ...reordered, value: 10 }, [1e20, 5, -1e20])).toEqual([ORDER, NOT_FOLLOWING]);
  });

  it('a union keeps the order of its contributors', () => {
    const output: OutputPart = { type: 'list', combine: 'union', value: ['a', 'b'] };
    expect(found(output, [['a'], ['b']])).toEqual([]);
    expect(found({ ...output, value: ['b', 'a'] }, [['a'], ['b']])).toEqual([NOT_FOLLOWING]);
    expect(
      found({ ...output, value: ['b', 'a'], contributors: ['r1', 'r0'] }, [['a'], ['b']]),
    ).toEqual([ORDER]);
  });

  it('a max selects the first of equal extremes in that order (D-27)', () => {
    const output: OutputPart = {
      type: 'number',
      combine: 'max',
      value: 2,
      selected: { ruleId: 'r0' },
    };
    expect(found(output, [2, 2])).toEqual([]);
    expect(found({ ...output, selected: { ruleId: 'r1' } }, [2, 2])).toEqual([
      'selected does not match the value: value',
    ]);
  });

  it('even where the value does not depend on it: a decimal sum, a count, all, any', () => {
    const cases: [OutputPart, JsonValue[]][] = [
      [
        { type: 'decimal', combine: 'sum', value: '5' },
        ['100000000000000000000', '5', '-100000000000000000000'],
      ],
      [{ type: 'number', combine: 'count', value: 2 }, [true, false, true]],
      [{ type: 'boolean', combine: 'all', value: false }, [true, false, true]],
      [{ type: 'boolean', combine: 'any', value: true }, [false, true, false]],
    ];
    for (const [output, contributions] of cases) {
      expect(found(output, contributions)).toEqual([]);
      expect(found({ ...output, contributors: ['r2', 'r1', 'r0'] }, contributions)).toEqual([
        ORDER,
      ]);
    }
  });
});
