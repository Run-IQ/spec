import { describe, expect, it } from 'vitest';
import { inputLeafHash, validateProofInput } from '../../src/index.js';
import { MAX_INPUT_LEAF_TEXT, MAX_JSON_VALUES } from '../../src/values.js';
import { LONGEST_DATA_LIST, loose, proofInput, specError } from '../helpers.js';
import { hex, nodeLeafHash } from '../hashing.js';

const SALTS = { salt: 'ab'.repeat(32), valueSalt: 'cd'.repeat(32) };

describe('inputLeafHash at the limits of an input (heavy)', () => {
  it('refuses a pointer longer than a leaf there can be, and accepts the longest', () => {
    // Every input also holds /meta/tenantId and the five other parts of meta: 80 code units.
    const longest = MAX_INPUT_LEAF_TEXT - 80;
    const pointer = `/data/${'k'.repeat(longest - '/data/'.length)}`;
    expect(pointer).toHaveLength(longest);
    const leaf = { pointer, kind: 'value', value: 1, ...SALTS };
    expect(hex(inputLeafHash(loose(leaf)))).toBe(hex(nodeLeafHash(loose(leaf))));
    expect(
      specError(() => inputLeafHash(loose({ ...leaf, pointer: `${pointer}k` }))),
    ).toMatchObject({
      code: 'INVALID_INPUT',
      path: '/pointer',
      message: `invalid input leaf: /pointer is longer than ${longest} code units`,
    });
  }, 60_000);

  it(`a list holds at most ${MAX_JSON_VALUES} values less those every input holds`, () => {
    const meta = proofInput({ dates: {} }, {}).meta;
    const longest = { data: { a: new Array<number>(LONGEST_DATA_LIST).fill(0) }, meta };
    expect(validateProofInput(longest)).toEqual([]);
    const over = { data: { a: new Array<number>(LONGEST_DATA_LIST + 1).fill(0) }, meta };
    expect(validateProofInput(over)).toEqual([
      { path: '/meta', message: '/meta is too large: more than 10000000 values' },
    ]);
    const leaf = { pointer: '/data/a', kind: 'array', length: LONGEST_DATA_LIST, ...SALTS };
    expect(hex(inputLeafHash(loose(leaf)))).toBe(hex(nodeLeafHash(loose(leaf))));
  }, 60_000);
});
