/**
 * What spec hands back is made of ordinary objects (AF3, round 7): inside, spec reads objects
 * without a prototype so that a polluted `Object.prototype` reaches nothing, but a caller of
 * `sealProof` or `normalizeRuleDefinition` expects `result.hasOwnProperty(...)` to work. Every
 * object in a result has `Object.prototype` and every array `Array.prototype`.
 */
import { describe, expect, it } from 'vitest';
import {
  computeRuleFingerprint,
  deriveInputSeed,
  discloseFacts,
  normalizeOutputDeclaration,
  normalizeRuleDefinition,
  redactProof,
  sealProof,
  signProof,
  toStoredPayload,
  validateProofInput,
  validateRuleDefinition,
} from '../src/index.js';
import { RFC_SECRET, input, ruleA, sealed, unsalted, unsigned } from './proof-cases.js';

const SEED = deriveInputSeed(new Uint8Array(32).fill(7), 'request-1');
const PROOF_SEED = new Uint8Array(32).fill(9);

/** The paths in `value` whose object or array does not have its ordinary prototype. */
function oddPrototypes(value: unknown, path = '$', seen = new Set<object>()): string[] {
  if (typeof value !== 'object' || value === null || seen.has(value)) return [];
  seen.add(value);
  if (ArrayBuffer.isView(value)) return [];
  const proto = Object.getPrototypeOf(value) as object | null;
  const expected = Array.isArray(value) ? Array.prototype : Object.prototype;
  const out = proto === expected ? [] : [path];
  for (const key of Object.keys(value)) {
    out.push(...oddPrototypes((value as Record<string, unknown>)[key], `${path}.${key}`, seen));
  }
  return out;
}

const CALLS: [string, () => unknown][] = [
  ['sealProof', () => sealProof(unsalted(unsigned()))],
  ['signProof', () => signProof(sealed(), RFC_SECRET, 'executor-1')],
  [
    'redactProof',
    () =>
      redactProof(
        sealProof({ ...unsalted(unsigned()), inputSalted: true } as never, PROOF_SEED),
        (section, index) => section === 'rules' && index === 0,
      ),
  ],
  ['normalizeRuleDefinition', () => normalizeRuleDefinition(ruleA)],
  ['toStoredPayload', () => toStoredPayload(ruleA as never)],
  ['computeRuleFingerprint', () => computeRuleFingerprint(ruleA)],
  ['validateRuleDefinition', () => validateRuleDefinition({ ...ruleA, model: 1 } as never)],
  [
    'normalizeOutputDeclaration',
    () => normalizeOutputDeclaration({ type: 'number', combine: 'sum' }),
  ],
  ['validateProofInput', () => validateProofInput(input)],
  ['discloseFacts', () => discloseFacts(input, SEED, ['/data/income'], [])],
];

describe('results are ordinary objects', () => {
  it.each(CALLS)('%s', (_name, call) => {
    expect(oddPrototypes(call())).toEqual([]);
  });
});
