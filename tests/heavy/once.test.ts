import { describe, expect, it } from 'vitest';
import {
  canonicalRulePayload,
  computeAssertionDigest,
  computeIdempotencyDigest,
  computeInputDigest,
  computeRuleChecksum,
  computeRuleFingerprint,
  createSigningKeyPair,
  inputLeaves,
  normalizeRuleDefinition,
  PROOF_FORMAT,
  sealProof,
  signProof,
  toExecutableRule,
  toStoredPayload,
  UNSALTED_SEED,
  validateProof,
  validateProofInput,
  validateRuleDefinition,
  verifyProof,
  verifyRuleChecksum,
} from '../../src/index.js';
import type {
  DecisionProof,
  JsonValue,
  ProofInput,
  RuleDefinitionInput,
  UnsignedProof,
} from '../../src/index.js';
import { lastValuesSpent, MAX_JSON_VALUES } from '../../src/values.js';
import { BASE_RULE, countValues, HUMAN_ASSERTION, proofInput, specError } from '../helpers.js';
import { unsaltedSalt } from '../proof-cases.js';

/** A rule with every part the readers walk: free-form values, lists, specs, exceptions. */
const RICH_RULE: RuleDefinitionInput = {
  id: 'vat',
  version: 3,
  model: 'PROGRESSIVE_BRACKET',
  params: {
    base: 'income',
    brackets: [
      { from: 0, rate: 0 },
      { from: 1000, rate: 0.1 },
    ],
  },
  condition: { dsl: 'jsonlogic', value: { '>': [{ var: 'income' }, 0] } },
  priority: 100,
  effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
  effectiveUntil: '2026-01-01T00:00:00.000Z',
  output: 'vat',
  dimensions: { country: 'TG', regime: { anyOf: ['normal', 'reel'] }, gone: null },
  tags: ['vat', 'fiscal'],
  exceptions: [
    { kind: 'substitute', targets: { tags: ['vat'] }, params: { rate: 0.1, scope: [1, 2] } },
  ],
  forEach: { path: '/factures', key: 'id' },
  checksum: 'stale',
  jurisdiction: 'NATIONAL',
  extra: { owner: { team: 'tax' }, flags: [1, 2] },
};

const INPUT: ProofInput = proofInput(
  {
    dates: { effective: '2026-01-01', facture: '2026-01-01T10:00:00.000Z' },
    tags: ['a', 'b'],
    dimensions: { pays: ['FR', 'US'], secteur: 'C' },
    context: { channel: 'web', nested: { list: [1, { a: null }] } },
    assertions: { '/revenue': HUMAN_ASSERTION },
  },
  { revenue: 1000, items: [{ q: 1 }, { q: 2 }] },
);

/**
 * An unsigned proof citing `rule`, whose output value and contribution are given: a `list`
 * output (`union`) for an array value, an `object` output (`highestPriority`) otherwise.
 */
function unsignedProof(rule: RuleDefinitionInput, value: JsonValue, contribution: JsonValue) {
  const declared = Array.isArray(value)
    ? ({ type: 'list', combine: 'union' } as const)
    : ({ type: 'object', combine: 'highestPriority' } as const);
  const proof: UnsignedProof = {
    format: PROOF_FORMAT,
    requestId: 'req-1',
    evaluatedAt: '2025-06-01T00:00:00.000Z',
    sealedAt: '2025-06-01T10:00:00.000Z',
    inputDigest: computeInputDigest(INPUT, UNSALTED_SEED),
    inputSalted: false,
    timeZone: 'UTC',
    ruleSets: [],
    versions: { engine: '1', plugins: {}, dsls: {}, models: { FLAT: '1' }, components: [] },
    strata: [['value']],
    rules: [
      {
        id: 'r1',
        version: 1,
        checksum: computeRuleChecksum(rule),
        ruleSet: 'local',
        salt: unsaltedSalt('rules', 0),
      },
    ],
    outputs: [
      {
        name: 'value',
        ...declared,
        status: 'determined',
        value,
        contributors: ['r1'],
        pending: [],
        ...(Array.isArray(value) ? {} : { selected: { ruleId: 'r1' } }),
        salt: unsaltedSalt('outputs', 0),
      },
    ],
    items: [],
    applied: [
      {
        ruleId: 'r1',
        version: 1,
        model: 'FLAT',
        output: 'value',
        contribution,
        status: 'determined',
        stratum: 0,
        salt: unsaltedSalt('applied', 0),
      },
    ],
    skipped: [],
    pending: [],
    exceptions: [],
    factsRead: [],
    missingFacts: [],
    readsUndeclared: [],
  };
  return proof;
}

