/**
 * The refused shape cases of the sections of a decision proof, from its outputs on: part of
 * `REFUSED_PROOFS` (tests/proof-shape-cases.ts), split for size. Each changes `BASE_PROOF` in
 * one place, with the one issue validateProof reports: [label, value, path, message].
 */
import { entryWith, proofWith, SIGNATURE_VALUE } from './proof-cases.js';

const signature = { alg: 'ed25519', keyId: 'k1', value: SIGNATURE_VALUE };

export const REFUSED_SECTION_PROOFS: [string, unknown, string, string][] = [
  [
    'an output named with $',
    entryWith('outputs', 0, { name: '$kids' }),
    'outputs[0].name',
    'outputs[0].name must not start with "$": output names starting with "$" are reserved',
  ],
  [
    'an output qualified by local',
    entryWith('outputs', 0, { name: 'local:kids' }),
    'outputs[0].name',
    'outputs[0].name name must not be qualified by "local": a local name is written bare',
  ],
  [
    'an output without status',
    entryWith('outputs', 0, { status: undefined }),
    'outputs[0].status',
    'outputs[0].status is required',
  ],
  [
    'an output of an unknown status',
    entryWith('outputs', 0, { status: 'final' }),
    'outputs[0].status',
    'outputs[0].status must be one of determined, provisional, conflict, undetermined',
  ],
  [
    'an output without pending',
    entryWith('outputs', 0, { pending: undefined }),
    'outputs[0].pending',
    'outputs[0].pending is required',
  ],
  [
    'a contributor qualified by local',
    entryWith('outputs', 2, { contributors: ['local:r1'] }),
    'outputs[2].contributors[0]',
    'outputs[2].contributors[0] name must not be qualified by "local": ' +
      'a local name is written bare',
  ],
  [
    'an output of an unknown type',
    entryWith('outputs', 2, { type: 'money' }),
    'outputs[2].type',
    'outputs[2].type must be one of ' +
      'number, boolean, string, enum, list, object, decimal, date, dateTime',
  ],
  [
    'an output whose strategy cannot combine its type',
    entryWith('outputs', 3, { combine: 'sum' }),
    'outputs[3].combine',
    'outputs[3].combine "sum" cannot combine an enum output: it applies to number, decimal',
  ],
  [
    'an enum output without values',
    entryWith('outputs', 3, { values: undefined }),
    'outputs[3].values',
    'outputs[3].values is required for an enum output: list its allowed strings',
  ],
  [
    'values on a number output',
    entryWith('outputs', 2, { values: ['a'] }),
    'outputs[2].values',
    'outputs[2].values applies only to an enum output',
  ],
  [
    'a unit on a boolean output',
    entryWith('outputs', 1, { unit: 'EUR' }),
    'outputs[1].unit',
    'outputs[1].unit applies only to a number or decimal output',
  ],
  [
    'empty false written out',
    entryWith('outputs', 1, { empty: false }),
    'outputs[1].empty',
    'outputs[1].empty must be absent: false is the default',
  ],
  [
    'a sign on an all output',
    entryWith('outputs', 1, { sign: 'nonNegative' }),
    'outputs[1].sign',
    'outputs[1].sign applies only to a sum output',
  ],
  [
    'per and dimension together',
    entryWith('outputs', 3, { per: '/enfants' }),
    'outputs[3]',
    'outputs[3]: per and dimension are exclusive',
  ],
  [
    'a rounding at output written out',
    entryWith('outputs', 2, { rounding: { scale: 2, mode: 'halfEven', at: 'output' } }),
    'outputs[2].rounding.at',
    'outputs[2].rounding.at must be absent: output is the default',
  ],
  [
    'a bounds that is not an object',
    entryWith('outputs', 0, { bounds: 1 }),
    'outputs[0].bounds',
    'outputs[0].bounds must be an object { min?, max? }',
  ],
  [
    'a selection without rule',
    entryWith('outputs', 3, { selected: { subject: '/a/@1' } }),
    'outputs[3].selected.ruleId',
    'outputs[3].selected.ruleId is required',
  ],
  [
    'a selection whose subject is not one',
    entryWith('outputs', 3, { selected: { ruleId: 'vat:R2', subject: 'a' } }),
    'outputs[3].selected.subject',
    'outputs[3].selected.subject must be a subject: a JSON pointer whose ! segments are ' +
      '!group=<value> or !segment=<from>..<until>',
  ],
  [
    'an item whose subject is not one',
    entryWith('items', 0, { subject: '/f/!other' }),
    'items[0].subject',
    'items[0].subject must be a subject: a JSON pointer whose ! segments are ' +
      '!group=<value> or !segment=<from>..<until>',
  ],
  [
    'an item without contributors',
    entryWith('items', 0, { contributors: undefined }),
    'items[0].contributors',
    'items[0].contributors is required',
  ],
  [
    'an item with a declaration member',
    entryWith('items', 0, { type: 'decimal' }),
    'items[0].type',
    'items[0] has an unknown key "type"',
  ],
  [
    'an undetermined step',
    entryWith('applied', 1, { status: 'undetermined' }),
    'applied[1].status',
    'applied[1].status: step status cannot be undetermined',
  ],
  [
    'an undetermined exclusion',
    entryWith('skipped', 1, { status: 'undetermined' }),
    'skipped[1].status',
    'skipped[1].status: exclusion status cannot be undetermined',
  ],
  [
    'an undetermined exception',
    entryWith('exceptions', 0, { status: 'undetermined' }),
    'exceptions[0].status',
    'exceptions[0].status: exception status cannot be undetermined',
  ],
  [
    'a step without status',
    entryWith('applied', 1, { status: undefined }),
    'applied[1].status',
    'applied[1].status is required',
  ],
  [
    'a step whose subject is not one',
    entryWith('applied', 0, { subject: '' }),
    'applied[0].subject',
    'applied[0].subject must be a subject: a JSON pointer whose ! segments are ' +
      '!group=<value> or !segment=<from>..<until>',
  ],
  [
    'a step whose ruleId is qualified twice',
    entryWith('applied', 0, { ruleId: 'a:b:c' }),
    'applied[0].ruleId',
    'applied[0].ruleId name must hold at most one ":": <rule set>:<name>',
  ],
  [
    'empty matches',
    entryWith('applied', 0, { matches: {} }),
    'applied[0].matches',
    'applied[0].matches must not be empty: absent matches nothing',
  ],
  [
    'matches on a reserved dimension name',
    entryWith('applied', 0, { matches: { $x: { values: ['FR'], via: [] } } }),
    'applied[0].matches.$x',
    'applied[0].matches.$x must not start with "$": dimension names starting with "$" are reserved',
  ],
  [
    'matches without values',
    entryWith('applied', 0, { matches: { pays: { values: [], via: [] } } }),
    'applied[0].matches.pays.values',
    'applied[0].matches.pays.values must not be empty: a match has a value',
  ],
  [
    'a matched value that is not a dimension value',
    entryWith('applied', 0, { matches: { pays: { values: [':FR'], via: [] } } }),
    'applied[0].matches.pays.values[0]',
    'applied[0].matches.pays.values[0] has an empty code system before ":"',
  ],
  [
    'matches without via',
    entryWith('applied', 0, { matches: { pays: { values: ['FR'] } } }),
    'applied[0].matches.pays.via',
    'applied[0].matches.pays.via is required',
  ],
  [
    'an empty detail',
    entryWith('skipped', 1, { detail: '' }),
    'skipped[1].detail',
    'skipped[1].detail must be a non-empty string',
  ],
  [
    'instances on one instance',
    entryWith('skipped', 0, { instances: 1 }),
    'skipped[0].instances',
    'skipped[0].instances must be an integer, 2 or more',
  ],
  [
    'instances with a subject',
    entryWith('skipped', 0, { subject: '/enfants/@b1' }),
    'skipped[0].instances',
    'skipped[0].instances applies only to an entry without subject',
  ],
  [
    'instances for another reason',
    entryWith('skipped', 0, { reason: 'CONDITION_FALSE' }),
    'skipped[0].instances',
    'skipped[0].instances applies only to INACTIVE_DATE, DIMENSION_MISMATCH, TAG_MISMATCH ' +
      'or NOT_REQUESTED',
  ],
  [
    'a pending rule without detail',
    entryWith('pending', 0, { detail: undefined }),
    'pending[0].detail',
    'pending[0].detail is required',
  ],
  [
    'a pending missing pointer with a - segment',
    entryWith('pending', 0, { missing: ['/enfants/-'] }),
    'pending[0].missing[0]',
    'pending[0].missing[0] must be a JSON pointer of the evaluation context: ' +
      'invalid JSON pointer "/enfants/-": \'-\' is not an index',
  ],
  [
    'affected as rule ids',
    entryWith('exceptions', 0, { affected: ['r2'] }),
    'exceptions[0].affected[0]',
    'exceptions[0].affected[0] must be an object { ruleId, subject? }',
  ],
  [
    'a fact read under half an assertion',
    entryWith('factsRead', 0, { assertionDigest: undefined }),
    'factsRead[0]',
    'factsRead[0] must have method, status and assertionDigest together, or none',
  ],
  [
    'a fact read of an unknown method',
    entryWith('factsRead', 0, { method: 'guess' }),
    'factsRead[0].method',
    'factsRead[0].method must be one of ' +
      'human, ai, document, presumed, declared, measured, estimated, derived, decision',
  ],
  [
    'a fact read that is an output',
    entryWith('factsRead', 1, { path: '/$outputs/value' }),
    'factsRead[1].path',
    'factsRead[1].path must be a pointer to an input fact: "/$outputs/value" is not in the input',
  ],
  [
    'a missing fact at the root',
    entryWith('missingFacts', 0, { path: '' }),
    'missingFacts[0].path',
    'missingFacts[0].path must be a pointer to an input fact: "" is not in the input',
  ],
  [
    'an undeclared read without version',
    entryWith('readsUndeclared', 0, { version: undefined }),
    'readsUndeclared[0].version',
    'readsUndeclared[0].version is required',
  ],
  [
    'a negative stratum',
    entryWith('applied', 1, { stratum: -1 }),
    'applied[1].stratum',
    'applied[1].stratum must be a non-negative integer',
  ],
  [
    'a stratum beyond the safe integers',
    entryWith('exceptions', 0, { stratum: 1e300 }),
    'exceptions[0].stratum',
    'exceptions[0].stratum must be a non-negative integer',
  ],
  [
    'a stratum that is not a list',
    proofWith({ strata: ['value'] }),
    'strata[0]',
    'strata[0] must be a list',
  ],
  [
    'a stratum output qualified by local',
    proofWith({ strata: [['local:value']] }),
    'strata[0][0]',
    'strata[0][0] name must not be qualified by "local": a local name is written bare',
  ],
  [
    'a signature of another algorithm',
    proofWith({ signature: { ...signature, alg: 'rsa' } }),
    'signature.alg',
    'signature.alg must be "ed25519"',
  ],
  [
    'a signature value with non-zero trailing bits',
    proofWith({ signature: { ...signature, value: `${'A'.repeat(85)}B` } }),
    'signature.value',
    'signature.value must be an ed25519 signature in unpadded base64url (86 characters)',
  ],
  [
    'a null signature',
    proofWith({ signature: null }),
    'signature',
    'signature must be an object { alg, keyId, value }',
  ],
];
