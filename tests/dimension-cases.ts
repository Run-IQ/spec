/**
 * Each refused spec of the dimension `pays`, with the path and message of its first problem.
 * Shared by tests/dimensions.test.ts (validator and normalize) and tests/schema.test.ts (JSON
 * schema).
 */
export const REFUSED_DIMENSIONS: [string, unknown, string, string][] = [
  [
    'an empty anyOf',
    { ref: 'ue', anyOf: [] },
    'dimensions.pays.anyOf',
    'dimensions.pays.anyOf must list at least one value',
  ],
  [
    'ref without anyOf',
    { ref: 'ue' },
    'dimensions.pays.anyOf',
    'dimensions.pays.anyOf must be a non-empty array of values',
  ],
  [
    'an except value also in anyOf',
    { ref: 'ue', anyOf: ['UE', 'DK'], except: ['DK'] },
    'dimensions.pays.except',
    'dimensions.pays.except repeats anyOf value "DK"',
  ],
  [
    'an unknown key',
    { anyOf: ['FR'], all: true },
    'dimensions.pays.all',
    'dimensions.pays has an unknown key "all"',
  ],
  ['an empty value', '', 'dimensions.pays', 'dimensions.pays must not be empty'],
  [
    'an empty value in anyOf',
    { anyOf: ['FR', ''] },
    'dimensions.pays.anyOf[1]',
    'dimensions.pays.anyOf[1] must not be empty',
  ],
  [
    'an empty code system',
    ':62',
    'dimensions.pays',
    'dimensions.pays has an empty code system before ":"',
  ],
  ['an empty code', 'nace-2.1:', 'dimensions.pays', 'dimensions.pays has an empty code after ":"'],
  [
    'an empty code system in except',
    { ref: 'ue', anyOf: ['UE'], except: [':62'] },
    'dimensions.pays.except[0]',
    'dimensions.pays.except[0] has an empty code system before ":"',
  ],
  [
    'except without ref',
    { anyOf: ['FR', 'DE'], except: ['DK'] },
    'dimensions.pays.except',
    'dimensions.pays.except needs ref: without a referential a value only equals itself',
  ],
  [
    'an unknown match',
    { anyOf: ['FR'], match: 'some' },
    'dimensions.pays.match',
    'dimensions.pays.match must be "any" or "all"',
  ],
  [
    'an empty ref',
    { ref: '', anyOf: ['FR'] },
    'dimensions.pays.ref',
    'dimensions.pays.ref must be a non-empty string',
  ],
  [
    'a non-string value in anyOf',
    { anyOf: ['FR', 1] },
    'dimensions.pays.anyOf[1]',
    'dimensions.pays.anyOf[1] must be a string',
  ],
  [
    'anyOf that is not an array',
    { anyOf: 'FR' },
    'dimensions.pays.anyOf',
    'dimensions.pays.anyOf must be a non-empty array of values',
  ],
  [
    'except that is not an array',
    { ref: 'ue', anyOf: ['UE'], except: 'DK' },
    'dimensions.pays.except',
    'dimensions.pays.except must be an array of values',
  ],
  [
    'a number',
    1,
    'dimensions.pays',
    'dimensions.pays must be a value or an object { ref?, anyOf, except?, match? }',
  ],
  [
    'an array',
    ['FR'],
    'dimensions.pays',
    'dimensions.pays must be a value or an object { ref?, anyOf, except?, match? }',
  ],
];