/** The numbers 0 to `n` - 1: a union of them is themselves. */
const distinct = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** `distinct(n)` and repeats of 0 up to `length` items: their union is `distinct(n)`. */
const withRepeats = (n: number, length: number): number[] => [
  ...distinct(n),
  ...new Array<number>(length - n).fill(0),
];

/** `BASE_RULE` with `params.big` an array of `length` zeros. */
function bigRule(length: number): RuleDefinitionInput {
  return { ...BASE_RULE, params: { big: new Array<number>(length).fill(0) } };
}

/** The values of `bigRule(length)`: its own, and those of the array. */
function bigRuleValues(length: number): number {
  return countValues(bigRule(0)) + length;
}

const keys = createSigningKeyPair();

describe('a value is counted once: the spend counter', () => {
  it('rules: each function charges each value of the rule exactly once', () => {
    const expected = countValues(RICH_RULE);
    const calls: [string, () => unknown][] = [
      ['validateRuleDefinition', () => validateRuleDefinition(RICH_RULE)],
      ['normalizeRuleDefinition', () => normalizeRuleDefinition(RICH_RULE)],
      ['computeRuleChecksum', () => computeRuleChecksum(RICH_RULE)],
      ['computeRuleFingerprint', () => computeRuleFingerprint(RICH_RULE)],
      ['canonicalRulePayload', () => canonicalRulePayload(RICH_RULE)],
      ['toStoredPayload', () => toStoredPayload(RICH_RULE)],
      ['toExecutableRule', () => toExecutableRule(RICH_RULE)],
      ['verifyRuleChecksum', () => verifyRuleChecksum({ ...RICH_RULE, checksum: 'x' })],
    ];
    expect(validateRuleDefinition(RICH_RULE).issues).toEqual([]);
    for (const [name, call] of calls) {
      call();
      expect([name, lastValuesSpent()]).toEqual([name, expected]);
    }
  });

  it('proofs: read once each, the seal counted before it is added', () => {
    const rule = { ...RICH_RULE, id: 'r1', version: 1 };
    const unsigned = unsignedProof(rule, { a: [1, 2] }, { a: [1, 2] });
    sealProof(unsigned);
    // The digest sealing adds is counted with the content.
    expect(lastValuesSpent()).toBe(countValues(unsigned) + 1);
    const sealed = sealProof(unsigned);
    for (const call of [() => validateProof(sealed), () => verifyProof(sealed)]) {
      call();
      expect(lastValuesSpent()).toBe(countValues(sealed));
    }
    const rules = [rule];
    expect(verifyProof(sealed, { rules })).toEqual({ status: 'consistent', issues: ['unsigned'] });
    expect(lastValuesSpent()).toBe(countValues(sealed) + countValues(rules));
    // The signature signing adds, and its three members, are counted with the content.
    const signed = signProof(sealed, keys.privateKey, 'k1');
    expect(lastValuesSpent()).toBe(countValues(sealed) + 4);
    expect(countValues(signed)).toBe(countValues(sealed) + 4);
    verifyProof(signed, { trustedKeys: { k1: keys.publicKey } });
    expect(lastValuesSpent()).toBe(countValues(signed));
  });

  it('inputs: validated and hashed from one read, shared objects counted on every path', () => {
    let shared: JsonValue = { leaf: [1, 2] };
    for (let i = 0; i < 10; i++) shared = { l: shared, r: shared };
    const input = { ...INPUT, data: { ...INPUT.data, shared } };
    const expected = countValues(input);
    expect(expected).toBeGreaterThan(2 ** 10 * 3);
    expect(validateProofInput(input)).toEqual([]);
    expect(lastValuesSpent()).toBe(expected);
    computeInputDigest(input, UNSALTED_SEED);
    expect(lastValuesSpent()).toBe(expected);
    inputLeaves(input, UNSALTED_SEED);
    expect(lastValuesSpent()).toBe(expected);
    const request = { input, options: { requested: ['a'] } };
    computeIdempotencyDigest(request);
    expect(lastValuesSpent()).toBe(countValues(request));
    computeAssertionDigest(HUMAN_ASSERTION);
    expect(lastValuesSpent()).toBe(countValues(HUMAN_ASSERTION));
  });
});

