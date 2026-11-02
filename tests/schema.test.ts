import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  normalizeRuleDefinition,
  validateReferential,
  validateRuleDefinition,
} from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';
import { REFUSED_DIMENSIONS } from './dimension-cases.js';
import { REFUSED_EXCEPTIONS } from './exception-cases.js';
import { ACCEPTED_FOR_EACH, REFUSED_FOR_EACH, VALIDATOR_ONLY_FOR_EACH } from './forEach-cases.js';
import { nestedReferential, ueReferential } from './helpers.js';

const schema = JSON.parse(
  readFileSync(new URL('../schema/rule-definition.schema.json', import.meta.url), 'utf8'),
) as object;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const schemaAccepts = ajv.compile(schema);

const base = {
  id: 'r1',
  version: 1,
  model: 'PERCENTAGE',
  params: { rate: 0.05, base: 'orderTotal' },
  priority: 1,
  effectiveFrom: '2025-01-01',
};

function without(key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...base };
  delete copy[key];
  return copy;
}

function normalizeAccepts(value: unknown): boolean {
  try {
    normalizeRuleDefinition(value as RuleDefinitionInput);
    return true;
  } catch {
    return false;
  }
}

const VALID: [string, unknown][] = [
  ['the minimal definition', base],
  [
    'every named field and extensions',
    {
      ...base,
      condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'x' }, 1] } },
      effectiveUntil: '2026-01-01',
      timeZone: 'Europe/Paris',
      effectiveOn: '/$dates/facture',
      output: 'tax',
      dimensions: { country: 'TG' },
      tags: ['vat'],
      dominanceGroup: 'VAT',
      exceptions: [{ kind: 'inhibit', targets: { ids: ['r0'] } }],
      sourceRef: 'CGI art. 1',
      extensions: { jurisdiction: 'NATIONAL', meta: { nested: [1, 'a', null] }, gone: null },
    },
  ],
  [
    'effectiveUntil null (the written form of no end) and a null checksum',
    { ...base, effectiveUntil: null, checksum: null },
  ],
  ['an empty extensions object', { ...base, extensions: {} }],
  [
    'structured dimensions',
    {
      ...base,
      dimensions: {
        pays: { ref: 'ue', anyOf: ['UE', 'NO', 'UE'], except: ['DK'], match: 'all' },
        regime: { anyOf: ['normal'] },
        activite: 'nace-2.1:62.10',
        empty: { ref: 'ue', anyOf: ['UE'], except: [] },
      },
    },
  ],
  [
    'null as data in params and condition.value',
    { ...base, params: null, condition: { dsl: 'x', value: null } },
  ],
  [
    'a date-time with Z and 3 fraction digits',
    { ...base, effectiveFrom: '2025-01-01T10:20:30.123Z' },
  ],
  ['a date-time with an offset', { ...base, effectiveFrom: '2025-01-01T10:30:00+05:30' }],
  ['civil leap days', { ...base, effectiveFrom: '2024-02-29', effectiveUntil: '2400-02-29' }],
  [
    'instant leap days',
    {
      ...base,
      effectiveFrom: '2024-02-29T00:00:00Z',
      effectiveUntil: '2400-02-29T00:00:00-23:59',
    },
  ],
  ['an offset time zone', { ...base, timeZone: '-09:30' }],
  [
    'effectiveOn on an item, with forEach',
    { ...base, effectiveOn: '/$item/emission', forEach: { path: '/factures', key: 'id' } },
  ],
  [
    'effectiveOn on a segment, with forEach.segments',
    {
      ...base,
      effectiveOn: '/$segment/from',
      forEach: { segments: { from: '/$dates/a', until: '/$dates/b', facts: [] } },
    },
  ],
  [
    'a large integer version, a negative fractional priority',
    { ...base, version: 1e6, priority: -2.5 },
  ],
  ['duplicate tags and a string checksum', { ...base, tags: ['b', 'a', 'b'], checksum: 'abc' }],
  [
    'a window of one millisecond',
    {
      ...base,
      effectiveFrom: '2025-01-01T00:00:00Z',
      effectiveUntil: '2025-01-01T00:00:00.001Z',
    },
  ],
];

