/**
 * The shape cases of a decision proof, shared by tests/proof.test.ts (validateProof) and
 * tests/proof-schema.test.ts (JSON schema): each case changes `BASE_PROOF` in one place.
 */
import {
  BASE_PROOF,
  entryWith,
  proofWith,
  proofWithout,
  SIGNATURE_VALUE,
  unsaltedSalt,
} from './proof-cases.js';
import { REFUSED_SECTION_PROOFS } from './proof-refused-cases.js';

const hex = (c: string): string => c.repeat(64);
const salt = unsaltedSalt('rules', 0);
const signature = { alg: 'ed25519', keyId: 'k1', value: SIGNATURE_VALUE };

export const VALID_PROOFS: [string, unknown][] = [
  ['the base proof', BASE_PROOF],
  ['a signature', proofWith({ signature })],
  [
    'every section empty, no optional field',
    proofWith({
      ruleSets: [],
      versions: { engine: '1', plugins: {}, dsls: {}, models: {}, components: [] },
      strata: [],
      requested: undefined,
      supersedes: undefined,
      rules: [],
      outputs: [],
      items: [],
      applied: [],
      skipped: [],
      pending: [],
      exceptions: [],
      factsRead: [],
      missingFacts: [],
      readsUndeclared: [],
    }),
  ],
  ['a null evaluatedAt', proofWith({ evaluatedAt: null })],
  ['an instant evaluatedAt', proofWith({ evaluatedAt: '2024-02-29T23:59:59.999Z' })],
  ['an inputSalted proof', proofWith({ inputSalted: true })],
  ['a fixed-offset time zone', proofWith({ timeZone: '-03:30' })],
  [
    'every rule set kind without its optional members',
    proofWith({
      ruleSets: [
        { kind: 'pack', id: 'p', version: '1', digest: hex('e') },
        { kind: 'local' },
        { kind: 'referential', id: 'ue', version: '1', digest: hex('e') },
      ],
    }),
  ],
  [
    'output values of every JSON kind',
    entryWith('outputs', 2, { value: { a: [1, 'x', null, { b: false }] } }),
  ],
  [
    'an output without value, bounds with min and max, a selection with a subject',
    entryWith('outputs', 3, {
      value: undefined,
      bounds: { min: 'low', max: 'high' },
      selected: { ruleId: 'vat:R2', subject: '/a/@1' },
    }),
  ],
  ['a contribution that is an object', entryWith('applied', 1, { contribution: {} })],
  [
    'an exception of each kind, with subjects',
    proofWith({
      exceptions: ['inhibit', 'substitute', 'shortCircuit'].map((kind) => ({
        ruleId: 'x',
        version: 1,
        subject: '/a/@1',
        kind,
        affected: [{ ruleId: 'r2', subject: '/a/@1' }],
        status: 'provisional',
        stratum: 0,
        salt,
      })),
    }),
  ],
  [
    'a reason the format does not know yet, excluded and pending',
    proofWith({
      skipped: [
        { ruleId: 'r2', version: 2, reason: 'FUTURE_REASON', status: 'conflict', stratum: 0, salt },
      ],
      pending: [
        {
          ruleId: 'r2',
          version: 2,
          reason: 'FUTURE_REASON',
          detail: 'x',
          missing: [],
          stratum: 0,
          salt,
        },
      ],
    }),
  ],
  [
    'each grouped reason',
    proofWith({
      skipped: ['INACTIVE_DATE', 'DIMENSION_MISMATCH', 'TAG_MISMATCH', 'NOT_REQUESTED'].map(
        (reason) => ({
          ruleId: 'k',
          version: 1,
          instances: 2,
          reason,
          status: 'determined',
          stratum: 0,
          salt,
        }),
      ),
    }),
  ],
  [
    'subjects with a group and a time segment',
    entryWith('applied', 0, { subject: '/f/!group=C1/x/!segment=2026-01-01..2026-02-01' }),
  ],
  [
    'pointers with escapes, an empty member name and engine variables',
    proofWith({
      factsRead: [
        { path: '/$dimensions/pays', salt },
        { path: '/', salt },
        { path: '/a~1b/~0', salt },
      ],
      missingFacts: [{ path: '/$dates', salt }],
    }),
  ],
  ['a pending attente on an output', entryWith('pending', 0, { missing: ['/$outputs/value'] })],
  [
    'several strata, an empty one, a large stratum number',
    entryWith('skipped', 1, { stratum: Number.MAX_SAFE_INTEGER }),
  ],
  [
    'a signature value ending in Q',
    proofWith({ signature: { ...signature, value: `${'_'.repeat(85)}Q` } }),
  ],
];

