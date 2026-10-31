import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import {
  DEFAULT_OUTPUT,
  DEFAULT_OUTPUT_DECLARATION,
  validateOutputDeclaration,
  valueMatchesOutputType,
} from '../src/index.js';
import type { CombineStrategy, OutputDeclaration, OutputType } from '../src/index.js';

const TYPES: OutputType[] = ['number', 'boolean', 'string', 'enum', 'list', 'object'];
const COMBINES: CombineStrategy[] = ['sum', 'max', 'min', 'highestPriority', 'union', 'all', 'any'];

/** The admitted combinations, written out in full: the reference the validator must match. */
const ADMITTED: Record<CombineStrategy, OutputType[]> = {
  sum: ['number'],
  max: ['number'],
  min: ['number'],
  all: ['boolean'],
  any: ['boolean'],
  union: ['list'],
  highestPriority: ['number', 'boolean', 'string', 'enum', 'list', 'object'],
};

/** A declaration of `type`, with the `values` an enum needs. */
function declaration(type: OutputType, combine: CombineStrategy): OutputDeclaration {
  return type === 'enum' ? { type, combine, values: ['low', 'high'] } : { type, combine };
}

describe('defaults', () => {
  it('names the default output and declares it a summed number', () => {
    expect(DEFAULT_OUTPUT).toBe('value');
    expect(DEFAULT_OUTPUT_DECLARATION).toEqual({ type: 'number', combine: 'sum' });
    expect(validateOutputDeclaration(DEFAULT_OUTPUT_DECLARATION)).toEqual([]);
  });

  it('cannot be changed by a caller', () => {
    expect(Object.isFrozen(DEFAULT_OUTPUT_DECLARATION)).toBe(true);
  });

  it('is exported by the canonical entry too', () => {
    expect(canonicalEntry.DEFAULT_OUTPUT).toBe('value');
    expect(canonicalEntry.DEFAULT_OUTPUT_DECLARATION).toBe(DEFAULT_OUTPUT_DECLARATION);
    expect(canonicalEntry.validateOutputDeclaration).toBe(validateOutputDeclaration);
    expect(canonicalEntry.valueMatchesOutputType).toBe(valueMatchesOutputType);
  });
});

describe('validateOutputDeclaration: combinations', () => {
  const cases = COMBINES.flatMap((combine) =>
    TYPES.map((type) => [combine, type, ADMITTED[combine].includes(type)] as const),
  );

  it.each(cases)('%s with %s: admitted = %s', (combine, type, admitted) => {
    const issues = validateOutputDeclaration(declaration(type, combine));
    if (admitted) {
      expect(issues).toEqual([]);
    } else {
      expect(issues).toEqual([
        {
          path: 'output.combine',
          message: expect.stringContaining(`"${combine}" cannot combine a ${type} output`),
        },
      ]);
    }
  });

  it('refuses sum on a string output at output.combine, naming the admitted types', () => {
    expect(validateOutputDeclaration({ type: 'string', combine: 'sum' })).toEqual([
      {
        path: 'output.combine',
        message: 'output.combine "sum" cannot combine a string output: it applies to number',
      },
    ]);
  });

  it('roots the paths at the given path', () => {
    expect(validateOutputDeclaration({ type: 'list', combine: 'all' }, 'models.X.output')).toEqual([
      {
        path: 'models.X.output.combine',
        message:
          'models.X.output.combine "all" cannot combine a list output: it applies to boolean',
      },
    ]);
  });
});

describe('validateOutputDeclaration: shape', () => {
  it('refuses a value that is not an object', () => {
    for (const value of [undefined, null, 'number', 1, [], ['number', 'sum']]) {
      expect(validateOutputDeclaration(value)).toEqual([
        { path: 'output', message: 'output must be an object { type, combine, values? }' },
      ]);
    }
  });

  it('refuses an unknown type and an unknown combine', () => {
    expect(validateOutputDeclaration({ type: 'decimal', combine: 'avg' })).toEqual([
      {
        path: 'output.type',
        message: 'output.type must be one of number, boolean, string, enum, list, object',
      },
      {
        path: 'output.combine',
        message: 'output.combine must be one of sum, max, min, highestPriority, union, all, any',
      },
    ]);
  });

  it('refuses a missing type and a missing combine', () => {
    expect(validateOutputDeclaration({}).map((i) => i.path)).toEqual([
      'output.type',
      'output.combine',
    ]);
  });

  it('refuses an unknown key', () => {
    expect(validateOutputDeclaration({ type: 'number', combine: 'sum', unit: 'XOF' })).toEqual([
      { path: 'output.unit', message: 'output has an unknown key "unit"' },
    ]);
  });
});

