/**
 * Decision proof fixtures shared by tests/proof.test.ts (validateProof) and
 * tests/proof-schema.test.ts (JSON schema), so the two cannot drift apart. Every value is a
 * JSON document; `digest` is only checked for its shape here, not against the content.
 */

const hex = (c: string): string => c.repeat(64);

/** A signature value of the right shape: 86 base64url characters, 64 bytes. */
export const SIGNATURE_VALUE = `${'A'.repeat(85)}w`;

export const BASE_PROOF = {
  format: 'run-iq.proof/1',
  requestId: 'req-1',
  evaluatedAt: '2025-06-01',
  sealedAt: '2025-06-01T10:00:00.000Z',
  inputDigest: hex('a'),
  rules: [
    { id: 'r1', version: 1, checksum: hex('b'), sourceRef: 'art. 1' },
    { id: 'r2', version: 2, checksum: hex('c') },
  ],
  versions: {
    engine: '1.0.0-next.1',
    plugins: { '@run-iq/plugin-test': '1.0.0' },
    dsls: { jsonlogic: '0.2.0' },
  },
  strata: [['value']],
  outputs: { value: { type: 'number', combine: 'sum', value: 150, contributors: ['r1'] } },
  applied: [
    {
      ruleId: 'r1',
      version: 1,
      model: 'FLAT',
      output: 'value',
      contribution: 150,
      stratum: 0,
      sourceRef: 'art. 1',
    },
  ],
  skipped: [{ ruleId: 'r2', version: 2, reason: 'CONDITION_FALSE', stratum: 0 }],
  exceptions: [],
  digest: hex('d'),
};

type Proof = Record<string, unknown>;

export function proofWith(patch: Proof): Proof {
  return { ...BASE_PROOF, ...patch };
}

export function proofWithout(key: string): Proof {
  const copy: Proof = { ...BASE_PROOF };
  delete copy[key];
  return copy;
}

const rule = BASE_PROOF.rules[1];
const step = BASE_PROOF.applied[0];
const skip = BASE_PROOF.skipped[0];
const output = BASE_PROOF.outputs.value;
const exception = { ruleId: 'x', version: 1, kind: 'inhibit', affected: ['r2'], stratum: 0 };
const rounding = { scale: 2, mode: 'halfEven', at: 'contribution' };
const signature = { alg: 'ed25519', keyId: 'k1', value: SIGNATURE_VALUE };

