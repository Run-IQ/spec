import { describe, expect, it } from 'vitest';
import {
  normalizeRuleDefinition,
  validateOutputDeclaration,
  validateProof,
  validateProofInput,
  validateReferential,
  validateRuleDefinition,
  validateTemporalFact,
  verifyProof,
} from '../src/index.js';
import { BASE_PROOF } from './proof-cases.js';
import { BASE_RULE, expectBoundedIssues, proofInput, specError, ueReferential } from './helpers.js';

/** `{ k0: value, k1: value, … }` with `n` keys. */
const manyKeys = (n: number, value: unknown): Record<string, unknown> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, value]));

const LONG = 'x'.repeat(5000);

describe('one bound on every list of issues (ruling 9G round 4)', () => {
  it('validateRuleDefinition lists at most 100 problems, issues and errors alike', () => {
    const result = validateRuleDefinition({ ...BASE_RULE, dimensions: manyKeys(500, 5) });
    expectBoundedIssues(result.issues);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(result.issues.map((issue) => issue.message));
    expect(result.issues[0]).toEqual({
      path: 'dimensions.k0',
      message: result.errors[0],
    });
  });

  it('validateRuleDefinition bounds the problems of exceptions merged into its list', () => {
    const exceptions = Array.from({ length: 500 }, () => ({ kind: 'nope' }));
    expectBoundedIssues(validateRuleDefinition({ ...BASE_RULE, exceptions }).issues);
  });

  it('validateRuleDefinition cuts a path at 1024 and cites a key at 256 code units', () => {
    const key = `$${LONG}`;
    const { issues } = validateRuleDefinition({ ...BASE_RULE, dimensions: { [key]: 'FR' } });
    const text = `dimensions.${key}`;
    expect(issues).toEqual([
      {
        path: `${text.slice(0, 1024)}…`,
        message:
          `${text.slice(0, 256)}… must not start with "$": ` +
          'dimension names starting with "$" are reserved',
      },
    ]);
  });

  const DIMENSION_RESERVED =
    'must not start with "$": dimension names starting with "$" are reserved';
  const MB = 'k'.repeat(1_000_000);

  it.each([
    [
      'a 5000-character dimension name starting with $',
      { dimensions: { [`$${LONG}`]: 'FR' } },
      `dimensions.$${'x'.repeat(244)}… ${DIMENSION_RESERVED}`,
    ],
    [
      'a 1 MB dimension name starting with $',
      { dimensions: { [`$${MB}`]: 'FR' } },
      `dimensions.$${'k'.repeat(244)}… ${DIMENSION_RESERVED}`,
    ],
    [
      'a 5000-character dimension name with an empty value',
      { dimensions: { [LONG]: '' } },
      `dimensions.${'x'.repeat(245)}… must not be empty`,
    ],
    [
      'an over-long tag with a lone surrogate',
      { tags: [`${LONG}\uD800`] },
      'tags[0] contains a lone UTF-16 surrogate',
    ],
    [
      'an over-long unknown field with a lone surrogate',
      { [`${LONG}\uD800`]: 1 },
      `unknown rule field: ${'x'.repeat(256)}…`,
    ],
    ['an over-long id holding ":"', { id: `${LONG}:` }, 'id must not contain ":"'],
    [
      'an over-long rule set',
      { ruleSet: `A${LONG}` },
      'ruleSet must be a rule set id matching ^[a-z0-9][a-z0-9_-]*$',
    ],
    ['an over-long output name', { output: `a.${LONG}` }, 'output name must not contain "."'],
    [
      'an over-long output name starting with $',
      { output: `$${LONG}` },
      'output must not start with "$": output names starting with "$" are reserved',
    ],
    [
      'an over-long effectiveOn',
      { effectiveOn: `/$dates/$${LONG}` },
      'effectiveOn must not name a date starting with "$": date names starting with "$" are ' +
        'reserved',
    ],
    [
      'an over-long params key with a lone surrogate',
      { params: { [`${LONG}\uD800`]: 1 } },
      'Value at "params" cannot be serialized to canonical JSON: a key with a lone UTF-16 ' +
        'surrogate',
    ],
    [
      'an over-long params value with a lone surrogate',
      { params: { a: `${LONG}\uD800` } },
      'Value at "params.a" cannot be serialized to canonical JSON: ' +
        'a string with a lone UTF-16 surrogate',
    ],
    [
      'an over-long forEach dimension name',
      { forEach: { path: '/xs', key: 'id', dimensions: { [`$${LONG}`]: '/p' } } },
      `forEach.dimensions.$${'x'.repeat(236)}… ${DIMENSION_RESERVED}`,
    ],
    [
      'an over-long selector dimension name',
      {
        model: '@run-iq/exception',
        params: {},
        exceptions: [{ kind: 'inhibit', targets: { dimensions: { [`$${LONG}`]: 'FR' } } }],
      },
      `exceptions[0].targets.dimensions.$${'x'.repeat(222)}… ${DIMENSION_RESERVED}`,
    ],
    [
      'an over-long dimension spec value',
      { dimensions: { pays: { anyOf: [`${LONG}\uD800`] } } },
      'dimensions.pays.anyOf[0] contains a lone UTF-16 surrogate',
    ],
  ])("keeps the reason, and normalize throws the validator's message: %s", (_, patch, message) => {
    const rule = { ...BASE_RULE, ...patch };
    const [first] = validateRuleDefinition(rule).errors;
    expect(first).toBe(message);
    expect(message.length).toBeLessThanOrEqual(1025);
    expect(specError(() => normalizeRuleDefinition(rule)).message).toBe(first);
  });

  it('normalizeRuleDefinition still throws the first problem of a long list', () => {
    const exceptions = Array.from({ length: 500 }, () => ({ kind: 'nope' }));
    const first = validateRuleDefinition({ ...BASE_RULE, exceptions }).errors[0];
    expect(specError(() => normalizeRuleDefinition({ ...BASE_RULE, exceptions }))).toMatchObject({
      code: 'INVALID_RULE',
      message: first,
    });
  });

  it('validateOutputDeclaration lists at most 100 problems', () => {
    expectBoundedIssues(
      validateOutputDeclaration({ type: 'number', combine: 'sum', ...manyKeys(500, 1) }),
    );
  });

  it('validateReferential lists at most 100 problems', () => {
    const referential = ueReferential();
    const members = Array.from({ length: 500 }, () => ({ value: 1 }));
    const groups = { ...referential.groups, BAD: { exhaustive: true, members } };
    expectBoundedIssues(validateReferential({ ...referential, groups }));
  });

  it('validateProof and verifyProof list at most 100 problems', () => {
    const proof = manyKeys(500, 1);
    const result = validateProof(proof);
    expectBoundedIssues(result.issues);
    expect(result.errors).toEqual(result.issues.map((issue) => issue.message));
    const verdict = verifyProof(proof);
    expect(verdict.status).toBe('invalid');
    expect(verdict.issues).toEqual(result.errors);
  });

  it('verifyProof bounds its findings too (one per rule given)', () => {
    const rules = Array.from({ length: 500 }, () => 1);
    const verdict = verifyProof(BASE_PROOF, { rules: rules as never });
    expect(verdict.status).toBe('invalid');
    expect(verdict.issues).toHaveLength(101);
    expect(verdict.issues[100]).toBe('further problems not listed (limit 100)');
  });

  it('validateProofInput and validateTemporalFact list at most 100 problems', () => {
    expectBoundedIssues(validateProofInput(proofInput({ dates: manyKeys(500, 'x') as never })));
    const periods = Array.from({ length: 500 }, () => ({ from: 'x', until: null, value: 1 }));
    expectBoundedIssues(validateTemporalFact(periods, '/salaire'));
  });
});