describe(`the boundary of ${MAX_JSON_VALUES} values is the same for every function`, () => {
  it('rules: validate, normalize, checksum, fingerprint and payload agree', () => {
    const fits = bigRule(MAX_JSON_VALUES - bigRuleValues(0));
    const over = bigRule(MAX_JSON_VALUES - bigRuleValues(0) + 1);
    expect(countValues(fits.params)).toBe(MAX_JSON_VALUES - countValues(bigRule(0)) + 1);
    expect(validateRuleDefinition(fits).issues).toEqual([]);
    expect(lastValuesSpent()).toBe(MAX_JSON_VALUES);
    const tooLarge = 'params.big is too large: more than 10000000 values';
    expect(validateRuleDefinition(over).issues).toEqual([
      { path: 'params.big', message: tooLarge },
    ]);
    const calls: [string, (rule: RuleDefinitionInput) => unknown][] = [
      ['normalizeRuleDefinition', normalizeRuleDefinition],
      ['computeRuleChecksum', computeRuleChecksum],
      ['computeRuleFingerprint', computeRuleFingerprint],
      ['canonicalRulePayload', canonicalRulePayload],
    ];
    for (const [name, call] of calls) {
      expect([name, typeof call(fits)]).toEqual([
        name,
        name === 'normalizeRuleDefinition' ? 'object' : 'string',
      ]);
      expect([name, lastValuesSpent()]).toEqual([name, MAX_JSON_VALUES]);
      expect([name, specError(() => call(over)).message]).toEqual([name, tooLarge]);
    }
  }, 120_000);

  it('proofs: validateProof, sealProof and verifyProof agree at 10M and 10M + 1 values', () => {
    const skeleton = sealProof(unsignedProof(BASE_RULE, [], []));
    const room = MAX_JSON_VALUES - countValues(skeleton);
    const half = Math.floor(room / 2);
    const unsigned = unsignedProof(BASE_RULE, distinct(half), withRepeats(half, room - half));
    const sealed = sealProof(unsigned);
    expect(countValues(sealed)).toBe(MAX_JSON_VALUES);
    expect(validateProof(sealed).issues).toEqual([]);
    expect(sealProof(sealed).digest).toBe(sealed.digest);
    expect(verifyProof(sealed)).toEqual({ status: 'consistent', issues: ['unsigned'] });
    expect(lastValuesSpent()).toBe(MAX_JSON_VALUES);

    const value = sealed.outputs[0]?.value;
    if (!Array.isArray(value)) throw new Error('the output value is the array');
    value.push(1);
    const tooLarge = 'applied[0].contribution is too large: more than 10000000 values';
    expect(validateProof(sealed).issues).toEqual([
      { path: 'applied[0].contribution', message: tooLarge },
    ]);
    expect(specError(() => sealProof(sealed)).message).toBe(`Cannot seal the proof: ${tooLarge}`);
    expect(verifyProof(sealed)).toEqual({ status: 'invalid', issues: [tooLarge] });
    // An unsigned proof of exactly 10M values cannot be sealed: its digest would be one more.
    const full = unsignedProof(BASE_RULE, distinct(half), withRepeats(half, room - half + 1));
    expect(countValues(full)).toBe(MAX_JSON_VALUES);
    expect(validateProof({ ...full, digest: sealed.digest }).issues).toEqual([
      { path: 'applied[0].contribution', message: tooLarge },
    ]);
    expect(specError(() => sealProof(full)).message).toBe(`Cannot seal the proof: ${tooLarge}`);
  }, 120_000);

  it('whatever sealProof and signProof produce, verifyProof accepts: 9.9M values', () => {
    const third = 3_300_000;
    const rule = bigRule(third);
    const unsigned = unsignedProof(rule, distinct(third), distinct(third));
    const sealed = sealProof(unsigned);
    expect(countValues(sealed) + countValues([rule])).toBeGreaterThan(9_900_000);
    expect(verifyProof(sealed)).toEqual({ status: 'consistent', issues: ['unsigned'] });
    expect(verifyProof(sealed, { rules: [rule] })).toEqual({
      status: 'consistent',
      issues: ['unsigned'],
    });
    const signed: DecisionProof = signProof(sealed, keys.privateKey, 'k1');
    expect(verifyProof(signed, { trustedKeys: { k1: keys.publicKey }, rules: [rule] })).toEqual({
      status: 'authentic',
      issues: [],
    });
  }, 120_000);
});