const INVALID: [string, unknown][] = [
  ...[
    'condition',
    'output',
    'dimensions',
    'tags',
    'dominanceGroup',
    'exceptions',
    'sourceRef',
    'timeZone',
    'effectiveOn',
    'ruleSet',
    'forEach',
    'extensions',
  ].map((field): [string, unknown] => [`a null ${field}`, { ...base, [field]: null }]),
  ['a null dimension value', { ...base, dimensions: { a: 'TG', b: null } }],
  ['an unknown top-level field', { ...base, jurisdiction: 'NATIONAL' }],
  ['a misspelled top-level field', { ...base, dominancegroup: 'g' }],
  ['an unknown field with a null value', { ...base, jurisdiction: null }],
  ['extensions that is a list', { ...base, extensions: [] }],
  ['extensions that is a string', { ...base, extensions: 'x' }],
  ['a missing id', without('id')],
  ['a missing params', without('params')],
  ['a missing effectiveFrom', without('effectiveFrom')],
  ['an empty model', { ...base, model: '' }],
  ['a non-numeric priority', { ...base, priority: '1' }],
  ['a fractional version', { ...base, version: 1.5 }],
  ['a zero version', { ...base, version: 0 }],
  ['a non-string dimension value', { ...base, dimensions: { country: 1 } }],
  ...REFUSED_DIMENSIONS.filter(([label]) => label !== 'an except value also in anyOf').map(
    ([label, spec]): [string, unknown] => [
      `dimensions: ${label}`,
      { ...base, dimensions: { pays: spec } },
    ],
  ),
  ['a reserved dimension name (I1)', { ...base, dimensions: { $pays: 'FR' } }],
  ['an empty dimension name', { ...base, dimensions: { '': 'FR' } }],
  ['the dimension name "-"', { ...base, dimensions: { '-': 'FR' } }],
  ['an empty tag', { ...base, tags: [''] }],
  ['effectiveOn on a date name starting with $', { ...base, effectiveOn: '/$dates/$x' }],
  ['a non-string tag', { ...base, tags: ['a', 1] }],
  ['an impossible date', { ...base, effectiveFrom: '2025-02-30' }],
  ['a non-leap February 29', { ...base, effectiveFrom: '2023-02-29' }],
  ['a date-time without a time zone (A8)', { ...base, effectiveFrom: '2025-01-01T00:00' }],
  ['an invalid effectiveUntil', { ...base, effectiveUntil: '2025-13-01' }],
  ['four fraction digits', { ...base, effectiveFrom: '2025-01-01T00:00:00.1234Z' }],
  ['a date-time without seconds', { ...base, effectiveFrom: '2025-01-01T00:00Z' }],
  ['a civil from and an instant until (I7b)', { ...base, effectiveUntil: '2026-01-01T00:00:00Z' }],
  [
    'an instant from and a civil until (I7b)',
    { ...base, effectiveFrom: '2025-01-01T00:00:00Z', effectiveUntil: '2026-01-01' },
  ],
  ['a time zone without area', { ...base, timeZone: 'Paris' }],
  ['a lowercase time zone', { ...base, timeZone: 'europe/paris' }],
  ['an offset time zone +24:00', { ...base, timeZone: '+24:00' }],
  ['an empty time zone', { ...base, timeZone: '' }],
  ['a numeric time zone', { ...base, timeZone: 1 }],
  ['effectiveOn on a fact', { ...base, effectiveOn: '/revenue' }],
  ['effectiveOn that is not a pointer', { ...base, effectiveOn: 'revenue' }],
  ['effectiveOn with a bad escape', { ...base, effectiveOn: '/$dates/a~2' }],
  ['effectiveOn on a nested date', { ...base, effectiveOn: '/$dates/a/b' }],
  ['effectiveOn without a date name', { ...base, effectiveOn: '/$dates/' }],
  ["effectiveOn with a '-' segment", { ...base, effectiveOn: '/$dates/-' }],
  ['effectiveOn on $segment/until', { ...base, effectiveOn: '/$segment/until' }],
  ['effectiveOn on an item, without forEach', { ...base, effectiveOn: '/$item/emission' }],
  [
    'effectiveOn on an item, with a null forEach',
    { ...base, effectiveOn: '/$item/emission', forEach: null },
  ],
  [
    'effectiveOn on a segment, without segments',
    { ...base, effectiveOn: '/$segment/from', forEach: { path: '/a', key: 'id' } },
  ],
  [
    'effectiveOn on a segment, with null segments',
    { ...base, effectiveOn: '/$segment/from', forEach: { segments: null } },
  ],
  ['a numeric effectiveOn', { ...base, effectiveOn: 7 }],
  ['an unknown condition key', { ...base, condition: { dsl: 'x', value: 1, extra: true } }],
  ['a condition without value', { ...base, condition: { dsl: 'x' } }],
  ['an empty output', { ...base, output: '' }],
  ['a reserved output name (R36)', { ...base, output: '$outputs' }],
  ['an output name starting with $ (R36)', { ...base, output: '$' }],
  ['an array instead of an object', [base]],
];

