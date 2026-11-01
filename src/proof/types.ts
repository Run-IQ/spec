import type { JsonValue } from '../canonical.js';
import type { CombineStrategy, OutputDeclaration, OutputType } from '../decision/output.js';
import type { OutputRounding } from '../decision/rounding.js';
import type { OutputStatus } from '../decision/status.js';
import type { AssertionMethod, AssertionStatus } from '../input/types.js';
import type { JsonPointer } from '../path/pointer.js';
import type { Subject } from '../path/subject.js';
import type { RuleException } from '../rule/exceptions.js';
import type { CivilDate, Instant } from '../time/civil.js';

/** The format a decision proof declares in `format`. */
export const PROOF_FORMAT = 'run-iq.proof/1';

export type { ProofInput } from '../input/types.js';

/**
 * The status of a rule's decision: a contribution, an exclusion, an exception (D-7). It is never
 * `undetermined`: a rule whose decision is not known is pending, not applied nor excluded.
 */
export type SettledStatus = Exclude<OutputStatus, 'undetermined'>;

/**
 * The ten sections of a proof, in their order: each entry of a section is one leaf of the proof
 * (D-16), salted and, from Task 9K1, redactable.
 */
export type ProofSection =
  | 'rules'
  | 'outputs'
  | 'items'
  | 'applied'
  | 'skipped'
  | 'pending'
  | 'exceptions'
  | 'factsRead'
  | 'missingFacts'
  | 'readsUndeclared';

/** The sections of a proof in their order (D-16), the order of their leaves. Frozen. */
export const PROOF_SECTIONS: readonly ProofSection[] = Object.freeze([
  'rules',
  'outputs',
  'items',
  'applied',
  'skipped',
  'pending',
  'exceptions',
  'factsRead',
  'missingFacts',
  'readsUndeclared',
]);

/**
 * Every rule a proof cites by `ruleId` is cited by its qualified id: `qualifyName(ruleSet, id)`
 * (D-37), `R1` for a `local` rule, `vat:R1` for rule `R1` of pack `vat`. Rule ids hold no `:`,
 * so a qualified id names one rule of one rule set.
 *
 * A rule the evaluation received: its identity in its rule set, its checksum
 * (`computeRuleChecksum`), and the salt of its leaf.
 */
export interface ProofRuleRef {
  id: string;
  version: number;
  checksum: string;
  /** The rule set it belongs to: `local`, or a pack listed in `ruleSets`. */
  ruleSet: string;
  /**
   * Its priority, as its definition gives it (a finite number): what decides a
   * `highestPriority` output, and whether its winner outranks the rules still pending for it
   * (the completeness table of Task 9M2). `verifyProof` given `rules` checks it is the
   * definition's.
   */
  priority: number;
  sourceRef?: string;
  /** 16 bytes in lowercase hex (D-14): every section entry carries one. */
  salt: string;
}

/**
 * A rule set or a referential the evaluation used, in precedence order (D-23): a pack (its
 * identity and digest, the packs whose outputs its rules may feed, its time zone), the local
 * rules, a referential (D-35).
 */
export type ProofRuleSet =
  | {
      kind: 'pack';
      id: string;
      version: string;
      digest: string;
      imports?: string[];
      timeZone?: string;
    }
  | { kind: 'local'; timeZone?: string }
  | { kind: 'referential'; id: string; version: string; digest: string };

/**
 * A component the decision depends on (D-25): a piece of software or a versioned dataset, never
 * an input value. `declaredBy` is `engine`, `plugin:<name>` or `model:<name>`.
 */
export interface ProofComponent {
  name: string;
  version: string;
  digest?: string;
  declaredBy: string;
}

/** What an undetermined output is already known to lie within. */
export interface ProofBounds {
  min?: JsonValue;
  max?: JsonValue;
}

/** The contribution a `max`, `min` or `highestPriority` output took its value from (D-27). */
export interface ProofSelection {
  ruleId: string;
  subject?: Subject;
}

/**
 * The final state of one output: its declaration in its normal form (`type`, `combine` and the
 * optional members of `OutputDeclaration`), its status, its value when it has one, the rules
 * whose contribution entered it (`contributors`) and those still pending (`pending`).
 * An output `per` element has no value, bounds nor selection: its elements are `items`.
 */
export interface ProofOutput {
  name: string;
  type: OutputType;
  combine: CombineStrategy;
  status: OutputStatus;
  value?: JsonValue;
  contributors: string[];
  pending: string[];
  bounds?: ProofBounds;
  selected?: ProofSelection;
  values?: string[];
  rounding?: OutputRounding;
  unit?: string;
  empty?: boolean;
  per?: string;
  dimension?: string;
  sign?: OutputDeclaration['sign'];
  salt: string;
}

/** One element of an output declared `per` a collection: its subject and its own state. */
export interface ProofItem {
  output: string;
  subject: Subject;
  status: OutputStatus;
  value?: JsonValue;
  contributors: string[];
  pending: string[];
  bounds?: ProofBounds;
  selected?: ProofSelection;
  salt: string;
}

/**
 * One rule (or rule instance, with its `subject`) that applied, in stratum `stratum`, and what
 * it contributed to its output. When the contribution was rounded (`rounding.at:
 * 'contribution'`), `unrounded` keeps its value before rounding. `matches` gives, per dimension
 * the rule constrains, the input values that matched and the referential groups they matched
 * through (they are input values: redacted with the step).
 */
