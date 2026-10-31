/**
 * `forEach` values, shared by tests/forEach.test.ts (validator and normalize) and
 * tests/schema.test.ts (JSON schema).
 */

/** Each accepted `forEach`, with its normal form. */
export const ACCEPTED_FOR_EACH: [string, unknown, unknown][] = [
  ['one level', { path: '/enfants', key: 'id' }, { path: '/enfants', key: 'id' }],
  [
    'groupBy with an empty orderBy, as absent (review round 4)',
    { path: '/operations', key: 'id', groupBy: '/client', orderBy: [] },
    { path: '/operations', key: 'id', groupBy: '/client' },
  ],
  [
    'groupBy with empty dimensions, as absent (review round 4)',
    { path: '/operations', key: 'id', groupBy: '/client', dimensions: {} },
    { path: '/operations', key: 'id', groupBy: '/client' },
  ],
  [
    'two levels, one key per level',
    { path: '/foyers/*/personnes', key: ['fid', 'pid'] },
    { path: '/foyers/*/personnes', key: ['fid', 'pid'] },
  ],
  [
    'two levels, the same key at each level',
    { path: '/foyers/*/personnes', key: 'id' },
    { path: '/foyers/*/personnes', key: 'id' },
  ],
  [
    'a typed order',
    { path: '/enfants', key: 'id', orderBy: [{ path: '/naissance', type: 'date', dir: 'asc' }] },
    { path: '/enfants', key: 'id', orderBy: [{ path: '/naissance', type: 'date', dir: 'asc' }] },
  ],
  [
    'every order type, both directions, order kept',
    {
      path: '/lignes',
      key: 'id',
      orderBy: [
        { path: '/rang', type: 'number', dir: 'desc' },
        { path: '/montant', type: 'decimal', dir: 'asc' },
        { path: '/jour', type: 'date', dir: 'desc' },
        { path: '/heure', type: 'dateTime', dir: 'asc' },
        { path: '/nom', type: 'string', dir: 'asc' },
      ],
    },
    {
      path: '/lignes',
      key: 'id',
      orderBy: [
        { path: '/rang', type: 'number', dir: 'desc' },
        { path: '/montant', type: 'decimal', dir: 'asc' },
        { path: '/jour', type: 'date', dir: 'desc' },
        { path: '/heure', type: 'dateTime', dir: 'asc' },
        { path: '/nom', type: 'string', dir: 'asc' },
      ],
    },
  ],
  [
    'dimensions per element',
    { path: '/lignes', key: 'id', dimensions: { pays: '/pays' } },
    { path: '/lignes', key: 'id', dimensions: { pays: '/pays' } },
  ],
  [
    'a recursion',
    { path: '/composants', key: 'ref', recurse: '/composants' },
    { path: '/composants', key: 'ref', recurse: '/composants' },
  ],
  [
    'a grouping',
    { path: '/operations', key: 'id', groupBy: '/client' },
    { path: '/operations', key: 'id', groupBy: '/client' },
  ],
  [
    'time segments',
    { segments: { from: '/$dates/debut', until: '/$dates/fin', facts: ['/salaire'] } },
    { segments: { from: '/$dates/debut', until: '/$dates/fin', facts: ['/salaire'] } },
  ],
  [
    'segments without facts',
    { segments: { from: '/$dates/debut', until: '/$dates/fin', facts: [] } },
    { segments: { from: '/$dates/debut', until: '/$dates/fin', facts: [] } },
  ],
  [
    'escaped segments, an index and an empty member',
    {
      path: '/a~1b/0//c~0',
      key: 'id',
      orderBy: [{ path: '/x~1y', type: 'string', dir: 'asc' }],
      dimensions: { d: '/a//b' },
    },
    {
      path: '/a~1b/0//c~0',
      key: 'id',
      orderBy: [{ path: '/x~1y', type: 'string', dir: 'asc' }],
      dimensions: { d: '/a//b' },
    },
  ],
  [
    'members that look like engine names, inside an element',
    {
      path: '/x/$y',
      key: '$id',
      orderBy: [{ path: '/$rang', type: 'number', dir: 'asc' }],
      recurse: '/a*/b-',
    },
    {
      path: '/x/$y',
      key: '$id',
      orderBy: [{ path: '/$rang', type: 'number', dir: 'asc' }],
      recurse: '/a*/b-',
    },
  ],
];

const SUBJECT_SEGMENT = 'must not start with "@" or "!": these mark subjects';