/** JSON Schema cannot compare two fields: only the validator (and normalize) reject these. */
const VALIDATOR_ONLY: [string, unknown][] = [
  ['an empty window (until == from)', { ...base, effectiveUntil: '2025-01-01' }],
  ['a reversed window (until < from)', { ...base, effectiveUntil: '2024-12-31' }],
  [
    'an offset that moves the instant before year 0000',
    { ...base, effectiveFrom: '0000-01-01T00:00:00+00:01' },
  ],
  ['a lone surrogate in an effectiveOn date name', { ...base, effectiveOn: '/$dates/\uD800' }],
  [
    'an except value also in anyOf',
    { ...base, dimensions: { pays: { ref: 'ue', anyOf: ['UE', 'DK'], except: ['DK'] } } },
  ],
];

describe('validateRuleDefinition, JSON schema and normalize agree', () => {
  it('has at least 10 valid and 10 invalid cases', () => {
    expect(VALID.length).toBeGreaterThanOrEqual(10);
    expect(INVALID.length).toBeGreaterThanOrEqual(10);
  });

  it.each(VALID)('accepts %s', (_name, value) => {
    expect(validateRuleDefinition(value)).toEqual({ valid: true, errors: [], issues: [] });
    expect(schemaAccepts(value)).toBe(true);
    expect(normalizeAccepts(value)).toBe(true);
  });

  it.each(INVALID)('rejects %s', (_name, value) => {
    const result = validateRuleDefinition(value);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(schemaAccepts(value)).toBe(false);
    expect(normalizeAccepts(value)).toBe(false);
  });

  it.each(VALIDATOR_ONLY)('validator-only: rejects %s (the schema cannot)', (_name, value) => {
    expect(validateRuleDefinition(value).valid).toBe(false);
    expect(normalizeAccepts(value)).toBe(false);
    expect(schemaAccepts(value)).toBe(true);
  });

  it('the schema documents the validator-only window check', () => {
    expect(JSON.stringify(schema)).toMatch(/effectiveUntil.*after.*effectiveFrom/);
    expect(JSON.stringify(schema)).toMatch(/years 0000 to 9999/);
    expect(JSON.stringify(schema)).toMatch(/lone UTF-16 surrogate/);
    expect(JSON.stringify(schema)).toMatch(/except.*repeat.*anyOf/);
  });
});