export interface ProofStep {
  ruleId: string;
  version: number;
  subject?: Subject;
  model: string;
  output: string;
  contribution: JsonValue;
  status: SettledStatus;
  /** The index in `strata` of the stratum the rule was evaluated in. */
  stratum: number;
  unrounded?: JsonValue;
  sourceRef?: string;
  matches?: Record<string, { values: string[]; via: string[] }>;
  salt: string;
}

/**
 * One rule (or instance) that did not apply in stratum `stratum`, why, and the output it would
 * have fed. The exclusions `INACTIVE_DATE`, `DIMENSION_MISMATCH`, `TAG_MISMATCH` and
 * `NOT_REQUESTED` of two instances or more of one rule are one entry without subject, with
 * their number in `instances` (D-28).
 */
export interface ProofSkip {
  ruleId: string;
  version: number;
  subject?: Subject;
  instances?: number;
  output?: string;
  reason: string;
  detail?: string;
  status: SettledStatus;
  /** The index in `strata` of the stratum the rule was considered in. */
  stratum: number;
  salt: string;
}

/**
 * One rule (or instance) whose decision is not known (D-8): why, the pointers it misses, and
 * the output it would have fed (for a `shortCircuit` carrier, the output its short circuit
 * targets). A pending rule makes that output `undetermined` (D-7, the completeness table).
 */
export interface ProofPending {
  ruleId: string;
  version: number;
  subject?: Subject;
  output?: string;
  reason: string;
  detail: string;
  missing: JsonPointer[];
  stratum: number;
  salt: string;
}

/** One exception that took effect, the stratum it was evaluated in, and the rules it affected. */
export interface ProofException {
  ruleId: string;
  version: number;
  subject?: Subject;
  kind: RuleException['kind'];
  affected: Array<{ ruleId: string; subject?: Subject }>;
  status: SettledStatus;
  /** The index in `strata` of the stratum its carrier rule was evaluated in. */
  stratum: number;
  salt: string;
}

/**
 * A fact a rule read (a pointer of the evaluation context into the input: `/revenue`,
 * `/$dates/effective`), and the assertion that governs it, when one does: its method, its
 * status and its digest (`computeAssertionDigest`), the three together or none.
 */
export interface ProofFactRead {
  path: JsonPointer;
  method?: AssertionMethod;
  status?: AssertionStatus;
  assertionDigest?: string;
  salt: string;
}

/** A fact a rule needed and the input did not hold. */
export interface ProofMissingFact {
  path: JsonPointer;
  salt: string;
}

/** A rule whose reads are not known (D-39): its decision is at best `provisional`. */
export interface ProofUndeclaredRead {
  ruleId: string;
  version: number;
  salt: string;
}

/**
 * The content of a decision proof, before sealing. The format is closed: no other key is
 * allowed.
 *
 * The header (every field but the ten sections) holds nothing that depends on the input
 * (D-16); each entry of a section is salted. Each section is a list sorted in one order, so one
 * decision has one proof (D-16): `rules` by (rule set, `id`, `version`); `outputs` by `name`;
 * `items` by (`output`, `subject`); `applied`, `skipped` and `pending` by (rule set, `id`,
 * `version`, subject), an entry without subject first; `exceptions` in the order their
 * carriers were processed; `factsRead` and `missingFacts` by `path` (`comparePointers`);
 * `readsUndeclared` by (rule set, `id`, `version`).
 *
 * `strata` lists the outputs of each evaluation stratum, in evaluation order: every output
 * appears in exactly one stratum, and a stratum may be empty. Every entry of `applied`,
 * `skipped`, `pending` and `exceptions` carries the index of its stratum in `strata`.
 */
export interface UnsignedProof {
  format: typeof PROOF_FORMAT;
  requestId: string;
  /** The reference date of the evaluation, or `null` when it had none. */
  evaluatedAt: CivilDate | Instant | null;
  sealedAt: Instant;
  /** `computeInputDigest(input, seed)`: lowercase sha256 hex. */
  inputDigest: string;
  /** False when the seed was `UNSALTED_SEED` (D-14). */
  inputSalted: boolean;
  /** The default time zone of the evaluation (D-12), in its normal form. */
  timeZone: string;
  ruleSets: ProofRuleSet[];
  versions: {
    engine: string;
    plugins: Record<string, string>;
    dsls: Record<string, string>;
    models: Record<string, string>;
    components: ProofComponent[];
  };
  /** The output names of each stratum, in evaluation order. */
  strata: string[][];
  /** The outputs the caller asked for (D-24), sorted; absent: every output. */
  requested?: string[];
  /** The proof this one replaces, and why, as a code (`correction`). */
  supersedes?: { digest: string; reason: string };
  rules: ProofRuleRef[];
  outputs: ProofOutput[];
  items: ProofItem[];
  applied: ProofStep[];
  skipped: ProofSkip[];
  pending: ProofPending[];
  exceptions: ProofException[];
  factsRead: ProofFactRead[];
  missingFacts: ProofMissingFact[];
  readsUndeclared: ProofUndeclaredRead[];
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
