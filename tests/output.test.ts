import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import {
  DEFAULT_OUTPUT,
  DEFAULT_OUTPUT_DECLARATION,
  OUTPUTS_VARIABLE,
  validateOutputDeclaration,
  valueMatchesOutputType,
} from '../src/index.js';
import type {
  CombineStrategy,
  OutputDeclaration,
  OutputRounding,
  OutputType,
  RoundingMode,
} from '../src/index.js';

const TYPES: OutputType[] = ['number', 'boolean', 'string', 'enum', 'list', 'object', 'decimal'];
const COMBINES: CombineStrategy[] = ['sum', 'max', 'min', 'highestPriority', 'union', 'all', 'any'];

/** The admitted combinations, written out in full: the reference the validator must match. */
const ADMITTED: Record<CombineStrategy, OutputType[]> = {
  sum: ['number', 'decimal'],
  max: ['number', 'decimal'],
  min: ['number', 'decimal'],
  all: ['boolean'],
  any: ['boolean'],
  union: ['list'],
  highestPriority: ['number', 'boolean', 'string', 'enum', 'list', 'object', 'decimal'],
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
    expect(canonicalEntry.OUTPUTS_VARIABLE).toBe('$outputs');
  });

  it('reserves $outputs, the variable through which a rule reads outputs', () => {
    expect(OUTPUTS_VARIABLE).toBe('$outputs');
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
        message:
          'output.combine "sum" cannot combine a string output: it applies to number, decimal',
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
        {
          path: 'output',
          message: 'output must be an object { type, combine, values?, rounding? }',
        },
      ]);
    }
  });

  it('refuses an unknown type and an unknown combine', () => {
    expect(validateOutputDeclaration({ type: 'money', combine: 'avg' })).toEqual([
      {
        path: 'output.type',
        message: 'output.type must be one of number, boolean, string, enum, list, object, decimal',
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

  it('decimal: a canonical decimal string only', () => {
    const decimal = of('decimal', 'sum');
    for (const value of ['12.5', '0', '-3', '-0.25', '1000']) {
      expect(valueMatchesOutputType(value, decimal)).toBe(true);
    }
    for (const value of ['12.50', '1e3', '-0', '012', '', ' 1', 12.5, 12, null, ['1']]) {
      expect(valueMatchesOutputType(value, decimal)).toBe(false);
    }
  });

  it('object: an object that is not an array, not null', () => {
    expect(valueMatchesOutputType({}, of('object'))).toBe(true);
    expect(valueMatchesOutputType({ a: [1] }, of('object'))).toBe(true);
    expect(valueMatchesOutputType([], of('object'))).toBe(false);
    expect(valueMatchesOutputType(null, of('object'))).toBe(false);
    expect(valueMatchesOutputType('{}', of('object'))).toBe(false);
  });
});

describe('validateOutputDeclaration: decimal', () => {
  it.each(['sum', 'max', 'min', 'highestPriority'] as const)('accepts combine %s', (combine) => {
    expect(validateOutputDeclaration({ type: 'decimal', combine })).toEqual([]);
  });

  it.each(['union', 'all', 'any'] as const)('refuses combine %s, naming the path', (combine) => {
    expect(validateOutputDeclaration({ type: 'decimal', combine }, 'models.TAX.output')).toEqual([
      {
        path: 'models.TAX.output.combine',
        message: `models.TAX.output.combine "${combine}" cannot combine a decimal output: it applies to ${
          combine === 'union' ? 'list' : 'boolean'
        }`,
      },
    ]);
  });
});

describe('validateOutputDeclaration: rounding', () => {
  const MODES: RoundingMode[] = [
    'halfUp',
    'halfDown',
    'halfEven',
    'up',
    'down',
    'ceiling',
    'floor',
  ];
  const withRounding = (rounding: unknown, type: OutputType = 'decimal'): unknown =>
    type === 'enum'
      ? { type, combine: 'highestPriority', values: ['a'], rounding }
      : { type, combine: 'highestPriority', rounding };

  it.each(['number', 'decimal'] as const)('is accepted on a %s output', (type) => {
    const rounding: OutputRounding = { scale: 2, mode: 'halfEven' };
    expect(validateOutputDeclaration(withRounding(rounding, type))).toEqual([]);
    expect(validateOutputDeclaration({ type, combine: 'sum', rounding })).toEqual([]);
  });

  it.each(['boolean', 'string', 'enum', 'list', 'object'] as const)(
    'is refused on a %s output',
    (type) => {
      expect(validateOutputDeclaration(withRounding({ scale: 2, mode: 'halfUp' }, type))).toEqual([
        {
          path: 'output.rounding',
          message: 'output.rounding applies only to a number or decimal output',
        },
      ]);
    },
  );

  it.each(MODES)('accepts mode %s', (mode) => {
    expect(validateOutputDeclaration(withRounding({ scale: 0, mode }))).toEqual([]);
  });

  it.each([0, 1, 20])('accepts scale %s', (scale) => {
    expect(validateOutputDeclaration(withRounding({ scale, mode: 'down' }))).toEqual([]);
  });

  it.each([-1, 21, 1.5, '2', null, 1e300, Number.NaN])('refuses scale %s', (scale) => {
    expect(validateOutputDeclaration(withRounding({ scale, mode: 'down' }))).toEqual([
      {
        path: 'output.rounding.scale',
        message: 'output.rounding.scale must be an integer from 0 to 20',
      },
    ]);
  });

  it('accepts at absent, output or contribution', () => {
    for (const at of [undefined, 'output', 'contribution']) {
      expect(validateOutputDeclaration(withRounding({ scale: 2, mode: 'up', at }))).toEqual([]);
    }
  });

  it('refuses an unknown mode and an unknown at', () => {
    expect(
      validateOutputDeclaration(withRounding({ scale: 2, mode: 'bankers', at: 'line' })),
    ).toEqual([
      {
        path: 'output.rounding.mode',
        message:
          'output.rounding.mode must be one of halfUp, halfDown, halfEven, up, down, ceiling, floor',
      },
      {
        path: 'output.rounding.at',
        message: 'output.rounding.at must be one of output, contribution',
      },
    ]);
  });

  it('requires scale and mode', () => {
    expect(validateOutputDeclaration(withRounding({}))).toEqual([
      { path: 'output.rounding.scale', message: 'output.rounding.scale is required' },
      { path: 'output.rounding.mode', message: 'output.rounding.mode is required' },
    ]);
  });

  it('refuses an unknown key, even with an undefined value, as at the top level', () => {
    expect(validateOutputDeclaration({ type: 'number', combine: 'sum', unit: undefined })).toEqual([
      { path: 'output.unit', message: 'output has an unknown key "unit"' },
    ]);
    expect(
      validateOutputDeclaration(withRounding({ scale: 2, mode: 'up', precision: undefined })),
    ).toEqual([
      {
        path: 'output.rounding.precision',
        message: 'output.rounding has an unknown key "precision"',
      },
    ]);
  });

  it('refuses an unknown key', () => {
    expect(validateOutputDeclaration(withRounding({ scale: 2, mode: 'up', precision: 4 }))).toEqual(
      [
        {
          path: 'output.rounding.precision',
          message: 'output.rounding has an unknown key "precision"',
        },
      ],
    );
  });

  it('refuses a rounding that is not an object', () => {
    for (const rounding of [null, 2, 'halfUp', [2, 'halfUp']]) {
      expect(validateOutputDeclaration(withRounding(rounding))).toEqual([
        {
          path: 'output.rounding',
          message: 'output.rounding must be an object { scale, mode, at? }',
        },
      ]);
    }
  });
});
