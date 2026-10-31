/**
 * Proof input fixtures shared by tests/proof-input-schema.test.ts: `validateProofInput` and
 * `schema/proof-input.schema.json` must accept and refuse the same documents. Every value is a
 * JSON document (built from JSON-compatible values only).
 */

type Doc = Record<string, unknown>;

const HUMAN = { by: 'agent-7', method: 'human', at: '2026-01-02', status: 'validated' };
const SOURCE = { proofDigest: 'b'.repeat(64), output: 'risque' };

export const BASE_INPUT = {
  data: { revenue: 1000 },
  meta: {
    tenantId: 't1',
    dates: { effective: '2026-01-01' },
    tags: [],
    dimensions: {},
    context: {},
    assertions: {},
  },
};

/** The base input with fields of `meta` replaced. */
export function inputWith(meta: Doc, data: Doc = BASE_INPUT.data): Doc {
  return { data, meta: { ...BASE_INPUT.meta, ...meta } };
}

/** The base input with one assertion on `key`. */
function assertionAt(key: string, assertion: Doc = HUMAN): Doc {
  return inputWith({ assertions: { [key]: assertion } });
}

/** The base input whose assertion on `/revenue` is the human one with `patch`. */
function assertionWith(patch: Doc): Doc {
  return assertionAt('/revenue', { ...HUMAN, ...patch });
}

/** A value whose deepest value is `levels` objects below it. */
function deep(levels: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < levels; i++) value = { a: value };
  return value;
}

export const VALID_INPUTS: [string, Doc][] = [
  ['the base input', BASE_INPUT],
  [
    'named dates, civil and instant',
    inputWith({ dates: { effective: '2026-01-01', facture: '2026-01-01T10:00:00.000Z' } }),
  ],
  ['no named date', inputWith({ dates: {} })],
  ['sorted tags', inputWith({ tags: ['B', 'a', 'b'] })],
  ['a multi-valued dimension', inputWith({ dimensions: { pays: ['FR', 'US'], secteur: 'C' } })],
  ['a qualified dimension value', inputWith({ dimensions: { secteur: 'nace-2.1:62.10' } })],
  [
    'nested data with a key starting with $ below the root',
    inputWith({}, { a: { $x: [1, 'two', null, true, { b: 2 ** 53 - 1 }] }, '': -(2 ** 53 - 1) }),
  ],
  ['a context key starting with $', inputWith({ context: { $trace: 'x' } })],
  ['data 1000 levels deep', inputWith({}, { a: deep(999) })],
  ...['human', 'ai', 'document', 'presumed', 'declared', 'measured', 'estimated', 'derived'].map(
    (method): [string, Doc] => [`an assertion by method ${method}`, assertionWith({ method })],
  ),
  ['a decision assertion', assertionWith({ method: 'decision', source: SOURCE })],
  [
    'a decision assertion with a qualified output and a subject',
    assertionWith({
      method: 'decision',
      source: { ...SOURCE, output: 'rgpd:profilage', subject: '/foyers/@f1/!group=C1' },
    }),
  ],
  ...['proposed', 'contested'].map((status): [string, Doc] => [
    `an assertion with status ${status}`,
    assertionWith({ status }),
  ]),
  [
    'an assertion with every optional field',
    assertionWith({
      at: '2026-01-02T08:00:00.000Z',
      basis: 'art. 4',
      evidenceDigest: 'a'.repeat(64),
      confidence: 0,
      complete: false,
    }),
  ],
  ['confidence 1', assertionWith({ confidence: 1 })],
  ...[
    '',
    '/',
    '/$dates',
    '/$dates/facture',
    '/$dimensions',
    '/$dimensions/pays',
    '/a~1b/~0c/2',
  ].map((key): [string, Doc] => [`an assertion on ${JSON.stringify(key)}`, assertionAt(key)]),
];

