import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  computeAssertionDigest,
  computeInputDigest,
  computeReferentialDigest,
  computeRuleChecksum,
  normalizeRuleDefinition,
  sealProof,
  UNSALTED_SEED,
  validateProof,
  validateProofInput,
  validateReferential,
  validateRuleDefinition,
  validateTemporalFact,
} from '../src/index.js';
import type {
  FactAssertion,
  ProofInput,
  Referential,
  RuleDefinitionInput,
  UnsignedProof,
} from '../src/index.js';
import { BASE_RULE, HUMAN_ASSERTION, proofInput, specError, ueReferential } from './helpers.js';
import { outputProof } from './proof-builders.js';

/**
 * Ruling (Round 13): one rule everywhere. A member of an object the format defines whose value
 * is `undefined` is absent (the TypeScript idiom of an optional field). An `undefined` inside a
 * free-form JSON value, or as an array item, is refused: `<path> is not JSON: undefined`. Every
 * digest refuses exactly what the matching validator refuses.
 */

const notJson = (path: string): string => `${path} is not JSON: undefined`;

/**
 * `value` as a JavaScript caller passes it: with `undefined` where the types do not allow it.
 * The only cast of this file; the functions under test check what they receive.
 */
function fromJavaScript<T>(value: unknown): T {
  return value as T;
}

/** Asserts that validate, normalize and the checksum refuse `rule` with `message` at `path`. */
function expectRuleRefused(rule: object, path: string, message: string): void {
  const input = fromJavaScript<RuleDefinitionInput>(rule);
  expect(validateRuleDefinition(input).issues).toEqual([{ path, message }]);
  expect(specError(() => normalizeRuleDefinition(input)).message).toBe(message);
  expect(specError(() => computeRuleChecksum(input)).message).toBe(message);
}

/** Asserts that `rule` is valid and has the checksum of `same`. */
function expectRuleAbsent(rule: object, same: object): void {
  expect(validateRuleDefinition(rule).issues).toEqual([]);
  expect(computeRuleChecksum(fromJavaScript<RuleDefinitionInput>(rule))).toBe(
    computeRuleChecksum(fromJavaScript<RuleDefinitionInput>(same)),
  );
}

describe('canonicalize: schema-agnostic', () => {
  it('drops an undefined member, refuses an undefined array item', () => {
    expect(canonicalize({ a: 1, b: undefined, c: { d: undefined } })).toBe('{"a":1,"c":{}}');
    expect(specError(() => canonicalize({ a: [{ b: [undefined] }] }))).toMatchObject({
      code: 'NON_SERIALIZABLE',
      path: 'a[0].b[0]',
      message: notJson('a[0].b[0]'),
    });
  });
});

describe('rules', () => {
  const shortCircuit = {
    ...BASE_RULE,
    model: '@run-iq/exception',
    exceptions: [{ kind: 'shortCircuit', output: 'x', value: { a: 1 } }],
  };

  it.each([
    ['params', { params: { a: undefined } }, 'params.a'],
    ['a params item', { params: { list: [1, undefined] } }, 'params.list[1]'],
    ['condition.value', { condition: { dsl: 'd', value: { a: undefined } } }, 'condition.value.a'],
    ['an extension', { extra: { deep: [{ a: undefined }] } }, 'extra.deep[0].a'],
    [
      'the params of a substitute',
      { exceptions: [{ kind: 'substitute', targets: { ids: ['r0'] }, params: { a: undefined } }] },
      'exceptions[0].params.a',
    ],
    [
      'an exceptions item',
      { exceptions: [{ kind: 'inhibit', targets: { ids: ['r0'] } }, undefined] },
      'exceptions[1]',
    ],
    [
      'a selector list item',
      { exceptions: [{ kind: 'inhibit', targets: { ids: [undefined] } }] },
      'exceptions[0].targets.ids[0]',
    ],
    ['a forEach list item', { forEach: { path: '/f', key: ['id', undefined] } }, 'forEach.key[1]'],
  ])('refuses undefined in %s', (_name, fields, path) => {
    expectRuleRefused({ ...BASE_RULE, ...fields }, path, notJson(path));
  });

  it('refuses undefined in the value of a shortCircuit', () => {
    const [exception] = shortCircuit.exceptions;
    const rule = { ...shortCircuit, exceptions: [{ ...exception, value: { a: undefined } }] };
    expectRuleRefused(rule, 'exceptions[0].value.a', notJson('exceptions[0].value.a'));
  });

  it('refuses an undefined tag, at its path', () => {
    const rule = { ...BASE_RULE, tags: ['a', undefined] };
    expectRuleRefused(rule, 'tags[1]', notJson('tags[1]'));
  });

  it('takes an undefined member of an object the format defines as absent', () => {
    expectRuleAbsent(
      { ...BASE_RULE, output: undefined, ruleSet: undefined, ghost: undefined },
      BASE_RULE,
    );
    const condition = { dsl: 'd', value: 1 };
    expectRuleAbsent(
      { ...BASE_RULE, condition: { ...condition, ghost: undefined } },
      { ...BASE_RULE, condition },
    );
    const dimensions = { pays: { anyOf: ['FR', 'TG'] } };
    expectRuleAbsent(
      {
        ...BASE_RULE,
        dimensions: {
          pays: { ...dimensions.pays, ref: undefined, ghost: undefined },
          gone: undefined,
        },
      },
      { ...BASE_RULE, dimensions },
    );
    const exception = { kind: 'inhibit', targets: { ids: ['r0'] } };
    expectRuleAbsent(
      {
        ...BASE_RULE,
        exceptions: [{ ...exception, ghost: undefined, targets: { ids: ['r0'], tags: undefined } }],
      },
      { ...BASE_RULE, exceptions: [exception] },
    );
    const [item] = shortCircuit.exceptions;
    expectRuleAbsent(
      { ...shortCircuit, exceptions: [{ ...item, reason: undefined }] },
      shortCircuit,
    );
    const forEach = { path: '/f', key: 'id' };
    expectRuleAbsent(
      { ...BASE_RULE, forEach: { ...forEach, orderBy: undefined, segments: undefined } },
      { ...BASE_RULE, forEach },
    );
  });
});