/** Each refused proof, with the one issue validateProof reports: [label, value, path, message]. */
export const REFUSED_PROOFS: [string, unknown, string, string][] = [
  ['an array', [BASE_PROOF], '', 'a decision proof must be a plain object'],
  ['null', null, '', 'a decision proof must be a plain object'],
  ['an unknown key', proofWith({ inputs: {} }), 'inputs', 'proof has an unknown key "inputs"'],
  [
    'the old singular ruleSet',
    proofWith({ ruleSet: { kind: 'pack', id: 'p', version: '1', digest: hex('e') } }),
    'ruleSet',
    'proof has an unknown key "ruleSet"',
  ],
  [
    'an unknown format',
    proofWith({ format: 'run-iq.proof/2' }),
    'format',
    'unknown format: run-iq.proof/2',
  ],
  [
    'an unknown format, with other problems',
    proofWith({ format: 'run-iq.proof/2', inputs: {}, digest: 'x' }),
    'format',
    'unknown format: run-iq.proof/2',
  ],
  [
    'a format that is not a string',
    proofWith({ format: 1 }),
    'format',
    'format must be one of run-iq.proof/1',
  ],
  ...(
    [
      'format',
      'requestId',
      'evaluatedAt',
      'sealedAt',
      'inputDigest',
      'inputSalted',
      'timeZone',
      'ruleSets',
      'versions',
      'strata',
      'rules',
      'outputs',
      'items',
      'applied',
      'skipped',
      'pending',
      'exceptions',
      'factsRead',
      'missingFacts',
      'readsUndeclared',
      'digest',
    ] as const
  ).map((key): [string, unknown, string, string] => [
    `a missing ${key}`,
    proofWithout(key),
    key,
    `${key} is required`,
  ]),
  ['outputs as an object', proofWith({ outputs: {} }), 'outputs', 'outputs must be a list'],
  ['items as an object', proofWith({ items: {} }), 'items', 'items must be a list'],
  [
    'an empty requestId',
    proofWith({ requestId: '' }),
    'requestId',
    'requestId must be a non-empty string',
  ],
  [
    'an evaluatedAt that is not canonical',
    proofWith({ evaluatedAt: '2026-06-01T10:00:00Z' }),
    'evaluatedAt',
    'evaluatedAt must be null, a civil date YYYY-MM-DD or an instant YYYY-MM-DDTHH:MM:SS.sssZ',
  ],
  [
    'a sealedAt that is a civil date',
    proofWith({ sealedAt: '2026-06-01' }),
    'sealedAt',
    'sealedAt must be an instant YYYY-MM-DDTHH:MM:SS.sssZ',
  ],
  [
    'an impossible sealedAt',
    proofWith({ sealedAt: '2025-02-29T00:00:00.000Z' }),
    'sealedAt',
    'sealedAt must be an instant YYYY-MM-DDTHH:MM:SS.sssZ',
  ],
  [
    'an uppercase inputDigest',
    proofWith({ inputDigest: hex('A') }),
    'inputDigest',
    'inputDigest must be a lowercase sha256 hex string',
  ],
  [
    'a short digest',
    proofWith({ digest: 'd'.repeat(63) }),
    'digest',
    'digest must be a lowercase sha256 hex string',
  ],
  [
    'inputSalted as text',
    proofWith({ inputSalted: 'no' }),
    'inputSalted',
    'inputSalted must be a boolean',
  ],
  [
    'a time zone that is not one',
    proofWith({ timeZone: 'Paris' }),
    'timeZone',
    'timeZone must be UTC, ±HH:MM or an IANA name Area/Location',
  ],
  [
    'a time zone not in its normal form',
    proofWith({ timeZone: '+00:00' }),
    'timeZone',
    'timeZone must be written UTC: +00:00 and -00:00 are UTC',
  ],
  [
    'a rule set of another kind',
    proofWith({ ruleSets: [{ kind: 'bundle' }] }),
    'ruleSets[0].kind',
    'ruleSets[0].kind must be one of pack, local, referential',
  ],
  [
    'a rule set that is not an object',
    proofWith({ ruleSets: ['vat'] }),
    'ruleSets[0]',
    'ruleSets[0] must be an object { kind, … }',
  ],
  [
    'a pack named local',
    proofWith({ ruleSets: [{ kind: 'pack', id: 'local', version: '1', digest: hex('e') }] }),
    'ruleSets[0].id',
    'ruleSets[0].id: pack id "local" is reserved: it names the rules without a rule set',
  ],
  [
    'a pack id with a dot',
    proofWith({ ruleSets: [{ kind: 'pack', id: 'p.v2', version: '1', digest: hex('e') }] }),
    'ruleSets[0].id',
    'ruleSets[0].id: pack id "p.v2" must not contain ".": a version is never part of a rule set id',
  ],
  [
    'a pack with empty imports',
    proofWith({
      ruleSets: [{ kind: 'pack', id: 'p', version: '1', digest: hex('e'), imports: [] }],
    }),
    'ruleSets[0].imports',
    'ruleSets[0].imports must not be empty: absent imports nothing',
  ],
  [
    'a pack importing local',
    proofWith({
      ruleSets: [{ kind: 'pack', id: 'p', version: '1', digest: hex('e'), imports: ['local'] }],
    }),
    'ruleSets[0].imports[0]',
    'ruleSets[0].imports[0]: pack id "local" is reserved: it names the rules without a rule set',
  ],
  [
    'a local rule set with an id',
    proofWith({ ruleSets: [{ kind: 'local', id: 'x' }] }),
    'ruleSets[0].id',
    'ruleSets[0] has an unknown key "id"',
  ],
  [
    'a local time zone not in its normal form',
    proofWith({ ruleSets: [{ kind: 'local', timeZone: '-00:00' }] }),
    'ruleSets[0].timeZone',
    'ruleSets[0].timeZone must be written UTC: +00:00 and -00:00 are UTC',
  ],
  [
    'a referential without digest',
    proofWith({ ruleSets: [{ kind: 'referential', id: 'ue', version: '1' }] }),
    'ruleSets[0].digest',
    'ruleSets[0].digest is required',
  ],
  [
    'versions without models',
    proofWith({ versions: { engine: '1', plugins: {}, dsls: {}, components: [] } }),
    'versions.models',
    'versions.models is required',
  ],
  [
    'a plugin with an empty name',
    proofWith({
      versions: { engine: '1', plugins: { '': '1' }, dsls: {}, models: {}, components: [] },
    }),
    'versions.plugins',
    'versions.plugins has an empty name',
  ],
  [
    'a model version that is not a string',
    proofWith({
      versions: { engine: '1', plugins: {}, dsls: {}, models: { M: 1 }, components: [] },
    }),
    'versions.models.M',
    'versions.models.M must be a non-empty string',
  ],
  [
    'a component declared by nobody known',
    proofWith({
      versions: {
        engine: '1',
        plugins: {},
        dsls: {},
        models: {},
        components: [{ name: 'c', version: '1', declaredBy: 'plugin:' }],
      },
    }),
    'versions.components[0].declaredBy',
    'versions.components[0].declaredBy must be engine, plugin:<name> or model:<name>',
  ],
  [
    'a component with a digest that is not sha256',
    proofWith({
      versions: {
        engine: '1',
        plugins: {},
        dsls: {},
        models: {},
        components: [{ name: 'c', version: '1', digest: 'x', declaredBy: 'engine' }],
      },
    }),
    'versions.components[0].digest',
    'versions.components[0].digest must be a lowercase sha256 hex string',
  ],
  [
    'an empty requested',
    proofWith({ requested: [] }),
    'requested',
    'requested must not be empty: absent requests every output',
  ],
  [
    'a requested name with a dot',
    proofWith({ requested: ['a.b'] }),
    'requested[0]',
    'requested[0] name must not contain "."',
  ],
  [
    'a supersedes reason in free text',
    proofWith({ supersedes: { digest: hex('9'), reason: 'Correction du 3 mars' } }),
    'supersedes.reason',
    'supersedes.reason must be a code matching ^[a-z0-9][a-z0-9_-]*$',
  ],
  [
    'a supersedes digest that is not sha256',
    proofWith({ supersedes: { digest: 'x', reason: 'correction' } }),
    'supersedes.digest',
    'supersedes.digest must be a lowercase sha256 hex string',
  ],
  [
    'a rule without salt',
    entryWith('rules', 0, { salt: undefined }),
    'rules[0].salt',
    'rules[0].salt is required',
  ],
  [
    'a salt of 32 bytes',
    entryWith('rules', 0, { salt: hex('a') }),
    'rules[0].salt',
    'rules[0].salt must be 16 bytes in lowercase hex (32 characters)',
  ],
  [
    'a rule without rule set',
    entryWith('rules', 0, { ruleSet: undefined }),
    'rules[0].ruleSet',
    'rules[0].ruleSet is required',
  ],
  [
    'a rule in a rule set that is not an id',
    entryWith('rules', 0, { ruleSet: 'Vat' }),
    'rules[0].ruleSet',
    'rules[0].ruleSet must be a rule set id matching ^[a-z0-9][a-z0-9_-]*$',
  ],
  [
    'a rule id holding a colon',
    entryWith('rules', 0, { id: 'vat:k' }),
    'rules[0].id',
    'rules[0].id must not contain ":": a rule id is qualified by its rule set',
  ],
  [
    'a rule without priority',
    entryWith('rules', 0, { priority: undefined }),
    'rules[0].priority',
    'rules[0].priority is required',
  ],
  [
    'a rule with a priority in text',
    entryWith('rules', 0, { priority: '5000' }),
    'rules[0].priority',
    'rules[0].priority must be a finite number',
  ],
  [
    'a rule with a fractional version',
    entryWith('rules', 0, { version: 1.5 }),
    'rules[0].version',
    'rules[0].version must be a positive integer',
  ],
  ...REFUSED_SECTION_PROOFS,
];