export const REFUSED_INPUTS: [string, Doc][] = [
  ['an unknown top-level key', { ...BASE_INPUT, facts: {} }],
  ['no meta', { data: {} }],
  ['the former effectiveDate', inputWith({ effectiveDate: '2026-01-01' })],
  ['data that is a list', { ...BASE_INPUT, data: [] }],
  ['an empty tenant id', inputWith({ tenantId: '' })],
  ['a context that is a list', inputWith({ context: [] })],
  ['an offset date-time', inputWith({ dates: { facture: '2026-01-01T11:00:00+01:00' } })],
  ['a date-time without milliseconds', inputWith({ dates: { facture: '2026-01-01T10:00:00Z' } })],
  ['a day that does not exist', inputWith({ dates: { effective: '2026-02-29' } })],
  ['a repeated tag', inputWith({ tags: ['a', 'a'] })],
  ['a tag that is not a string', inputWith({ tags: [1] })],
  ['a single-valued list', inputWith({ dimensions: { pays: ['FR'] } })],
  ['an empty list', inputWith({ dimensions: { pays: [] } })],
  ['a repeated dimension value', inputWith({ dimensions: { pays: ['FR', 'FR'] } })],
  ['an empty dimension value', inputWith({ dimensions: { pays: '' } })],
  ['a dimension value with an empty system', inputWith({ dimensions: { pays: ':FR' } })],
  ['a dimension name starting with $', inputWith({ dimensions: { $pays: 'FR' } })],
  ['a root data key starting with $', inputWith({}, { $x: 1 })],
  ['data.id = 2 ** 53', inputWith({}, { id: 2 ** 53 })],
  ['data.x = 1e300', inputWith({}, { x: 1e300 })],
  ['a nested -(2 ** 53)', inputWith({}, { a: [{ b: -(2 ** 53) }] })],
  ['a context number beyond 2^53', inputWith({ context: { n: 2 ** 60 } })],
  ['an assertion key that is not a pointer', assertionAt('revenue')],
  ['an assertion on an output', assertionAt('/$outputs/x')],
  ['an assertion on $item', assertionAt('/$item/x')],
  ['an assertion below a named date', assertionAt('/$dates/facture/day')],
  ['an assertion on a reserved dimension', assertionAt('/$dimensions/$pays')],
  ['an assertion key with "-"', assertionAt('/enfants/-/age')],
  ['an assertion key with a bad escape', assertionAt('/a~2')],
  ['an unknown method', assertionWith({ method: 'robot' })],
  ['an unknown status', assertionWith({ status: 'accepted' })],
  ['confidence -0.1', assertionWith({ confidence: -0.1 })],
  ['confidence 1.1', assertionWith({ confidence: 1.1 })],
  ['an uppercase evidence digest', assertionWith({ evidenceDigest: 'A'.repeat(64) })],
  ['a source without method decision', assertionWith({ source: SOURCE })],
  ['method decision without source', assertionWith({ method: 'decision' })],
  ['complete as a text', assertionWith({ complete: 'no' })],
  ['complete: true, the default written out', assertionWith({ complete: true })],
  ['an empty tag', inputWith({ tags: ['', 'a'] })],
  ['an empty dimension name', inputWith({ dimensions: { '': 'FR' } })],
  ['an empty date name', inputWith({ dates: { '': '2026-01-01' } })],
  ['a date name starting with $', inputWith({ dates: { $x: '2026-01-01' } })],
  ['an assertion on a reserved date name', assertionAt('/$dates/$x')],
  ['an assertion on an empty date name', assertionAt('/$dates/')],
  ['an assertion on an empty dimension name', assertionAt('/$dimensions/')],
  ['an offset at', assertionWith({ at: '2026-01-02T09:00:00.000+01:00' })],
  ['an unknown assertion field', assertionWith({ note: 'x' })],
  [
    'an assertion without by',
    assertionAt('/revenue', { method: 'human', at: '2026-01-02', status: 'validated' }),
  ],
  ['an empty basis', assertionWith({ basis: '' })],
  [
    'a source with an unknown key',
    assertionWith({ method: 'decision', source: { ...SOURCE, rule: 'R1' } }),
  ],
  ...['$x', 'a.b', 'local:x', 'a:b:c', 'Pack:x', 'p:$x', 'p:'].map((output): [string, Doc] => [
    `a source output ${JSON.stringify(output)}`,
    assertionWith({ method: 'decision', source: { ...SOURCE, output } }),
  ]),
  [
    'a source subject that is not a pointer',
    assertionWith({ method: 'decision', source: { ...SOURCE, subject: 'foyers' } }),
  ],
];

/** Refused by `validateProofInput` only: JSON Schema cannot express these checks. */
export const VALIDATOR_ONLY_INPUTS: [string, Doc][] = [
  ['unsorted tags', inputWith({ tags: ['b', 'a'] })],
  ['an unsorted dimension list', inputWith({ dimensions: { pays: ['US', 'FR'] } })],
  ['a lone surrogate in a data text', inputWith({}, { name: 'x\uD800' })],
  ['a lone surrogate in a data key', inputWith({}, { 'k\uDC00': 1 })],
  ['a lone surrogate in a tag', inputWith({ tags: ['\uD800'] })],
  ['a lone surrogate in the tenant id', inputWith({ tenantId: 't\uD800' })],
  ['a lone surrogate in an assertion key', assertionAt('/a\uD800')],
  ['data 1001 levels deep', inputWith({}, { a: deep(1000) })],
  [
    'a subject with an unknown reserved segment',
    assertionWith({ method: 'decision', source: { ...SOURCE, subject: '/foyers/!f1' } }),
  ],
  ['a lone surrogate in an assertion by', assertionWith({ by: 'a\uDC00' })],
  [
    'a subject with a reversed segment',
    assertionWith({
      method: 'decision',
      source: { ...SOURCE, subject: '/!segment=2026-02-01..2026-01-01' },
    }),
  ],
];