describe('proofs', () => {
  /** A proof of one `object` output, fed by `r0` with `{ a: 1 }`. */
  const unsigned = (): UnsignedProof =>
    outputProof({ type: 'object', combine: 'highestPriority', value: { a: 1 } }, [{ a: 1 }]);

  /** Asserts that validateProof and sealProof refuse `proof` with `message` at `path`. */
  function expectProofRefused(proof: unknown, path: string): void {
    const sealed = { ...(proof as object), digest: 'c'.repeat(64) };
    expect(validateProof(sealed).issues).toEqual([{ path, message: notJson(path) }]);
    expect(specError(() => sealProof(proof as UnsignedProof)).message).toBe(
      `Cannot seal the proof: ${notJson(path)}`,
    );
  }

  it('refuses undefined in an output value, a contribution and an unrounded value', () => {
    const p = unsigned();
    const output = p.outputs[0];
    const step = p.applied[0];
    if (output === undefined || step === undefined) throw new Error('fixture');
    expectProofRefused(
      { ...p, outputs: [{ ...output, value: { a: undefined } }] },
      'outputs[0].value.a',
    );
    expectProofRefused(
      { ...p, applied: [{ ...step, contribution: [undefined] }] },
      'applied[0].contribution[0]',
    );
    expectProofRefused(
      { ...p, applied: [{ ...step, unrounded: { a: [{ b: undefined }] } }] },
      'applied[0].unrounded.a[0].b',
    );
  });

  it('refuses undefined as a list item of the format', () => {
    const p = unsigned();
    expectProofRefused({ ...p, rules: [...p.rules, undefined] }, 'rules[1]');
    expectProofRefused({ ...p, strata: [['value', undefined]] }, 'strata[0][1]');
  });

  it('takes an undefined member of an object the format defines as absent', () => {
    const p = unsigned();
    const output = p.outputs[0];
    const step = p.applied[0];
    const rule = p.rules[0];
    if (output === undefined || step === undefined || rule === undefined) {
      throw new Error('fixture');
    }
    const withUndefined = {
      ...p,
      ghost: undefined,
      ruleSet: undefined,
      rules: [{ ...rule, sourceRef: undefined, note: undefined }],
      versions: { ...p.versions, plugins: { gone: undefined } },
      outputs: [{ ...output, rounding: undefined, bounds: undefined, unit: undefined }],
      applied: [{ ...step, unrounded: undefined, sourceRef: undefined, subject: undefined }],
      supersedes: undefined,
      requested: undefined,
    };
    expect(validateProof({ ...withUndefined, digest: 'c'.repeat(64) }).issues).toEqual([]);
    const sealed = sealProof(fromJavaScript<UnsignedProof>(withUndefined));
    expect(sealed.digest).toBe(sealProof(p).digest);
  });
});