export const VALID_PROOFS: [string, unknown][] = [
  ['the base proof', BASE_PROOF],
  [
    'every optional field',
    proofWith({
      ruleSet: { kind: 'pack', id: 'vat-pack', version: '2025.1', digest: hex('e') },
      signature,
      skipped: [{ ...skip, detail: 'r2@2: income <= 0' }],
    }),
  ],
  [
    'empty lists and maps',
    proofWith({
      rules: [],
      versions: { engine: '1', plugins: {}, dsls: {} },
      outputs: {},
      applied: [],
      skipped: [],
    }),
  ],
  ['a null evaluatedAt', proofWith({ evaluatedAt: null })],
  [
    'dates with an offset and a leap day',
    proofWith({ evaluatedAt: '2024-02-29', sealedAt: '2025-06-01T12:00+05:30' }),
  ],
  [
    'output values of every JSON kind',
    proofWith({
      outputs: {
        none: { type: 'object', combine: 'highestPriority', value: null, contributors: [] },
        flags: { type: 'list', combine: 'union', value: ['a', 1, { b: null }], contributors: [] },
        eligible: { type: 'boolean', combine: 'all', value: true, contributors: ['r1', 'r2'] },
        level: { type: 'enum', combine: 'highestPriority', value: 'high', contributors: ['r1'] },
      },
    }),
  ],
  [
    'an exception of each kind and an empty detail',
    proofWith({
      exceptions: [
        exception,
        { ...exception, kind: 'substitute' },
        { ...exception, kind: 'shortCircuit', affected: [] },
      ],
      skipped: [{ ...skip, detail: '' }],
    }),
  ],
  ['a contribution that is an object', proofWith({ applied: [{ ...step, contribution: {} }] })],
  [
    'a rounded decimal output and the contribution before rounding',
    proofWith({
      outputs: {
        value: { type: 'decimal', combine: 'sum', value: '150.13', contributors: ['r1'], rounding },
      },
      applied: [{ ...step, contribution: '150.13', unrounded: '150.125' }],
    }),
  ],
  [
    'a rounded number output, without at, and a null unrounded',
    proofWith({
      outputs: { value: { ...output, rounding: { scale: 0, mode: 'floor' } } },
      applied: [{ ...step, unrounded: null }],
    }),
  ],
  [
    'several strata, an empty one included, and large stratum numbers',
    proofWith({
      strata: [['value'], [], ['fine', 'risk']],
      applied: [{ ...step, stratum: 2 }],
      skipped: [{ ...skip, stratum: Number.MAX_SAFE_INTEGER }],
      exceptions: [{ ...exception, stratum: 1 }],
    }),
  ],
  ['no stratum at all', proofWith({ strata: [] })],
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
  ['a missing format', proofWithout('format'), 'format', 'format is required'],
  ['a missing digest', proofWithout('digest'), 'digest', 'digest is required'],
  ['a missing outputs', proofWithout('outputs'), 'outputs', 'outputs is required'],
  ['a missing evaluatedAt', proofWithout('evaluatedAt'), 'evaluatedAt', 'evaluatedAt is required'],
  [
    'an empty requestId',
    proofWith({ requestId: '' }),
    'requestId',
    'requestId must be a non-empty string',
  ],
  [
    'an evaluatedAt without a time zone',
    proofWith({ evaluatedAt: '2025-06-01T10:00' }),
    'evaluatedAt',
    'evaluatedAt must be null or an ISO date: YYYY-MM-DD, or a date-time with Z or an offset',
  ],
  [
    'an impossible sealedAt',
    proofWith({ sealedAt: '2025-02-30T00:00:00Z' }),
    'sealedAt',
    'sealedAt must be an ISO date: YYYY-MM-DD, or a date-time with Z or an offset',
  ],
  [
    'a null sealedAt',
    proofWith({ sealedAt: null }),
    'sealedAt',
    'sealedAt must be an ISO date: YYYY-MM-DD, or a date-time with Z or an offset',
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
  ['rules not an array', proofWith({ rules: {} }), 'rules', 'rules must be an array'],
  [
    'a rule that is not an object',
    proofWith({ rules: ['r1@1'] }),
    'rules[0]',
    'rules[0] must be an object { id, version, checksum, sourceRef? }',
  ],
  [
    'a rule with an unknown key',
    proofWith({ rules: [{ ...rule, model: 'FLAT' }] }),
    'rules[0].model',
    'rules[0] has an unknown key "model"',
  ],
  [
    'a rule with a fractional version',
    proofWith({ rules: [{ ...rule, version: 1.5 }] }),
    'rules[0].version',
    'rules[0].version must be a positive integer',
  ],
  [
    'a rule without checksum',
    proofWith({ rules: [{ id: 'r2', version: 2 }] }),
    'rules[0].checksum',
    'rules[0].checksum is required',
  ],
  [
    'a rule with an empty sourceRef',
    proofWith({ rules: [{ ...rule, sourceRef: '' }] }),
    'rules[0].sourceRef',
    'rules[0].sourceRef must be a non-empty string',
  ],
  [
    'a rule set of another kind',
    proofWith({ ruleSet: { kind: 'bundle', id: 'p', version: '1', digest: hex('e') } }),
    'ruleSet.kind',
    'ruleSet.kind must be "pack"',
  ],
  [
    'a null rule set',
    proofWith({ ruleSet: null }),
    'ruleSet',
    'ruleSet must be an object { kind, id, version, digest }',
  ],
  [
    'a rule set with a numeric version',
    proofWith({ ruleSet: { kind: 'pack', id: 'p', version: 1, digest: hex('e') } }),
    'ruleSet.version',
    'ruleSet.version must be a non-empty string',
  ],
  [
    'versions without dsls',
    proofWith({ versions: { engine: '1', plugins: {} } }),
    'versions.dsls',
    'versions.dsls is required',
  ],
  [
    'a plugin version that is not a string',
    proofWith({ versions: { engine: '1', plugins: { p: 1 }, dsls: {} } }),
    'versions.plugins.p',
    'versions.plugins.p must be a non-empty string',
  ],
  [
    'a plugin with an empty name',
    proofWith({ versions: { engine: '1', plugins: { '': '1' }, dsls: {} } }),
    'versions.plugins',
    'versions.plugins has an empty name',
  ],
  [
    'dsls as an array',
    proofWith({ versions: { engine: '1', plugins: {}, dsls: [] } }),
    'versions.dsls',
    'versions.dsls must be an object of non-empty strings',
  ],
  [
    'outputs as an array',
    proofWith({ outputs: [] }),
    'outputs',
    'outputs must be an object of outputs',
  ],
  [
    'an output with an empty name',
    proofWith({ outputs: { '': output } }),
    'outputs',
    'outputs has an empty name',
  ],
  [
    'an output that is not an object',
    proofWith({ outputs: { value: 150 } }),
    'outputs.value',
    'outputs.value must be an object { type, combine, value, contributors, rounding? }',
  ],
  [
    'an output of an unknown type',
    proofWith({ outputs: { value: { ...output, type: 'money' } } }),
    'outputs.value.type',
    'outputs.value.type must be one of number, boolean, string, enum, list, object, decimal',
  ],
  [
    'an output with an unknown strategy',
    proofWith({ outputs: { value: { ...output, combine: 'avg' } } }),
    'outputs.value.combine',
    'outputs.value.combine must be one of sum, max, min, highestPriority, union, all, any',
  ],
  [
    'an output without value',
    proofWith({ outputs: { value: { type: 'number', combine: 'sum', contributors: [] } } }),
    'outputs.value.value',
    'outputs.value.value is required',
  ],
  [
    'an output with an unknown key',
    proofWith({ outputs: { value: { ...output, values: ['a'] } } }),
    'outputs.value.values',
    'outputs.value has an unknown key "values"',
  ],
  [
    'an empty contributor',
    proofWith({ outputs: { value: { ...output, contributors: ['r1', ''] } } }),
    'outputs.value.contributors[1]',
    'outputs.value.contributors[1] must be a non-empty string',
  ],
  [
    'contributors as a string',
    proofWith({ outputs: { value: { ...output, contributors: 'r1' } } }),
    'outputs.value.contributors',
    'outputs.value.contributors must be an array',
  ],
  [
    'a step without contribution',
    proofWith({
      applied: [{ ruleId: 'r1', version: 1, model: 'FLAT', output: 'value', stratum: 0 }],
    }),
    'applied[0].contribution',
    'applied[0].contribution is required',
  ],
  [
    'a step with an empty output',
    proofWith({ applied: [{ ...step, output: '' }] }),
    'applied[0].output',
    'applied[0].output must be a non-empty string',
  ],
  [
    'a step that is not an object',
    proofWith({ applied: [null] }),
    'applied[0]',
    'applied[0] must be an object ' +
      '{ ruleId, version, model, output, contribution, stratum, unrounded?, sourceRef? }',
  ],
  [
    'a skip with a numeric detail',
    proofWith({ skipped: [{ ...skip, detail: 1 }] }),
    'skipped[0].detail',
    'skipped[0].detail must be a string',
  ],
  [
    'a skip with an empty reason',
    proofWith({ skipped: [{ ...skip, reason: '' }] }),
    'skipped[0].reason',
    'skipped[0].reason must be a non-empty string',
  ],
  [
    'a skip with a zero version',
    proofWith({ skipped: [{ ...skip, version: 0 }] }),
    'skipped[0].version',
    'skipped[0].version must be a positive integer',
  ],
  [
    'an exception of an unknown kind',
    proofWith({ exceptions: [{ ...exception, kind: 'override' }] }),
    'exceptions[0].kind',
    'exceptions[0].kind must be one of inhibit, substitute, shortCircuit',
  ],
  [
    'an exception without affected',
    proofWith({ exceptions: [{ ruleId: 'x', version: 1, kind: 'inhibit', stratum: 0 }] }),
    'exceptions[0].affected',
    'exceptions[0].affected is required',
  ],
  ['a missing strata', proofWithout('strata'), 'strata', 'strata is required'],
  ['strata as an object', proofWith({ strata: {} }), 'strata', 'strata must be an array'],
  [
    'a stratum that is not a list',
    proofWith({ strata: ['value'] }),
    'strata[0]',
    'strata[0] must be an array',
  ],
  [
    'an empty output name in a stratum',
    proofWith({ strata: [['value', '']] }),
    'strata[0][1]',
    'strata[0][1] must be a non-empty string',
  ],
  [
    'a step without stratum',
    proofWith({
      applied: [{ ruleId: 'r1', version: 1, model: 'FLAT', output: 'value', contribution: 150 }],
    }),
    'applied[0].stratum',
    'applied[0].stratum is required',
  ],
  [
    'a skip without stratum',
    proofWith({ skipped: [{ ruleId: 'r2', version: 2, reason: 'CONDITION_FALSE' }] }),
    'skipped[0].stratum',
    'skipped[0].stratum is required',
  ],
  [
    'an exception without stratum',
    proofWith({ exceptions: [{ ruleId: 'x', version: 1, kind: 'inhibit', affected: [] }] }),
    'exceptions[0].stratum',
    'exceptions[0].stratum is required',
  ],
  [
    'a negative stratum',
    proofWith({ applied: [{ ...step, stratum: -1 }] }),
    'applied[0].stratum',
    'applied[0].stratum must be a non-negative integer',
  ],
  [
    'a fractional stratum',
    proofWith({ skipped: [{ ...skip, stratum: 0.5 }] }),
    'skipped[0].stratum',
    'skipped[0].stratum must be a non-negative integer',
  ],
  [
    'a stratum beyond the safe integers',
    proofWith({ exceptions: [{ ...exception, stratum: 1e300 }] }),
    'exceptions[0].stratum',
    'exceptions[0].stratum must be a non-negative integer',
  ],
  [
    'a stratum written as a string',
    proofWith({ applied: [{ ...step, stratum: '0' }] }),
    'applied[0].stratum',
    'applied[0].stratum must be a non-negative integer',
  ],
  [
    'a rounding scale above 20',
    proofWith({ outputs: { value: { ...output, rounding: { ...rounding, scale: 21 } } } }),
    'outputs.value.rounding.scale',
    'outputs.value.rounding.scale must be an integer from 0 to 20',
  ],
  [
    'a negative rounding scale',
    proofWith({ outputs: { value: { ...output, rounding: { ...rounding, scale: -1 } } } }),
    'outputs.value.rounding.scale',
    'outputs.value.rounding.scale must be an integer from 0 to 20',
  ],
  [
    'a fractional rounding scale',
    proofWith({ outputs: { value: { ...output, rounding: { ...rounding, scale: 1.5 } } } }),
    'outputs.value.rounding.scale',
    'outputs.value.rounding.scale must be an integer from 0 to 20',
  ],
  [
    'a rounding scale written as a string',
    proofWith({ outputs: { value: { ...output, rounding: { ...rounding, scale: '2' } } } }),
    'outputs.value.rounding.scale',
    'outputs.value.rounding.scale must be an integer from 0 to 20',
  ],
  [
    'an unknown rounding mode',
    proofWith({ outputs: { value: { ...output, rounding: { ...rounding, mode: 'bankers' } } } }),
    'outputs.value.rounding.mode',
    'outputs.value.rounding.mode must be one of halfUp, halfDown, halfEven, up, down, ceiling, floor',
  ],
  [
    'an unknown rounding at',
    proofWith({ outputs: { value: { ...output, rounding: { ...rounding, at: 'line' } } } }),
    'outputs.value.rounding.at',
    'outputs.value.rounding.at must be one of output, contribution',
  ],
  [
    'a rounding without mode',
    proofWith({ outputs: { value: { ...output, rounding: { scale: 2 } } } }),
    'outputs.value.rounding.mode',
    'outputs.value.rounding.mode is required',
  ],
  [
    'a rounding with an unknown key',
    proofWith({ outputs: { value: { ...output, rounding: { ...rounding, precision: 4 } } } }),
    'outputs.value.rounding.precision',
    'outputs.value.rounding has an unknown key "precision"',
  ],
  [
    'a rounding that is not an object',
    proofWith({ outputs: { value: { ...output, rounding: 2 } } }),
    'outputs.value.rounding',
    'outputs.value.rounding must be an object { scale, mode, at? }',
  ],
  [
    'a rounding on a boolean output',
    proofWith({
      outputs: {
        value: { type: 'boolean', combine: 'all', value: true, contributors: [], rounding },
      },
    }),
    'outputs.value.rounding',
    'outputs.value.rounding applies only to a number or decimal output',
  ],
  [
    'a malformed rounding on a list output, reported only as misplaced',
    proofWith({
      outputs: {
        value: { type: 'list', combine: 'union', value: [], contributors: [], rounding: 'x' },
      },
    }),
    'outputs.value.rounding',
    'outputs.value.rounding applies only to a number or decimal output',
  ],
  [
    'a signature of another algorithm',
    proofWith({ signature: { ...signature, alg: 'rsa' } }),
    'signature.alg',
    'signature.alg must be "ed25519"',
  ],
  [
    'a signature with an empty keyId',
    proofWith({ signature: { ...signature, keyId: '' } }),
    'signature.keyId',
    'signature.keyId must be a non-empty string',
  ],
  [
    'a padded signature value',
    proofWith({ signature: { ...signature, value: `${SIGNATURE_VALUE}==` } }),
    'signature.value',
    'signature.value must be an ed25519 signature in unpadded base64url (86 characters)',
  ],
  [
    'a signature value in standard base64',
    proofWith({ signature: { ...signature, value: `${'+'.repeat(85)}A` } }),
    'signature.value',
    'signature.value must be an ed25519 signature in unpadded base64url (86 characters)',
  ],
  [
    'a signature value with non-zero trailing bits',
    proofWith({ signature: { ...signature, value: `${'A'.repeat(85)}B` } }),
    'signature.value',
    'signature.value must be an ed25519 signature in unpadded base64url (86 characters)',
  ],
  [
    'a signature with an unknown key',
    proofWith({ signature: { ...signature, publicKey: hex('f') } }),
    'signature.publicKey',
    'signature has an unknown key "publicKey"',
  ],
  [
    'a null signature',
    proofWith({ signature: null }),
    'signature',
    'signature must be an object { alg, keyId, value }',
  ],
];

/** JSON Schema cannot compare items by a key: only validateProof refuses these. */
export const VALIDATOR_ONLY_PROOFS: [string, unknown, string, string][] = [
  [
    'a rule listed twice',
    proofWith({ rules: [...BASE_PROOF.rules, { id: 'r1', version: 1, checksum: hex('f') }] }),
    'rules[2]',
    'rules[2] repeats r1@1',
  ],
];
