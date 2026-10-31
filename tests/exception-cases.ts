/**
 * Each refused `exceptions` value, with the path and message of its first problem. Shared by
 * tests/exceptions.test.ts (validator and normalize) and tests/schema.test.ts (JSON schema).
 */
export const REFUSED_EXCEPTIONS: [string, unknown, string, string][] = [
  [
    'a non-array',
    { kind: 'inhibit', targets: { ids: ['a'] } },
    'exceptions',
    'exceptions must be an array of exceptions',
  ],
  ['a non-object item', ['a'], 'exceptions[0]', 'exceptions[0] must be an object with a kind'],
  [
    'an unknown kind',
    [{ kind: 'override', targets: { ids: ['a'] } }],
    'exceptions[0].kind',
    'exceptions[0].kind must be one of inhibit, substitute, shortCircuit',
  ],
  [
    'a missing kind',
    [{ targets: { ids: ['a'] } }],
    'exceptions[0].kind',
    'exceptions[0].kind must be one of inhibit, substitute, shortCircuit',
  ],
  [
    'an unknown key',
    [{ kind: 'inhibit', targets: { ids: ['a'] }, params: {} }],
    'exceptions[0].params',
    'exceptions[0] has an unknown key "params" for kind inhibit',
  ],
  [
    'missing targets',
    [{ kind: 'inhibit' }],
    'exceptions[0].targets',
    'exceptions[0].targets must be a selector { ids?, tags?, dimensions?, outputs?, models? }',
  ],
  [
    'an empty selector',
    [{ kind: 'inhibit', targets: {} }],
    'exceptions[0].targets',
    'exceptions[0].targets must constrain at least one of ids, tags, dimensions, outputs, models: an empty selector would target every rule',
  ],
  [
    'a selector whose fields are all empty',
    [{ kind: 'inhibit', targets: { ids: [], tags: [], dimensions: {}, outputs: [], models: [] } }],
    'exceptions[0].targets',
    'exceptions[0].targets must constrain at least one of ids, tags, dimensions, outputs, models: an empty selector would target every rule',
  ],
  [
    'an unknown selector key',
    [{ kind: 'inhibit', targets: { ids: ['a'], group: 'VAT' } }],
    'exceptions[0].targets.group',
    'exceptions[0].targets has an unknown key "group"',
  ],
  [
    'a selector field that is not an array',
    [{ kind: 'inhibit', targets: { ids: 'a' } }],
    'exceptions[0].targets.ids',
    'exceptions[0].targets.ids must be an array of non-empty strings',
  ],
  [
    'an empty id',
    [{ kind: 'inhibit', targets: { ids: ['a', ''] } }],
    'exceptions[0].targets.ids[1]',
    'exceptions[0].targets.ids[1] must be a non-empty string',
  ],
  [
    'a non-string tag',
    [{ kind: 'inhibit', targets: { tags: ['vat', 1] } }],
    'exceptions[0].targets.tags[1]',
    'exceptions[0].targets.tags[1] must be a string',
  ],
  [
    'tags that are not an array',
    [{ kind: 'inhibit', targets: { tags: 'vat' } }],
    'exceptions[0].targets.tags',
    'exceptions[0].targets.tags must be an array of strings',
  ],
  [
    'a null selector field',
    [{ kind: 'inhibit', targets: { ids: null, tags: ['vat'] } }],
    'exceptions[0].targets.ids',
    'exceptions[0].targets.ids must be an array of non-empty strings',
  ],
  [
    'an empty model',
    [{ kind: 'inhibit', targets: { models: [''] } }],
    'exceptions[0].targets.models[0]',
    'exceptions[0].targets.models[0] must be a non-empty string',
  ],
  [
    'an empty output name',
    [{ kind: 'inhibit', targets: { outputs: [''] } }],
    'exceptions[0].targets.outputs[0]',
    'exceptions[0].targets.outputs[0] must be a non-empty string',
  ],
  [
    'dimensions that are not an object',
    [{ kind: 'inhibit', targets: { dimensions: ['TG'] } }],
    'exceptions[0].targets.dimensions',
    'exceptions[0].targets.dimensions must be an object of strings',
  ],
  [
    'a null dimension value',
    [{ kind: 'inhibit', targets: { dimensions: { country: null } } }],
    'exceptions[0].targets.dimensions.country',
    'exceptions[0].targets.dimensions.country must be a string',
  ],
  [
    'substitute without params',
    [{ kind: 'substitute', targets: { ids: ['a'] } }],
    'exceptions[0].params',
    'exceptions[0].params must be an object of parameters to merge',
  ],
  [
    'substitute with array params',
    [{ kind: 'substitute', targets: { ids: ['a'] }, params: [0.1] }],
    'exceptions[0].params',
    'exceptions[0].params must be an object of parameters to merge',
  ],
  [
    'substitute with null params',
    [{ kind: 'substitute', targets: { ids: ['a'] }, params: null }],
    'exceptions[0].params',
    'exceptions[0].params must be an object of parameters to merge',
  ],
  [
    'shortCircuit without output',
    [{ kind: 'shortCircuit', value: 0 }],
    'exceptions[0].output',
    'exceptions[0].output must be a non-empty string',
  ],
  [
    'shortCircuit with an empty output',
    [{ kind: 'shortCircuit', output: '', value: 0 }],
    'exceptions[0].output',
    'exceptions[0].output must be a non-empty string',
  ],
  [
    'shortCircuit without value',
    [{ kind: 'shortCircuit', output: 'vat' }],
    'exceptions[0].value',
    'exceptions[0].value is required (null is a value)',
  ],
  [
    'shortCircuit with an empty reason',
    [{ kind: 'shortCircuit', output: 'vat', value: 0, reason: '' }],
    'exceptions[0].reason',
    'exceptions[0].reason must be a non-empty string',
  ],
  [
    'shortCircuit with a non-string reason',
    [{ kind: 'shortCircuit', output: 'vat', value: 0, reason: 1 }],
    'exceptions[0].reason',
    'exceptions[0].reason must be a non-empty string',
  ],
  [
    'shortCircuit with targets',
    [{ kind: 'shortCircuit', output: 'vat', value: 0, targets: { ids: ['a'] } }],
    'exceptions[0].targets',
    'exceptions[0] has an unknown key "targets" for kind shortCircuit',
  ],
  [
    'a bad second item after a good one',
    [
      { kind: 'inhibit', targets: { ids: ['a'] } },
      { kind: 'inhibit', targets: {} },
    ],
    'exceptions[1].targets',
    'exceptions[1].targets must constrain at least one of ids, tags, dimensions, outputs, models: an empty selector would target every rule',
  ],
];