describe('exceptions: validator, JSON schema and normalize agree', () => {
  const carrier = {
    ...base,
    model: '@run-iq/exception',
    params: {},
    exceptions: [{ kind: 'inhibit', targets: { tags: ['vat'] } }],
  };

  const accepted: [string, unknown][] = [
    ['an empty list (absent)', { ...base, exceptions: [] }],
    [
      'every kind',
      {
        ...base,
        exceptions: [
          { kind: 'inhibit', targets: { ids: ['a', 'a'], tags: ['t', 't'] } },
          {
            kind: 'substitute',
            targets: { dimensions: { country: 'TG' }, outputs: ['vat'], models: ['M'] },
            params: { rate: 0.1, nested: { x: null } },
          },
          { kind: 'shortCircuit', output: 'eligible', value: null, reason: 'exempt' },
        ],
      },
    ],
    [
      'an empty field next to a non-empty one',
      { ...base, exceptions: [{ kind: 'inhibit', targets: { ids: [], dimensions: { c: 'x' } } }] },
    ],
    [
      'a structured selector dimension',
      {
        ...base,
        exceptions: [
          {
            kind: 'inhibit',
            targets: { dimensions: { pays: { ref: 'ue', anyOf: ['NO', 'UE'] } } },
          },
        ],
      },
    ],
    ['a rule of the exception model', carrier],
    ["the exception model with output 'value', the default", { ...carrier, output: 'value' }],
    [
      'the exception model of a pack with its own default output',
      { ...carrier, ruleSet: 'rgpd', output: 'rgpd:value' },
    ],
    ['an output on another model', { ...base, output: 'tax', exceptions: carrier.exceptions }],
  ];

  /** JSON Schema cannot compare except with anyOf: only the validator refuses it. */
  const validatorOnly = 'a dimension spec whose except repeats anyOf';
  const refused: [string, unknown][] = [
    ...REFUSED_EXCEPTIONS.filter(([label]) => label !== validatorOnly).map(
      ([label, exceptions]): [string, unknown] => [label, { ...base, exceptions }],
    ),
    ['the exception model without exceptions', { ...carrier, exceptions: undefined }],
    ['the exception model with null exceptions', { ...carrier, exceptions: null }],
    ['the exception model with an empty list', { ...carrier, exceptions: [] }],
    ['the exception model with an output', { ...carrier, output: 'tax' }],
    [
      'the exception model with an own-set output',
      { ...carrier, ruleSet: 'rgpd', output: 'rgpd:x' },
    ],
    ["the exception model with local's default output", { ...carrier, output: 'local:value' }],
  ];

  it.each(accepted)('accepts %s', (_name, value) => {
    expect(validateRuleDefinition(value)).toEqual({ valid: true, errors: [], issues: [] });
    expect(schemaAccepts(value)).toBe(true);
    expect(normalizeAccepts(value)).toBe(true);
  });

  it.each(refused)('rejects %s', (_name, value) => {
    expect(validateRuleDefinition(value).valid).toBe(false);
    expect(schemaAccepts(value)).toBe(false);
    expect(normalizeAccepts(value)).toBe(false);
  });

  it.each([
    ['a local rule', { ...carrier, output: 'rgpd:value' }],
    ['a rule of another pack', { ...carrier, ruleSet: 'interne', output: 'rgpd:value' }],
  ])(
    "validator-only: rejects another set's value on the exception model, in %s",
    (_label, value) => {
      expect(validateRuleDefinition(value).valid).toBe(false);
      expect(normalizeAccepts(value)).toBe(false);
      expect(schemaAccepts(value)).toBe(true);
    },
  );

  it('the schema documents the validator-only exception model output check', () => {
    expect(JSON.stringify(schema)).toMatch(/exception.*value.*qualified by another rule set/);
    const text = JSON.stringify(schema);
    expect(text).toMatch(/selector output of local is refused.*only local rules feed it/);
    expect(text).toMatch(/output of another rule set S is refused.*a pack that imports S/);
  });

  it('validator-only: rejects a selector whose except repeats anyOf (the schema cannot)', () => {
    const [, exceptions] = REFUSED_EXCEPTIONS.find(([label]) => label === validatorOnly) ?? [];
    const value = { ...base, exceptions };
    expect(exceptions).toBeDefined();
    expect(validateRuleDefinition(value).valid).toBe(false);
    expect(normalizeAccepts(value)).toBe(false);
    expect(schemaAccepts(value)).toBe(true);
  });
});

describe('date pattern parity', () => {
  const dates = [
    '2025-01-01',
    '2024-02-29',
    '2000-02-29',
    '1900-02-29',
    '0000-02-29',
    '2023-02-29',
    '2025-04-31',
    '2025-04-30',
    '2025-12-31',
    '2025-00-10',
    '2025-01-00',
    '2025-1-01',
    ' 2025-01-01',
    '2025-01-01 ',
    '2025-01-01T00:00Z',
    '2025-01-01T23:59:59Z',
    '2025-01-01T24:00Z',
    '2025-01-01T00:60Z',
    '2025-01-01T00:00:60Z',
    '2025-01-01T00:00:00.1Z',
    '2025-01-01T00:00:00.123456789Z',
    '2025-01-01T00:00:00.1234567891Z',
    '2025-01-01T00:00:00.Z',
    '2025-01-01T00:00:00z',
    '2025-01-01t00:00:00Z',
    '2025-01-01 00:00:00Z',
    '2025-01-01T00:00+00:00',
    '2025-01-01T00:00-23:59',
    '2025-01-01T00:00+24:00',
    '2025-01-01T00:00+05:60',
    '2025-01-01T00:00+0500',
    '2025-01-01T00:00+05',
    '2025-01-01T00:00',
    '2025-01-01T00:00:00',
    '20250101',
    '',
    '0000-01-01',
    '9999-12-31',
    '2025-01-01T00:00:00Z',
    '2025-01-01T00:00:00.123Z',
    '2025-01-01T00:00:00.1234Z',
    '2025-01-01T00:00:00+23:59',
    '2025-01-01T00:00:00-14:00',
    '9999-12-31T23:59:59.999Z',
    '+12025-01-01T00:00:00Z',
  ];

  it.each(dates)('schema, validator and normalize agree on %j', (date) => {
    const value = { ...base, effectiveFrom: date };
    const expected = normalizeAccepts(value);
    expect(validateRuleDefinition(value).valid).toBe(expected);
    expect(schemaAccepts(value)).toBe(expected);
  });
});

