import type { JsonValue } from '../canonical.js';
import type { CombineStrategy, OutputDeclaration, OutputType } from '../decision/output.js';
import type { OutputRounding } from '../decision/rounding.js';
import type { OutputStatus } from '../decision/status.js';
import type { AssertionMethod, AssertionStatus } from '../input/types.js';
import type { JsonPointer } from '../path/pointer.js';
import type { Subject } from '../path/subject.js';
import type { RuleException } from '../rule/exceptions.js';
import type { CivilDate, Instant } from '../time/civil.js';
import { objectFreeze } from '../intrinsics.js';

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
export const PROOF_SECTIONS: readonly ProofSection[] = objectFreeze([
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
  /**
   * The rank of its instance among those of its rule, by `forEach.orderBy` (`$index`, D-20):
   * carried by each step with a subject that feeds a `highestPriority` output without `per`,
   * whose winner among the instances of a rule is the one of rank 0 (D-21), and by no other.
   */
  rank?: number;
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
  /** Free text; for `ERROR`, `<CAUSE>: <message>`, its cause one of `ERROR_CAUSES` (D-8). */
  detail: string;
  missing: JsonPointer[];
  /**
   * For a rule that carries exceptions, and only for one: whether this carrier fired its
   * exceptions (R18: its condition held, and it was not pending `PENDING_CARRIER`), though its
   * own computation failed. One that did not fire has its targets pending `PENDING_CARRIER`
   * (D-8), each naming it in `carrier`. Fixed by
   * the reason for some (`firedOf`): `true` for `PENDING_DOMINANT` and the causes
   * `INVALID_PARAMS`, `MODEL_ERROR`; `false` for `PENDING_CARRIER` and the causes of a failed
   * or never reached condition.
   */
  fired?: boolean;
  /**
   * For a rule pending `PENDING_CARRIER`, and only for one: the pending carrier that held it,
   * an instance pending in the proof with `fired: false`. Following carriers, the chain ends at
   * a carrier pending for another reason, never in a cycle (D-8).
   */
  carrier?: { ruleId: string; version: number; subject?: Subject };
  stratum: number;
  salt: string;
}

/**
 * One exception that took effect, the stratum it was evaluated in, and the rules it affected.
 * An exception whose carrier is excluded `RULE_CONFLICT` with status `conflict` is a carrier
 * discarded by an exception precedence conflict (R15): it produced nothing, its `affected` are
 * the rules it would have inhibited, one of them a carrier processed before it, and the
 * outputs they feed are `conflict` (D-7).
 */
export interface ProofException {
  ruleId: string;
  version: number;
  subject?: Subject;
  kind: RuleException['kind'];
  /**
   * The output a `shortCircuit` targets (qualified): its carrier's step on it is the value
   * imposed. Present for a `shortCircuit` only.
   */
  output?: string;
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
 * An entry of a section hidden by `redactProof` (D-16): the hash of its leaf, 64 lowercase hex
 * characters, alone. The leaf commits to the section, the place and the salted entry: the entry
 * cannot be told from its hash without its salt, which a secret seed keeps secret (D-14).
 */
export interface Redacted {
  redacted: string;
}

/**
 * The header of a decision proof: every field but the ten sections, `digest` and `signature`.
 * It is one leaf of the proof (D-16), never redacted, and holds nothing that depends on the
 * input: each of its fields is justified in D-16 (`evaluatedAt` is the reference date of the
 * decision, `strata` and `requested` output names from the rules and the options alone).
 */
export interface ProofHeader {
  format: typeof PROOF_FORMAT;
  requestId: string;
  /**
   * The reference date of the evaluation, or `null` when it had none: `meta.dates.effective`,
   * the date a rule without `effectiveOn` has its window compared with. `verifyProof` given
   * `rules` relies on it (an applied rule outside its window at `evaluatedAt` is `invalid`), so
   * an engine seals no other date here.
   */
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
  /**
   * The number of entries of each section, redacted ones counted, as sealing found them
   * (`sealProof`). The header commits to them (D-16): an entry cannot be moved from one section
   * to the next without changing the digest, even redacted.
   */
  counts: ProofCounts;
}

/** The number of entries of each section of a proof (`ProofHeader.counts`). */
export type ProofCounts = Record<ProofSection, number>;

/**
 * The content of a decision proof, before sealing. The format is closed: no other key is
 * allowed.
 *
 * The header (every field but the ten sections) holds nothing that depends on the input
 * (D-16); each entry of a section is salted (D-14), and may be replaced by its leaf hash
 * (`Redacted`, `redactProof`). Each section is a list sorted in one order, so one decision has
 * one proof (D-16): `rules` by (rule set, `id`, `version`); `outputs` by `name`; `items` by
 * (`output`, `subject`); `applied`, `skipped` and `pending` by (rule set, `id`, `version`,
 * subject), an entry without subject first; `exceptions` in the order their carriers were
 * processed (stratum, then rule-set precedence, priority descending, identity, subject; the
 * exceptions of one carrier instance in the order of its definition); `factsRead` and
 * `missingFacts` by `path` (`comparePointers`); `readsUndeclared` by (rule set, `id`,
 * `version`). `contributors` and `pending` of an output or item are in contribution order
 * (rule-set precedence, priority descending, identity).
 *
 * `strata` lists the outputs of each evaluation stratum, in evaluation order: every output
 * appears in exactly one stratum, and a stratum may be empty. Every entry of `applied`,
 * `skipped`, `pending` and `exceptions` carries the index of its stratum in `strata`.
 */
export interface UnsignedProof extends ProofHeader {
  rules: (ProofRuleRef | Redacted)[];
  outputs: (ProofOutput | Redacted)[];
  items: (ProofItem | Redacted)[];
  applied: (ProofStep | Redacted)[];
  skipped: (ProofSkip | Redacted)[];
  pending: (ProofPending | Redacted)[];
  exceptions: (ProofException | Redacted)[];
  factsRead: (ProofFactRead | Redacted)[];
  missingFacts: (ProofMissingFact | Redacted)[];
  readsUndeclared: (ProofUndeclaredRead | Redacted)[];
}

/** An entry of a section before sealing: without its `salt`, which `sealProof` derives. */
export type Unsalted<T extends { salt: string }> = Omit<T, 'salt'>;

/**
 * The content `sealProof` seals (D-14, D-16): an unsigned proof whose entries carry no `salt`
 * yet (sealing derives each from the seed and the entry's place) and none is redacted, without
 * `counts` (sealing adds them).
 */
export interface UnsaltedProof extends Omit<ProofHeader, 'counts'> {
  rules: Unsalted<ProofRuleRef>[];
  outputs: Unsalted<ProofOutput>[];
  items: Unsalted<ProofItem>[];
  applied: Unsalted<ProofStep>[];
  skipped: Unsalted<ProofSkip>[];
  pending: Unsalted<ProofPending>[];
  exceptions: Unsalted<ProofException>[];
  factsRead: Unsalted<ProofFactRead>[];
  missingFacts: Unsalted<ProofMissingFact>[];
  readsUndeclared: Unsalted<ProofUndeclaredRead>[];
}

/**
 * Internal: what the consistency checks read of a proof: its header and the entries of its
 * sections that are not redacted, each section in its order (`proofView`).
 */
export interface ProofView extends Omit<ProofHeader, 'counts'> {
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
 * A sealed proof. `digest` commits to its leaves (D-16), in lowercase hex:
 * `sha256(0x02 ‖ utf8(format) ‖ 0x00 ‖ uint64be(n) ‖ root)`, `root` being the RFC 6962 root of
 * its `n` leaves (`proofLeafHashes`): its header, then each entry of each section in the order
 * of `PROOF_SECTIONS`. Redacting entries (`redactProof`) keeps it. `signature`, when present,
 * is the ed25519 signature of the 64 ASCII characters of `digest`, in base64url without padding.
 */
export interface DecisionProof extends UnsignedProof {
  digest: string;
  signature?: { alg: 'ed25519'; keyId: string; value: string };
}

/**
 * - `authentic`: consistent, and signed by a trusted key;
 * - `consistent`: the digest matches the content, but nothing proves who produced it
 *   (unsigned, or signed by a key that is not trusted);
 * - `authentic-redacted`, `consistent-redacted`: the same, for a proof with a redacted entry.
 *   What a redacted entry hides is never checked (its leaf hash is all the proof shows, D-16),
 *   so such a proof proves its visible entries only, and the checks a redaction kept from
 *   being made are named (`ProofVerification.lifted`). Never the full verdict;
 * - `invalid`: malformed, altered, or contradicted by the rules given.
 */
export type ProofStatus =
  'authentic' | 'authentic-redacted' | 'consistent' | 'consistent-redacted' | 'invalid';

/**
 * A check of `verifyProof` that a redaction kept from being made: it found a problem that a
 * redacted entry of one of the sections `redacted` could explain.
 */
export interface LiftedCheck {
  /** The check, in words (`output value from its contributions`). */
  check: string;
  /** The sections whose redacted entries could explain a problem it found. */
  redacted: ProofSection[];
}

/**
 * The result of `verifyProof`: its status, every reason it is not `authentic` and what it could
 * not check (redacted entries, lifted checks); with a redacted entry, their number and the
 * checks lifted.
 */
export interface ProofVerification {
  status: ProofStatus;
  issues: string[];
  /** The number of redacted entries; absent when there is none. */
  redacted?: number;
  /**
   * The checks the redacted entries lifted: absent when no entry is redacted; `[]` when entries
   * are redacted but no check was lifted.
   */
  lifted?: LiftedCheck[];
}
