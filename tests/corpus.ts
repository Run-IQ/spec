/**
 * The corpus shared by the tests that change the process around spec (patched built-ins, polluted
 * prototypes): calls whose verdicts must not move. `run()` gives one string per call.
 */
import {
  canonicalize,
  computeRuleChecksum,
  createAttestation,
  findOverlappingVersions,
  isEffectiveAt,
  normalizeOutputDeclaration,
  normalizeRuleDefinition,
  sealProof,
  signProof,
  toReferenceDate,
  validateProofInput,
  validateRuleDefinition,
  valueMatchesOutputType,
  verifyAttestation,
  verifyProof,
  windowContains,
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

/**
 * The calls that reach the signature and hash dependencies (`@noble/*`), which read the live
 * built-ins: a process that patches them is the attacker of phase 3's sandbox (README, "Threat
 * model"), and no test of spec's own code can rest on them.
 */
const NOBLE = new Set([
  'verifyProof authentic',
  'verifyProof untrusted key',
  'verifyProof Paris, rules',
  'verifyAttestation authentic',
  'verifyAttestation untrusted',
  'verifyAttestation other proof',
  'createAttestation at',
]);

const unsignedProof = unsalted(unsigned());
const parisUnsigned = sealProof(unsalted(withParis()));

function withParis() {
  const content = withRuntimeTzdata(unsigned());
  content.evaluatedAt = '2024-12-31T22:30:00.000Z';
  content.rules = content.rules.map((r) =>
    r.id === 'r1' ? { ...r, checksum: computeRuleChecksum(paris) } : r,
  );
  return content;
}

const UTC_CALENDAR = {
  toCivilDate: (at: string) => at.slice(0, 10),
  startOfDay: (day: string) => `${day}T00:00:00.000Z`,
} as never;

/** The corpus of spec's own code: what does not reach a dependency, and more of the API. */
export const PURE_CORPUS: [string, Call][] = [
  ...CORPUS.filter((entry) => !NOBLE.has(entry[0])),
  [
    'verifyProof unsigned, rules',
    () => verifyProof(sealProof(unsignedProof), { rules: [ruleA, ruleB] }),
  ],
  ['verifyProof Paris unsigned', () => verifyProof(parisUnsigned, { rules: [paris, ruleB] })],
  [
    'verifyProof unsigned, calendar option',
    () => verifyProof(sealProof(unsignedProof), { maxProofTimeZones: 1 }),
  ],
  ['validateRuleDefinition', () => validateRuleDefinition({ ...ruleA, model: 1 } as never)],
  [
    'normalizeOutputDeclaration',
    () => normalizeOutputDeclaration({ type: 'enum', combine: 'max', values: ['a', 'b'] }),
  ],
  [
    'valueMatchesOutputType',
    () => valueMatchesOutputType('a', { type: 'enum', combine: 'max', values: ['a'] }),
  ],
  [
    'windowContains',
    () =>
      windowContains(
        { effectiveFrom: '2025-01-01', effectiveUntil: '2026-01-01' },
        '2025-06-01',
        'UTC',
        undefined as never,
      ),
  ],
  [
    'findOverlappingVersions',
    () =>
      findOverlappingVersions(
        [
          { id: 'a', version: 1, effectiveFrom: '2025-01-01', effectiveUntil: '2026-01-01' },
          { id: 'a', version: 2, effectiveFrom: '2025-06-01' },
        ] as never,
        'UTC',
        UTC_CALENDAR,
      ),
  ],
];

const CALLS: Call[] = CORPUS.map((entry) => entry[1]);
const PURE_CALLS: Call[] = PURE_CORPUS.map((entry) => entry[1]);
const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Runs the corpus: each result is a string (the JSON of the value, or the error name, code,
 * option and message). The harness reads only own properties and writes by definition, so that
 * a polluted prototype can change spec's results and never its own.
 */
export function run(calls: Call[] = CALLS): string[] {
  clearIntlCaches();
  const results: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    let text: string;
    try {
      text = stringify((calls[i] as Call)());
    } catch (error) {
      const own = (key: string): unknown =>
        hasOwn.call(error, key) ? (error as Record<string, unknown>)[key] : undefined;
      text = `threw ${String(own('name') ?? (error as Error).name)} ${String(own('code'))} ${String(own('option'))} ${String(own('message'))}`;
    }
    defineValue(results, i, text, true);
  }
  return results;
}

/** `run` over `PURE_CORPUS`. */
export const runPure = (): string[] => run(PURE_CALLS);