describe('time zone and effectiveOn pattern parity', () => {
  const zones = [
    'UTC',
    '+01:00',
    '-09:30',
    '+23:59',
    '+24:00',
    '+01:60',
    'Europe/Paris',
    'America/Argentina/Buenos_Aires',
    'Etc/GMT+5',
    'America/Port-au-Prince',
    'Paris',
    'europe/paris',
    'Europe/9x',
    'Europe//Paris',
    'Europe/Paris/',
    'utc',
    '',
  ];

  it.each(zones)('schema, validator and normalize agree on the time zone %j', (timeZone) => {
    const value = { ...base, timeZone };
    const expected = normalizeAccepts(value);
    expect(validateRuleDefinition(value).valid).toBe(expected);
    expect(schemaAccepts(value)).toBe(expected);
  });

  const pointers = [
    '/$dates/facture',
    '/$dates/a~0b~1c',
    '/$dates/',
    '/$dates',
    '/$dates/-',
    '/$dates/--',
    '/$dates/a/b',
    '/$item/x',
    '/$item/',
    '/$item/-',
    '/$item/a/-/b',
    '/$item/a/0',
    '/$segment/from',
    '/$segment/from/x',
    '/$segment',
    '/$segments/from',
    '/$datesX/a',
    '/revenue',
    '',
    '/',
    '/$dates/a~',
  ];

  const forms: [string, unknown][] = [
    ['a collection', { path: '/x', key: 'id' }],
    ['segments', { segments: { from: '/$dates/a', until: '/$dates/b', facts: [] } }],
    ['a grouping', { path: '/x', key: 'id', groupBy: '/g' }],
  ];
  const cases = pointers.flatMap((pointer) =>
    forms.map(([form, forEach]): [string, string, unknown] => [pointer, form, forEach]),
  );

  it.each(cases)(
    'schema, validator and normalize agree on effectiveOn %j with %s',
    (effectiveOn, _form, forEach) => {
      const value = { ...base, effectiveOn, forEach };
      const expected = normalizeAccepts(value);
      expect(validateRuleDefinition(value).valid).toBe(expected);
      expect(schemaAccepts(value)).toBe(expected);
    },
  );

  it('accepts $item only with an ungrouped collection, $segment only with segments', () => {
    const accepted = cases
      .filter(([pointer, , forEach]) => {
        const value = { ...base, effectiveOn: pointer, forEach };
        return pointer.startsWith('/$item/') && normalizeAccepts(value);
      })
      .map(([, form]) => form);
    expect(new Set(accepted)).toEqual(new Set(['a collection']));
    const segment = { ...base, effectiveOn: '/$segment/from' };
    expect(forms.filter(([, forEach]) => normalizeAccepts({ ...segment, forEach }))).toEqual([
      forms[1],
    ]);
  });
});