/** Each refused `forEach` (the JSON schema refuses it too), with its first issue. */
export const REFUSED_FOR_EACH: [string, unknown, string, string][] = [
  [
    'a string',
    '/enfants',
    'forEach',
    'forEach must be an object { path, key, orderBy?, dimensions?, recurse?, groupBy? } ' +
      'or { segments }',
  ],
  [
    'an array',
    [{ path: '/enfants', key: 'id' }],
    'forEach',
    'forEach must be an object { path, key, orderBy?, dimensions?, recurse?, groupBy? } ' +
      'or { segments }',
  ],
  [
    'an unknown key',
    { path: '/enfants', key: 'id', order: 'asc' },
    'forEach.order',
    'forEach has an unknown key "order"',
  ],
  [
    'no path',
    { key: 'id' },
    'forEach.path',
    'forEach.path is required: the JSON pointer to the collection',
  ],
  [
    'a numeric path',
    { path: 1, key: 'id' },
    'forEach.path',
    'forEach.path must be a JSON pointer: got a value of type number',
  ],
  [
    'a path that is not a pointer',
    { path: 'enfants', key: 'id' },
    'forEach.path',
    'forEach.path must be a JSON pointer: invalid JSON pointer "enfants": ' +
      'must be empty or start with "/"',
  ],
  [
    'the root as path',
    { path: '', key: 'id' },
    'forEach.path',
    'forEach.path must name a collection, not the whole input',
  ],
  [
    'a path ending with *',
    { path: '/foyers/*', key: 'id' },
    'forEach.path',
    'forEach.path must end with a collection name, not "*"',
  ],
  [
    'a path starting with *',
    { path: '/*/personnes', key: 'id' },
    'forEach.path',
    'forEach.path must start with a collection name, not "*"',
  ],
  [
    'two * in a row',
    { path: '/a/*/*/b', key: 'id' },
    'forEach.path',
    'forEach.path must name a collection between two "*"',
  ],
  [
    "a '-' segment in the path",
    { path: '/a/-/b', key: 'id' },
    'forEach.path',
    "forEach.path must not hold a '-' segment: '-' is not an index",
  ],
  [
    'a literal @ segment',
    { path: '/foyers/@x', key: 'id' },
    'forEach.path',
    `forEach.path segment "@x" ${SUBJECT_SEGMENT}`,
  ],
  [
    'a literal ! segment',
    { path: '/!x/personnes', key: 'id' },
    'forEach.path',
    `forEach.path segment "!x" ${SUBJECT_SEGMENT}`,
  ],
  [
    'a path into an engine variable',
    { path: '/$outputs/liste', key: 'id' },
    'forEach.path',
    'forEach.path must point into the input data: "$outputs" is an engine variable',
  ],
  [
    'no key',
    { path: '/enfants' },
    'forEach.key',
    'forEach.key is required: the member that identifies each element',
  ],
  [
    'a numeric key',
    { path: '/enfants', key: 1 },
    'forEach.key',
    'forEach.key must be a member name or a list of member names, one per level',
  ],
  ['an empty key', { path: '/enfants', key: '' }, 'forEach.key', 'forEach.key must not be empty'],
  [
    'an empty key name in a list',
    { path: '/foyers/*/personnes', key: ['fid', ''] },
    'forEach.key[1]',
    'forEach.key[1] must be a non-empty string',
  ],
  [
    'a null key name in a list',
    { path: '/foyers/*/personnes', key: [null, 'pid'] },
    'forEach.key[0]',
    'forEach.key[0] must be a non-empty string',
  ],
  [
    'an empty key list',
    { path: '/enfants', key: [] },
    'forEach.key',
    'forEach.key has 0 names for 1 level',
  ],
  [
    'orderBy that is not a list',
    { path: '/enfants', key: 'id', orderBy: { path: '/a', type: 'date', dir: 'asc' } },
    'forEach.orderBy',
    'forEach.orderBy must be a list of order keys { path, type, dir }',
  ],
  [
    'an order key that is not an object',
    { path: '/enfants', key: 'id', orderBy: ['/naissance'] },
    'forEach.orderBy[0]',
    'forEach.orderBy[0] must be an order key { path, type, dir }',
  ],
  [
    'an order key with an unknown key',
    { path: '/enfants', key: 'id', orderBy: [{ path: '/a', type: 'date', dir: 'asc', x: 1 }] },
    'forEach.orderBy[0].x',
    'forEach.orderBy[0] has an unknown key "x"',
  ],
  [
    'an order key without path',
    { path: '/enfants', key: 'id', orderBy: [{ type: 'date', dir: 'asc' }] },
    'forEach.orderBy[0].path',
    'forEach.orderBy[0].path must be a JSON pointer: got a value of type undefined',
  ],
  [
    'an order key on the element itself',
    { path: '/enfants', key: 'id', orderBy: [{ path: '', type: 'date', dir: 'asc' }] },
    'forEach.orderBy[0].path',
    'forEach.orderBy[0].path must name a member of the element, not the element itself',
  ],
  [
    'an order key with *',
    { path: '/enfants', key: 'id', orderBy: [{ path: '/a/*/b', type: 'date', dir: 'asc' }] },
    'forEach.orderBy[0].path',
    'forEach.orderBy[0].path must not hold a "*" segment: it names one value',
  ],
  [
    "an order key with a '-' segment",
    { path: '/enfants', key: 'id', orderBy: [{ path: '/a/-', type: 'date', dir: 'asc' }] },
    'forEach.orderBy[0].path',
    "forEach.orderBy[0].path must not hold a '-' segment: '-' is not an index",
  ],
  [
    'an unknown order type',
    { path: '/enfants', key: 'id', orderBy: [{ path: '/a', type: 'boolean', dir: 'asc' }] },
    'forEach.orderBy[0].type',
    'forEach.orderBy[0].type must be one of number, decimal, date, dateTime, string',
  ],
  [
    'an order without type',
    { path: '/enfants', key: 'id', orderBy: [{ path: '/a', dir: 'asc' }] },
    'forEach.orderBy[0].type',
    'forEach.orderBy[0].type must be one of number, decimal, date, dateTime, string',
  ],
  [
    'a direction other than asc or desc',
    { path: '/enfants', key: 'id', orderBy: [{ path: '/a', type: 'date', dir: 'up' }] },
    'forEach.orderBy[0].dir',
    'forEach.orderBy[0].dir must be asc or desc',
  ],
  [
    'an order without direction',
    { path: '/enfants', key: 'id', orderBy: [{ path: '/a', type: 'date' }] },
    'forEach.orderBy[0].dir',
    'forEach.orderBy[0].dir must be asc or desc',
  ],
  [
    'dimensions that are not an object',
    { path: '/lignes', key: 'id', dimensions: ['/pays'] },
    'forEach.dimensions',
    'forEach.dimensions must be an object of JSON pointers into the element',
  ],
  [
    'a reserved dimension name',
    { path: '/lignes', key: 'id', dimensions: { $pays: '/pays' } },
    'forEach.dimensions.$pays',
    'forEach.dimensions.$pays must not start with "$": dimension names starting with "$" ' +
      'are reserved',
  ],
  [
    'an empty dimension name',
    { path: '/lignes', key: 'id', dimensions: { '': '/pays' } },
    'forEach.dimensions',
    'forEach.dimensions must not have an empty dimension name',
  ],
  [
    'a dimension that is not a pointer',
    { path: '/lignes', key: 'id', dimensions: { pays: 'pays' } },
    'forEach.dimensions.pays',
    'forEach.dimensions.pays must be a JSON pointer: invalid JSON pointer "pays": ' +
      'must be empty or start with "/"',
  ],
  [
    'a dimension on the element itself',
    { path: '/lignes', key: 'id', dimensions: { pays: '' } },
    'forEach.dimensions.pays',
    'forEach.dimensions.pays must name a member of the element, not the element itself',
  ],
  [
    'a recursion with *',
    { path: '/composants', key: 'ref', recurse: '/*' },
    'forEach.recurse',
    'forEach.recurse must not hold a "*" segment: it names one value',
  ],
  [
    'a recursion through an @ segment',
    { path: '/composants', key: 'ref', recurse: '/@enfants' },
    'forEach.recurse',
    `forEach.recurse segment "@enfants" ${SUBJECT_SEGMENT}`,
  ],
  [
    'a grouping on the element itself',
    { path: '/operations', key: 'id', groupBy: '' },
    'forEach.groupBy',
    'forEach.groupBy must name a member of the element, not the element itself',
  ],
  [
    'a numeric grouping',
    { path: '/operations', key: 'id', groupBy: 3 },
    'forEach.groupBy',
    'forEach.groupBy must be a JSON pointer: got a value of type number',
  ],
  [
    'recurse and groupBy together',
    { path: '/composants', key: 'ref', recurse: '/composants', groupBy: '/client' },
    'forEach.groupBy',
    'forEach.recurse and forEach.groupBy cannot be combined',
  ],
  [
    'dimensions and groupBy together',
    { path: '/operations', key: 'id', groupBy: '/client', dimensions: { pays: '/pays' } },
    'forEach.dimensions',
    'forEach.dimensions cannot be combined with forEach.groupBy: ' +
      'a group has no single element to read them from',
  ],
  [
    'orderBy and groupBy together (review M4)',
    {
      path: '/operations',
      key: 'id',
      groupBy: '/client',
      orderBy: [{ path: '/date', type: 'date', dir: 'asc' }],
    },
    'forEach.orderBy',
    'forEach.orderBy cannot be combined with forEach.groupBy: ' +
      'the order of groups is not defined yet',
  ],
  [
    'segments with a path',
    { path: '/a', segments: { from: '/$dates/a', until: '/$dates/b', facts: [] } },
    'forEach.path',
    'forEach.path cannot be combined with forEach.segments',
  ],
  [
    'segments that are not an object',
    { segments: ['/$dates/a', '/$dates/b'] },
    'forEach.segments',
    'forEach.segments must be an object { from, until, facts }',
  ],
  [
    'null segments',
    { segments: null },
    'forEach.segments',
    'forEach.segments must be an object { from, until, facts }',
  ],
  [
    'segments with an unknown key',
    { segments: { from: '/$dates/a', until: '/$dates/b', facts: [], step: 'month' } },
    'forEach.segments.step',
    'forEach.segments has an unknown key "step"',
  ],
  [
    'segments from a fact',
    { segments: { from: '/debut', until: '/$dates/b', facts: [] } },
    'forEach.segments.from',
    'forEach.segments.from must name a date: /$dates/<name>',
  ],
  [
    'segments until an item date',
    { segments: { from: '/$dates/a', until: '/$item/fin', facts: [] } },
    'forEach.segments.until',
    'forEach.segments.until must name a date: /$dates/<name>',
  ],
  [
    'segments from a nested date',
    { segments: { from: '/$dates/a/b', until: '/$dates/b', facts: [] } },
    'forEach.segments.from',
    'forEach.segments.from must name a date: /$dates/<name>',
  ],
  [
    'segments without until',
    { segments: { from: '/$dates/a', facts: [] } },
    'forEach.segments.until',
    'forEach.segments.until must be a JSON pointer: got a value of type undefined',
  ],
  [
    'segments without facts',
    { segments: { from: '/$dates/a', until: '/$dates/b' } },
    'forEach.segments.facts',
    'forEach.segments.facts must be a list of JSON pointers to facts',
  ],
  [
    'a fact in $',
    { segments: { from: '/$dates/a', until: '/$dates/b', facts: ['/$dates/a'] } },
    'forEach.segments.facts[0]',
    'forEach.segments.facts[0] must point into the input data: "$dates" is an engine variable',
  ],
  [
    'the whole input as a fact',
    { segments: { from: '/$dates/a', until: '/$dates/b', facts: [''] } },
    'forEach.segments.facts[0]',
    'forEach.segments.facts[0] must name a fact, not the whole input',
  ],
  [
    'a fact with *',
    { segments: { from: '/$dates/a', until: '/$dates/b', facts: ['/a/*/b'] } },
    'forEach.segments.facts[0]',
    'forEach.segments.facts[0] must not hold a "*" segment: it names one value',
  ],
  [
    'a numeric fact',
    { segments: { from: '/$dates/a', until: '/$dates/b', facts: ['/a', 7] } },
    'forEach.segments.facts[1]',
    'forEach.segments.facts[1] must be a JSON pointer: got a value of type number',
  ],
];

