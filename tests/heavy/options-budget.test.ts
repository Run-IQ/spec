/**
 * AA1 (round 5): the options of `verifyProof` have a budget of their own. Options that take
 * nearly the whole of it leave the proof its own: a correct proof is judged for what it holds,
 * never called too large because of what the caller passed. Options over their own bound throw.
 */
import { expect, it } from 'vitest';
import { verifyProof } from '../../src/index.js';
import type { RuleDefinitionInput } from '../../src/index.js';
import { MAX_VERIFY_OPTIONS_NODES } from '../../src/values.js';
import { optionError } from '../helpers.js';
import { ruleA, ruleB, signed, TRUSTED } from '../proof-cases.js';

const big = (numbers: number): RuleDefinitionInput => ({
  ...ruleA,
  id: 'big',
  version: 2,
  params: { big: new Array<number>(numbers).fill(0) },
});

it('options that take nearly their whole budget leave the proof its own', () => {
  const rule = big(MAX_VERIFY_OPTIONS_NODES - 400);
  const out = verifyProof(signed(), { trustedKeys: TRUSTED, rules: [ruleA, ruleB, rule] });
  expect(out.status).toBe('invalid');
  expect(out.issues).toEqual(['unexpected rule: big@2']);
}, 120_000);

it('two valid rules that exceed the total together throw, naming the bound', () => {
  const half = (id: string) => ({ ...big(6_000_000), id });
  const error = optionError(() =>
    verifyProof(signed(), { trustedKeys: TRUSTED, rules: [ruleA, ruleB, half('h1'), half('h2')] }),
  );
  expect(error.option).toBe('options');
  expect(error.message).toBe(
    'options are too large: more than 10000000 values (at options.rules[3])',
  );
}, 120_000);

it('options over their own bound throw, the option named', () => {
  const error = optionError(() =>
    verifyProof(signed(), {
      trustedKeys: TRUSTED,
      rules: [ruleA, ruleB, big(MAX_VERIFY_OPTIONS_NODES + 1)],
    }),
  );
  expect(error.option).toBe('options');
  expect(error.message).toBe(
    'options are too large: more than 10000000 values (at options.rules[2])',
  );
}, 120_000);