describe('forEach: validator, JSON schema and normalize agree', () => {
  it.each(ACCEPTED_FOR_EACH)('accepts %s', (_label, forEach) => {
    const value = { ...base, forEach };
    expect(validateRuleDefinition(value)).toEqual({ valid: true, errors: [], issues: [] });
    expect(schemaAccepts(value)).toBe(true);
    expect(normalizeAccepts(value)).toBe(true);
  });

  it.each(REFUSED_FOR_EACH)('rejects %s', (_label, forEach) => {
    const value = { ...base, forEach };
    expect(validateRuleDefinition(value).valid).toBe(false);
    expect(schemaAccepts(value)).toBe(false);
    expect(normalizeAccepts(value)).toBe(false);
  });

  it.each(VALIDATOR_ONLY_FOR_EACH)('validator-only: rejects %s (the schema cannot)', (_l, fe) => {
    const value = { ...base, forEach: fe };
    expect(validateRuleDefinition(value).valid).toBe(false);
    expect(normalizeAccepts(value)).toBe(false);
    expect(schemaAccepts(value)).toBe(true);
  });

  it('the schema documents the validator-only forEach checks', () => {
    const text = JSON.stringify(schema);
    expect(text).toMatch(/one name per level/);
    expect(text).toMatch(/orderBy.*path.*once/);
    expect(text).toMatch(/segments\.from and segments\.until.*differ/);
  });

  const paths = [
    '/a',
    '/a/*/b',
    '/a/*/b/*/c',
    '/a/b/*/c/d',
    '/*',
    '/a/*',
    '/*/a',
    '/a/*/*/b',
    '/a//b',
    '/',
    '/a/-',
    '/-',
    '/a/--',
    '/a/@b',
    '/a/!b',
    '/a/b@',
    '/a/~1@b',
    '/@a',
    '/$a',
    '/a/$b',
    '/~0$a',
    '/a/*/~1',
    '/a~',
    '',
    'a',
    '/a/**',
    '/a/*x',
  ];
  it.each(paths)('schema, validator and normalize agree on the path %j', (path) => {
    const levels = path.split('/*/').length;
    const value = { ...base, forEach: { path, key: Array(levels).fill('id') } };
    const expected = normalizeAccepts(value);
    expect(validateRuleDefinition(value).valid).toBe(expected);
    expect(schemaAccepts(value)).toBe(expected);
  });

  const members = ['/a', '/a/b', '', '/', '/*', '/a/*/b', '/-', '/a/-', '/@a', '/!a', '/$a', 'a'];
  it.each(members)('schema, validator and normalize agree on the member %j', (member) => {
    const forEaches = [
      { path: '/x', key: 'id', orderBy: [{ path: member, type: 'string', dir: 'asc' }] },
      { path: '/x', key: 'id', dimensions: { d: member } },
      { path: '/x', key: 'id', recurse: member },
      { path: '/x', key: 'id', groupBy: member },
      { segments: { from: '/$dates/a', until: '/$dates/b', facts: [member] } },
      { segments: { from: member, until: '/$dates/b', facts: [] } },
    ];
    for (const forEach of forEaches) {
      const value = { ...base, forEach };
      const expected = normalizeAccepts(value);
      expect(validateRuleDefinition(value).valid).toBe(expected);
      expect(schemaAccepts(value)).toBe(expected);
    }
  });
});

describe('rule sets and qualified names: validator, JSON schema and normalize agree', () => {
  const accepted: [string, unknown][] = [
    ['a pack rule', { ...base, ruleSet: 'rgpd' }],
    ['an explicit local rule', { ...base, ruleSet: 'local' }],
    ['a qualified output', { ...base, output: 'rgpd:profilage' }],
    ['a rule set with "-"', { ...base, ruleSet: 'p-v2', output: 'p-v2:x' }],
    [
      'a selector with rule sets and qualified names',
      {
        ...base,
        exceptions: [
          {
            kind: 'inhibit',
            targets: { ruleSets: ['rgpd', 'local'], ids: ['rgpd:R1', 'R2'], outputs: ['rgpd:x'] },
          },
        ],
      },
    ],
    [
      'a shortCircuit to a qualified output',
      { ...base, exceptions: [{ kind: 'shortCircuit', output: 'tva:taux', value: 0 }] },
    ],
  ];

  const refused: [string, unknown][] = [
    ['an id with ":"', { ...base, id: 'a:b' }],
    ['a capitalized rule set', { ...base, ruleSet: 'Local' }],
    ['a rule set with ":"', { ...base, ruleSet: 'a:b' }],
    ['an empty rule set', { ...base, ruleSet: '' }],
    ['a numeric rule set', { ...base, ruleSet: 1 }],
    ['an output with two ":"', { ...base, output: 'a:b:c' }],
    ['an output reserved after its rule set', { ...base, output: 'pack:$x' }],
    ['an output with "."', { ...base, output: 'a.b' }],
    ['a qualified output with "."', { ...base, output: 'pack:a.b' }],
    ['an output of a rule set with "."', { ...base, output: 'p.v2:x' }],
    ['a rule set with "."', { ...base, ruleSet: 'p.v2' }],
    [
      'a selector rule set with "."',
      { ...base, exceptions: [{ kind: 'inhibit', targets: { ruleSets: ['p.v2'], tags: ['t'] } }] },
    ],
    [
      'a selector id of a rule set with "."',
      { ...base, exceptions: [{ kind: 'inhibit', targets: { ids: ['p.v2:R1'] } }] },
    ],
    ['an output qualified by local', { ...base, output: 'local:x' }],
    ['an output qualified by an invalid set', { ...base, output: 'P:x' }],
    ['an output with an empty rule set', { ...base, output: ':x' }],
    ['an output with an empty name', { ...base, output: 'pack:' }],
  ];

  /** JSON Schema cannot relate a selector's ids to the rule's own rule set. */
  const validatorOnly: [string, unknown][] = [
    [
      'an id of a rule set the selector does not target',
      { ...base, exceptions: [{ kind: 'inhibit', targets: { ids: ['rgpd:R1'] } }] },
    ],
    [
      'a bare id while ruleSets leaves out the carrier',
      {
        ...base,
        ruleSet: 'aiact',
        exceptions: [{ kind: 'inhibit', targets: { ruleSets: ['rgpd'], ids: ['R1'] } }],
      },
    ],
  ];

  it.each(accepted)('accepts %s', (_name, value) => {
    expect(validateRuleDefinition(value)).toEqual({ valid: true, errors: [], issues: [] });
    expect(schemaAccepts(value)).toBe(true);
    expect(normalizeAccepts(value)).toBe(true);
  });

  it.each(refused)('rejects %s', (_name, value) => {
    expect(validateRuleDefinition(value).valid).toBe(false);
    expect(schemaAccepts(value)).toBe(false);
    expect(normalizeAccepts(value)).toBe(false);
  });

  it.each(validatorOnly)('validator-only: rejects %s (the schema cannot)', (_name, value) => {
    expect(validateRuleDefinition(value).valid).toBe(false);
    expect(normalizeAccepts(value)).toBe(false);
    expect(schemaAccepts(value)).toBe(true);
  });

  it('the schema documents the validator-only selector check', () => {
    expect(JSON.stringify(schema)).toMatch(/ids.*rule set.*not target/);
  });
});

