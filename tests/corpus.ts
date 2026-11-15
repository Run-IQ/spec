/**
 * The corpus shared by the tests that change the process around spec (patched built-ins, polluted
 * prototypes): calls whose verdicts must not move. `run()` gives one string per call.
 */
import {
  canonicalize,
  computeRuleChecksum,
  createAttestation,
  isEffectiveAt,
  normalizeRuleDefinition,
  sealProof,
  signProof,
  toReferenceDate,
  validateProofInput,
  verifyAttestation,
  verifyProof,
} from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';
import { defineValue } from '../src/intrinsics.js';
import { clearIntlCaches } from '../src/proof/intl-calendar.js';
import { withRuntimeTzdata } from './notices.js';
import { RFC_PUBLIC, RFC_SECRET, ruleA, ruleB, signed, unsalted, unsigned } from './proof-cases.js';

const stringify = JSON.stringify;
export const TRUSTED = { 'executor-1': RFC_PUBLIC };

// The Paris proof of the audit: honest verdict `invalid` (the rule is applied outside its window),
// decided by `Intl` under the release the proof records.
export const paris = { ...ruleA, timeZone: 'Europe/Paris', effectiveFrom: '2025-01-01' };
function parisProof() {
  const content = withRuntimeTzdata(unsigned());
  content.evaluatedAt = '2024-12-31T22:30:00.000Z';
  content.rules = content.rules.map((r) =>
    r.id === 'r1' ? { ...r, checksum: computeRuleChecksum(paris) } : r,
  );
  return signProof(sealProof(unsalted(content)), RFC_SECRET, 'executor-1');
}

export const digest = 'a'.repeat(64);
export const attestation = createAttestation(digest, RFC_SECRET, 'reviewer');
export const signedProof = signed();
export const parisSigned = parisProof();
export const untrustedProof = signProof(sealProof(unsalted(unsigned())), RFC_SECRET, 'evil');
const rule = { ...ruleA, params: { rates: [1, 2, { x: 'y' }] } };
const forgedGetter = new Proxy({}, { ownKeys: () => [], getPrototypeOf: () => null });
void forgedGetter;

export type Call = () => unknown;
export const CORPUS: [string, Call][] = [
  [
    'verifyProof authentic',
    () => verifyProof(signedProof, { trustedKeys: TRUSTED, rules: [ruleA, ruleB] }),
  ],
  ['verifyProof untrusted key', () => verifyProof(untrustedProof, { trustedKeys: TRUSTED })],
  [
    'verifyProof Paris, rules',
    () => verifyProof(parisSigned, { trustedKeys: TRUSTED, rules: [paris, ruleB] }),
  ],
  ['verifyProof malformed', () => verifyProof({ format: 'run-iq.proof/1' })],
  ['verifyProof options throw', () => verifyProof(signedProof, { calender: 1 } as never)],
  ['verifyProof key malformed', () => verifyProof(signedProof, { trustedKeys: { k: 'zz' } })],
  [
    'verifyAttestation authentic',
    () => verifyAttestation(attestation, digest, { reviewer: RFC_PUBLIC }),
  ],
  ['verifyAttestation untrusted', () => verifyAttestation(attestation, digest, {})],
  [
    'verifyAttestation other proof',
    () => verifyAttestation(attestation, 'b'.repeat(64), { reviewer: RFC_PUBLIC }),
  ],
  ['canonicalize', () => canonicalize({ a: [1, 2, { b: new Date(5) }], c: 'x' })],
  [
    'canonicalize Date under plain prototype',
    () => canonicalize({ a: Object.setPrototypeOf(new Date(5), Object.prototype) }),
  ],
  ['checksum', () => computeRuleChecksum(rule)],
  [
    'normalize',
    () => normalizeRuleDefinition({ ...ruleA, effectiveFrom: new Date(0) } as RuleDefinitionInput),
  ],
  ['toReferenceDate string', () => toReferenceDate('2025-01-01T00:00:00+01:00')],
  ['toReferenceDate Date', () => toReferenceDate(new Date(86_400_000))],
  [
    'isEffectiveAt',
    () => isEffectiveAt({ effectiveFrom: '2025-01-01' }, new Date(Date.UTC(2025, 5, 1))),
  ],
  [
    'validateProofInput',
    () =>
      validateProofInput({
        data: { a: [1, { b: 2 }] },
        meta: { tenantId: 't', dates: {}, tags: [], dimensions: {}, context: {}, assertions: {} },
      } as never),
  ],
  [
    'createAttestation at',
    () => createAttestation(digest, RFC_SECRET, 'reviewer', { at: '2026-01-01T00:00:00.000Z' }),
  ],
];

const CALLS: Call[] = CORPUS.map((entry) => entry[1]);
const NAMES: string[] = CORPUS.map((entry) => entry[0]);
export const corpusNames = (): string[] => NAMES;
const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Runs the corpus: each result is a string (the JSON of the value, or the error name, code,
 * option and message). The harness reads only own properties and writes by definition, so that
 * a polluted prototype can change spec's results and never its own.
 */
export function run(): string[] {
  clearIntlCaches();
  const results: string[] = [];
  for (let i = 0; i < CALLS.length; i++) {
    let text: string;
    try {
      text = stringify((CALLS[i] as Call)());
    } catch (error) {
      const own = (key: string): unknown =>
        hasOwn.call(error, key) ? (error as Record<string, unknown>)[key] : undefined;
      text = `threw ${String(own('name') ?? (error as Error).name)} ${String(own('code'))} ${String(own('option'))} ${String(own('message'))}`;
    }
    defineValue(results, i, text, true);
  }
  return results;
}