describe('validateOutputDeclaration: enum values', () => {
  const enumOf = (values: unknown): unknown => ({
    type: 'enum',
    combine: 'highestPriority',
    values,
  });

  it('accepts a list of distinct strings', () => {
    expect(validateOutputDeclaration(enumOf(['low', 'medium', 'high']))).toEqual([]);
  });

  it('requires values', () => {
    expect(validateOutputDeclaration({ type: 'enum', combine: 'highestPriority' })).toEqual([
      {
        path: 'output.values',
        message: 'output.values is required for an enum output: list its allowed strings',
      },
    ]);
  });

  it('requires an array', () => {
    expect(validateOutputDeclaration(enumOf('low'))).toEqual([
      { path: 'output.values', message: 'output.values must be an array of non-empty strings' },
    ]);
  });

  it('refuses an empty list', () => {
    expect(validateOutputDeclaration(enumOf([]))).toEqual([
      {
        path: 'output.values',
        message: 'output.values must not be empty: an enum output needs at least one value',
      },
    ]);
  });

  it('refuses an empty string, at its index', () => {
    expect(validateOutputDeclaration(enumOf(['low', '']))).toEqual([
      { path: 'output.values[1]', message: 'output.values[1] must be a non-empty string' },
    ]);
  });

  it('refuses a non-string value, at its index', () => {
    expect(validateOutputDeclaration(enumOf(['low', 2, null]))).toEqual([
      { path: 'output.values[1]', message: 'output.values[1] must be a non-empty string' },
      { path: 'output.values[2]', message: 'output.values[2] must be a non-empty string' },
    ]);
  });

  it('refuses a duplicate, at the index of the repeat', () => {
    expect(validateOutputDeclaration(enumOf(['low', 'high', 'low']))).toEqual([
      { path: 'output.values[2]', message: 'output.values[2] repeats "low"' },
    ]);
  });

  it('refuses values on a type other than enum', () => {
    expect(
      validateOutputDeclaration({ type: 'string', combine: 'highestPriority', values: ['a'] }),
    ).toEqual([{ path: 'output.values', message: 'output.values applies only to an enum output' }]);
  });
});

describe('valueMatchesOutputType', () => {
  const of = (type: OutputType, combine: CombineStrategy = 'highestPriority'): OutputDeclaration =>
    declaration(type, combine);

  it('number: a finite number only', () => {
    expect(valueMatchesOutputType(0, of('number'))).toBe(true);
    expect(valueMatchesOutputType(-2.5, of('number'))).toBe(true);
    expect(valueMatchesOutputType(Number.NaN, of('number'))).toBe(false);
    expect(valueMatchesOutputType(Number.POSITIVE_INFINITY, of('number'))).toBe(false);
    expect(valueMatchesOutputType('1', of('number'))).toBe(false);
    expect(valueMatchesOutputType(null, of('number'))).toBe(false);
  });

  it('boolean: true or false only', () => {
    expect(valueMatchesOutputType(true, of('boolean'))).toBe(true);
    expect(valueMatchesOutputType(false, of('boolean'))).toBe(true);
    expect(valueMatchesOutputType(0, of('boolean'))).toBe(false);
    expect(valueMatchesOutputType('true', of('boolean'))).toBe(false);
  });

  it('string: any string, the empty one included', () => {
    expect(valueMatchesOutputType('', of('string'))).toBe(true);
    expect(valueMatchesOutputType('abc', of('string'))).toBe(true);
    expect(valueMatchesOutputType(1, of('string'))).toBe(false);
    expect(valueMatchesOutputType(['abc'], of('string'))).toBe(false);
  });

  it('enum: a listed value only', () => {
    const levels: OutputDeclaration = {
      type: 'enum',
      combine: 'highestPriority',
      values: ['low', 'high'],
    };
    expect(valueMatchesOutputType('low', levels)).toBe(true);
    expect(valueMatchesOutputType('high', levels)).toBe(true);
    expect(valueMatchesOutputType('medium', levels)).toBe(false);
    expect(valueMatchesOutputType('LOW', levels)).toBe(false);
    expect(valueMatchesOutputType('', levels)).toBe(false);
    expect(valueMatchesOutputType(0, levels)).toBe(false);
  });

  it('list: an array, whatever its items', () => {
    expect(valueMatchesOutputType([], of('list', 'union'))).toBe(true);
    expect(valueMatchesOutputType(['a', 1, null], of('list', 'union'))).toBe(true);
    expect(valueMatchesOutputType({ 0: 'a' }, of('list', 'union'))).toBe(false);
    expect(valueMatchesOutputType('a', of('list', 'union'))).toBe(false);
  });

  it('object: an object that is not an array, not null', () => {
    expect(valueMatchesOutputType({}, of('object'))).toBe(true);
    expect(valueMatchesOutputType({ a: [1] }, of('object'))).toBe(true);
    expect(valueMatchesOutputType([], of('object'))).toBe(false);
    expect(valueMatchesOutputType(null, of('object'))).toBe(false);
    expect(valueMatchesOutputType('{}', of('object'))).toBe(false);
  });
});