describe('validateRuleDefinition beyond JSON', () => {
  it('accepts a Date, like normalize', () => {
    expect(validateRuleDefinition({ ...base, effectiveFrom: new Date(0) }).valid).toBe(true);
  });

  it('rejects non-JSON values, like normalize', () => {
    for (const params of [
      new Map(),
      new Set(),
      NaN,
      Infinity,
      { toJSON: () => 1 },
      new Date(NaN),
    ]) {
      const value = { ...base, params: { x: params } };
      expect(validateRuleDefinition(value).valid).toBe(false);
      expect(normalizeAccepts(value)).toBe(false);
    }
  });

  it('collects every error and names the field', () => {
    const { valid, errors } = validateRuleDefinition({
      ...base,
      id: 1,
      priority: 'x',
      dimensions: { country: 1 },
    });
    expect(valid).toBe(false);
    expect(errors).toHaveLength(3);
    expect(errors.join('\n')).toMatch(/id/);
    expect(errors.join('\n')).toMatch(/priority/);
    expect(errors.join('\n')).toMatch(/dimensions\.country/);
  });

  it('returns structured issues alongside the error strings', () => {
    const result = validateRuleDefinition({
      ...base,
      id: 1,
      params: { rates: [0.1, Number.NaN] },
      effectiveUntil: '2024-01-01',
      dimensions: { country: 1 },
      condition: { dsl: 'jsonlogic' },
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.path)).toEqual([
      'id',
      'params.rates[1]',
      'effectiveUntil',
      'condition.value',
      'dimensions.country',
    ]);
    expect(result.errors).toEqual(result.issues.map((i) => i.message));
  });

  it('gives an empty path to a problem with the whole value', () => {
    expect(validateRuleDefinition(1).issues).toEqual([
      { path: '', message: 'a rule definition must be a plain object' },
    ]);
  });

  it('returns no issue for a valid definition', () => {
    expect(validateRuleDefinition(base)).toEqual({ valid: true, errors: [], issues: [] });
  });

  it('never throws', () => {
    for (const value of [undefined, null, 1, 'x', [], new Map()]) {
      expect(validateRuleDefinition(value).valid).toBe(false);
    }
  });
});

