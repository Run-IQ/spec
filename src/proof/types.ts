import type { JsonValue } from '../canonical.js';
import type { CombineStrategy, OutputType } from '../decision/output.js';
import type { RuleException } from '../rule/exceptions.js';

/** The format a decision proof declares in `format`. */
export const PROOF_FORMAT = 'run-iq.proof/1';

/**
 * What a decision's input digest covers: the facts and the evaluation metadata, exactly as
 * evaluated. The proof holds only its digest (`computeInputDigest`), never the input itself.
 */
export interface ProofInput {
  data: { [k: string]: JsonValue };
  meta: {
    tenantId: string;
    effectiveDate: string | null;
    tags: string[];
    dimensions: Record<string, string>;
    context: { [k: string]: JsonValue };
  };
}

/** A rule the evaluation received: its identity and its checksum (`computeRuleChecksum`). */
export interface ProofRuleRef {
  id: string;
  version: number;
  checksum: string;
  sourceRef?: string;
}

/** The final value of one output, and the rules that contributed to it. */
export interface ProofOutput {
  type: OutputType;
  combine: CombineStrategy;
  value: JsonValue;
  contributors: string[];
}

/** One rule that applied, and what it contributed to its output. */
export interface ProofStep {
  ruleId: string;
  version: number;
  model: string;
  output: string;
  contribution: JsonValue;
  sourceRef?: string;
}

/** One rule that did not apply, and why. */
export interface ProofSkip {
  ruleId: string;
  version: number;
  reason: string;
  detail?: string;
}

/** One exception that took effect, and the rules (or outputs, for `shortCircuit`) it affected. */
export interface ProofException {
  ruleId: string;
  version: number;
  kind: RuleException['kind'];
  affected: string[];
}

/**
 * The content of a decision proof, before sealing. The format is closed: no other key is
 * allowed. Every rule cited in `applied`, `skipped` and `exceptions` is listed in `rules`. Lists are hashed in the order given, so the producer sorts them (`rules` and
 * `applied` by id then version, `skipped` by id) for two evaluations of the same decision to
 * give the same digest.
 *
 * Dates are ISO strings: `YYYY-MM-DD`, or a date-time with `Z` or an offset.
 */
export interface UnsignedProof {
  format: typeof PROOF_FORMAT;
  requestId: string;
  /** The effective date of the evaluation, or `null` when it had none. */
  evaluatedAt: string | null;
  sealedAt: string;
  /** `computeInputDigest(input)`: lowercase sha256 hex. */
  inputDigest: string;
  rules: ProofRuleRef[];
  /** The published pack the rules come from, when they come from one. */
  ruleSet?: { kind: 'pack'; id: string; version: string; digest: string };
  versions: { engine: string; plugins: Record<string, string>; dsls: Record<string, string> };
  outputs: Record<string, ProofOutput>;
  applied: ProofStep[];
  skipped: ProofSkip[];
  exceptions: ProofException[];
}

/**
 * A sealed proof. `digest` is the lowercase sha256 hex of the canonical unsigned proof (every
 * key but `digest` and `signature`). `signature`, when present, is the ed25519 signature of
 * the 64 ASCII characters of `digest`, in base64url without padding.
 */
export interface DecisionProof extends UnsignedProof {
  digest: string;
  signature?: { alg: 'ed25519'; keyId: string; value: string };
}

/**
 * - `authentic`: consistent, and signed by a trusted key;
 * - `consistent`: the digest matches the content, but nothing proves who produced it
 *   (unsigned, or signed by a key that is not trusted);
 * - `invalid`: malformed, altered, or contradicted by the rules given.
 */
export type ProofStatus = 'authentic' | 'consistent' | 'invalid';

/** The result of `verifyProof`: its status, and every reason it is not `authentic`. */
export interface ProofVerification {
  status: ProofStatus;
  issues: string[];
}