/** JSON Schema cannot express these: only validateProof refuses them. */
export const VALIDATOR_ONLY_PROOFS: [string, unknown, string, string][] = [
  [
    'a rule listed twice in its rule set',
    proofWith({
      rules: [
        { id: 'R1', version: 1, checksum: hex('b'), ruleSet: 'vat', priority: 0, salt },
        { id: 'R1', version: 1, checksum: hex('c'), ruleSet: 'vat', priority: 0, salt },
      ],
    }),
    'rules[1]',
    'rules[1] repeats vat:R1@1',
  ],
  [
    'a lone surrogate in a requestId',
    proofWith({ requestId: 'a\uD800' }),
    'requestId',
    'requestId contains a lone UTF-16 surrogate',
  ],
  [
    'a lone surrogate in a skip reason',
    entryWith('skipped', 1, { reason: '\uDC00' }),
    'skipped[1].reason',
    'skipped[1].reason contains a lone UTF-16 surrogate',
  ],
  [
    'a time segment that ends before it starts',
    entryWith('applied', 0, { subject: '/f/!segment=2026-02-01..2026-01-01' }),
    'applied[0].subject',
    'applied[0].subject must be a subject: a JSON pointer whose ! segments are ' +
      '!group=<value> or !segment=<from>..<until>',
  ],
];