/** Refused by the validator and normalize; JSON Schema cannot count, compare or relate. */
export const VALIDATOR_ONLY_FOR_EACH: [string, unknown, string, string][] = [
  [
    'three key names for two levels',
    { path: '/foyers/*/personnes', key: ['a', 'b', 'c'] },
    'forEach.key',
    'forEach.key has 3 names for 2 levels',
  ],
  [
    'two key names for one level',
    { path: '/enfants', key: ['a', 'b'] },
    'forEach.key',
    'forEach.key has 2 names for 1 level',
  ],
  [
    'one key name for three levels',
    { path: '/a/*/b/*/c', key: ['id'] },
    'forEach.key',
    'forEach.key has 1 name for 3 levels',
  ],
  [
    'an order key repeated',
    {
      path: '/enfants',
      key: 'id',
      orderBy: [
        { path: '/naissance', type: 'date', dir: 'asc' },
        { path: '/naissance', type: 'string', dir: 'desc' },
      ],
    },
    'forEach.orderBy[1].path',
    'forEach.orderBy[1].path repeats forEach.orderBy[0].path: ' +
      'a key already compared cannot break a tie',
  ],
  [
    'segments from and until the same date',
    { segments: { from: '/$dates/a', until: '/$dates/a', facts: [] } },
    'forEach.segments.until',
    'forEach.segments.until must differ from forEach.segments.from: the period would be empty',
  ],
];