describe('validateReferential and the referential JSON schema agree', () => {
  const referentialSchema = JSON.parse(
    readFileSync(new URL('../schema/referential.schema.json', import.meta.url), 'utf8'),
  ) as object;
  const referentialAccepts = ajv.compile(referentialSchema);
  const ue = ueReferential();
  const coded = {
    ...ue,
    codeSystem: 'iso-3166',
    codes: { FR: [{ from: '1958-01-01', until: null }], NO: [{ from: '1958-01-01', until: null }] },
    groups: { UE: { exhaustive: true, members: [{ value: 'FR', until: null }] } },
  };
  const group = (members: unknown): unknown => ({
    ...ue,
    groups: { A: { exhaustive: true, members } },
  });

  const accepted: [string, unknown][] = [
    ['the ue referential', ue],
    ['codes, a code system and a member with until null', coded],
    ['an empty group', { ...ue, groups: { A: { exhaustive: false, members: [] } } }],
    ['a code period without until', { ...coded, codes: { FR: [{ from: '1958-01-01' }] } }],
    ['an identical member twice', group([{ value: 'x' }, { value: 'x', until: null }])],
    ['a qualified-looking dimension name', { ...ue, dimension: 'pays:naissance' }],
    [
      'sourceRef at every level',
      {
        ...coded,
        sourceRef: 'Traité de Rome',
        codes: { ...coded.codes, FR: [{ from: '1958-01-01', until: null, sourceRef: 'a' }] },
        groups: {
          UE: { exhaustive: true, sourceRef: 'b', members: [{ value: 'FR', sourceRef: 'c' }] },
        },
      },
    ],
  ];

  const refused: [string, unknown][] = [
    ['an unknown format', { ...ue, format: 'run-iq.referential/2' }],
    ['an unknown key', { ...ue, name: 'Union' }],
    ['a missing id', { ...ue, id: undefined }],
    ['an empty version', { ...ue, version: '' }],
    ['missing groups', { ...ue, groups: undefined }],
    ['a group without exhaustive', { ...ue, groups: { A: { members: [] } } }],
    [
      'a group with an unknown key',
      { ...ue, groups: { A: { exhaustive: true, members: [], x: 1 } } },
    ],
    ['members that are not an array', { ...ue, groups: { A: { exhaustive: true, members: {} } } }],
    ['a member with an unknown key', group([{ value: 'x', since: '2000-01-01' }])],
    ['a member without value', group([{ from: '2000-01-01' }])],
    ['an empty member value', group([{ value: '' }])],
    ['a qualified member value', group([{ value: 'iso:FR' }])],
    ['an impossible member date', group([{ value: 'x', from: '2023-02-29' }])],
    ['a null member from', group([{ value: 'x', from: null }])],
    ['a qualified group name', { ...ue, groups: { 'iso:A': { exhaustive: true, members: [] } } }],
    ['an empty group name', { ...ue, groups: { '': { exhaustive: true, members: [] } } }],
    ['a qualified code', { ...coded, codes: { 'iso:FR': [{ from: '1958-01-01', until: null }] } }],
    ['a code without period', { ...coded, codes: { FR: [] } }],
    [
      'a code period with a numeric until',
      { ...coded, codes: { FR: [{ from: '1958-01-01', until: 1 }] } },
    ],
    ['a code system with ":"', { ...ue, codeSystem: 'iso:3166' }],
    ['an empty code system', { ...ue, codeSystem: '' }],
    ['an empty sourceRef', { ...ue, sourceRef: '' }],
    ['a numeric member sourceRef', group([{ value: 'x', sourceRef: 1 }])],
    [
      'a null group sourceRef',
      { ...ue, groups: { A: { exhaustive: true, members: [], sourceRef: null } } },
    ],
    ['an array', [ue]],
  ];

  /** JSON Schema cannot follow references, compare dates or count: the validator alone can. */
  const validatorOnly: [string, unknown][] = [
    ['a cycle', { ...ue, groups: { A: { exhaustive: true, members: [{ value: 'A' }] } } }],
    ['an empty period', group([{ value: 'x', from: '2020-01-01', until: '2019-01-01' }])],
    [
      'a member twice on overlapping periods',
      group([{ value: 'x' }, { value: 'x', from: '2000-01-01' }]),
    ],
    [
      'a code that is also a group',
      { ...coded, groups: { FR: { exhaustive: true, members: [] } } },
    ],
    [
      'a member neither group nor code',
      { ...coded, groups: { UE: { exhaustive: true, members: [{ value: 'DE' }] } } },
    ],
    ['nesting deeper than 64', nestedReferential(65)],
    ['a lone surrogate', group([{ value: 'x\uD800' }])],
  ];

  it.each(accepted)('accepts %s', (_name, value) => {
    expect(validateReferential(value)).toEqual([]);
    expect(referentialAccepts(value)).toBe(true);
  });

  it.each(refused)('rejects %s', (_name, value) => {
    expect(validateReferential(value)).not.toEqual([]);
    expect(referentialAccepts(value)).toBe(false);
  });

  it.each(validatorOnly)('validator-only: rejects %s (the schema cannot)', (_name, value) => {
    expect(validateReferential(value)).not.toEqual([]);
    expect(referentialAccepts(value)).toBe(true);
  });

  it('the schema documents the validator-only checks', () => {
    const text = JSON.stringify(referentialSchema);
    expect(text).toMatch(/cycle/);
    expect(text).toMatch(/until.*after.*from/);
    expect(text).toMatch(/64/);
    expect(text).toMatch(/100 ?000/);
  });
});