describe('inputs', () => {
  /** Asserts that validateProofInput and computeInputDigest refuse `input` at `path`. */
  function expectInputRefused(input: unknown, path: string): void {
    expect(validateProofInput(input)).toEqual([{ path, message: notJson(path) }]);
    expect(specError(() => computeInputDigest(input as ProofInput, UNSALTED_SEED))).toMatchObject({
      code: 'INVALID_INPUT',
      path,
      message: `invalid input: ${notJson(path)}`,
    });
  }

  it('refuses undefined in data, in meta.context and as a list item', () => {
    const meta = (fields: object): ProofInput => proofInput(fromJavaScript(fields));
    const data = (fields: object): ProofInput => proofInput({}, fromJavaScript(fields));
    expectInputRefused(data({ a: { b: undefined } }), '/data/a/b');
    expectInputRefused(data({ a: [1, undefined] }), '/data/a/1');
    expectInputRefused(meta({ context: { c: undefined } }), '/meta/context/c');
    expectInputRefused(meta({ tags: ['a', undefined] }), '/meta/tags/1');
    expectInputRefused(meta({ dimensions: { d: ['a', undefined] } }), '/meta/dimensions/d/1');
  });

  it('takes an undefined member of an object the format defines as absent', () => {
    const plain = proofInput({ assertions: { '/revenue': HUMAN_ASSERTION } });
    const withUndefined = {
      ...plain,
      extra: undefined,
      meta: {
        ...plain.meta,
        note: undefined,
        dates: { ...plain.meta.dates, gone: undefined },
        dimensions: { gone: undefined },
        assertions: {
          '/revenue': { ...HUMAN_ASSERTION, basis: undefined, ghost: undefined },
          '/gone': undefined,
        },
      },
    };
    expect(validateProofInput(withUndefined)).toEqual([]);
    expect(computeInputDigest(fromJavaScript<ProofInput>(withUndefined), UNSALTED_SEED)).toBe(
      computeInputDigest(plain, UNSALTED_SEED),
    );
    const withBasis = fromJavaScript<FactAssertion>({ ...HUMAN_ASSERTION, basis: undefined });
    expect(computeAssertionDigest(withBasis)).toBe(computeAssertionDigest(HUMAN_ASSERTION));
    // A required member whose value is undefined is missing.
    expect(validateProofInput({ ...plain, meta: { ...plain.meta, tags: undefined } })).toEqual([
      { path: '/meta/tags', message: '/meta/tags is required' },
    ]);
  });

  it('temporal facts: refused inside a value or as a period, absent as a member', () => {
    const period = { from: '2026-01-01', until: null, value: 1 };
    expect(validateTemporalFact([{ ...period, value: [undefined] }], '/s')).toEqual([
      { path: '/s/0/value/0', message: notJson('/s/0/value/0') },
    ]);
    expect(validateTemporalFact([period, undefined], '/s')).toEqual([
      { path: '/s/1', message: notJson('/s/1') },
    ]);
    expect(validateTemporalFact([{ ...period, ghost: undefined }], '/s')).toEqual([]);
    expect(validateTemporalFact([{ ...period, value: undefined }], '/s')).toEqual([
      { path: '/s/0/value', message: '/s/0/value is required' },
    ]);
  });
});

describe('referentials', () => {
  it('refuses an undefined period or member, takes an undefined entry as absent', () => {
    const plain = ueReferential();
    const coded: Referential = { ...plain, groups: {}, codes: { FR: [{ from: '1958-01-01' }] } };
    const withCode = { ...coded, codes: { ...coded.codes, NO: undefined } };
    expect(validateReferential(withCode)).toEqual([]);
    expect(computeReferentialDigest(fromJavaScript<Referential>(withCode))).toBe(
      computeReferentialDigest(coded),
    );
    const withGroup = { ...plain, groups: { ...plain.groups, GONE: undefined }, ghost: undefined };
    expect(validateReferential(withGroup)).toEqual([]);
    expect(computeReferentialDigest(fromJavaScript<Referential>(withGroup))).toBe(
      computeReferentialDigest(plain),
    );

    const period = { ...coded, codes: { FR: [{ from: '1958-01-01' }, undefined] } };
    expect(validateReferential(period)).toEqual([
      { path: 'codes.FR[1]', message: notJson('codes.FR[1]') },
    ]);
    expect(
      specError(() => computeReferentialDigest(fromJavaScript<Referential>(period))).message,
    ).toBe(notJson('codes.FR[1]'));
    const members = plain.groups.EEE?.members ?? [];
    const member = {
      ...plain,
      groups: { ...plain.groups, EEE: { exhaustive: true, members: [...members, undefined] } },
    };
    expect(validateReferential(member)).toEqual([
      {
        path: 'groups.EEE.members[2]',
        message: notJson('groups.EEE.members[2]'),
      },
    ]);
  });
});
