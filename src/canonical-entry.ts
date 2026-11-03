/**
 * `@run-iq/spec/canonical`: the browser-safe part of `@run-iq/spec`. Its module graph imports
 * no `node:` module, so it runs in a browser or any other JavaScript runtime.
 *
 * It hashes with a portable sha256 (`sha256Hex`, from `@noble/hashes`):
 * `computeRuleChecksum(x)` is `sha256Hex(canonicalRulePayload(x))`. It also holds the whole
 * decision proof API; signatures use ed25519 from `@noble/curves`, so `verifyProof` runs in a
 * browser too.
 *
 * @packageDocumentation
 */
export { canonicalize, canonicalizeAt } from './canonical.js';
export type { JsonValue } from './canonical.js';
export { SpecError, VerifyOptionsError } from './errors.js';
export type { SpecErrorCode } from './errors.js';
export {
  comparePointers,
  contextToInputPointer,
  formatPointer,
  parsePointer,
} from './path/pointer.js';
export type { JsonPointer } from './path/pointer.js';
export { elementSegment, groupSegment, isSubject, subjectContains } from './path/subject.js';
export type { Subject } from './path/subject.js';
export { ENGINE_VARIABLES, isReservedName } from './reserved.js';
export { sha256Hex } from './hash.js';
export { RESERVED_RULE_FIELDS } from './rule/definition.js';
export type {
  RuleCondition,
  RuleDefinition,
  RuleDefinitionBase,
  RuleDefinitionInput,
  RuleDefinitionInputBase,
} from './rule/definition.js';
export { EXCEPTION_MODEL, matchesSelector } from './rule/exceptions.js';
export type { RuleException, RuleSelector } from './rule/exceptions.js';
export type { ForEach, OrderKey, OrderKeyType } from './rule/forEach.js';
export {
  isPackId,
  isRuleSetId,
  LOCAL_RULE_SET,
  packIdProblem,
  qualifyName,
} from './rule/ruleSet.js';
export { matchDimension, resolveMembership } from './referential/membership.js';
export type { DimensionMatch } from './referential/membership.js';
export { REFERENTIAL_FORMAT } from './referential/types.js';
export type { Membership, Period, Referential, ReferentialMember } from './referential/types.js';
export {
  computeReferentialDigest,
  normalizeReferential,
  validateReferential,
} from './referential/validate.js';
export type { ReferentialLimits } from './referential/validate.js';
export type { DimensionSpec, DimensionSpecInput } from './rule/dimensions.js';
export { normalizeRuleDefinition } from './rule/normalize.js';
export { canonicalRulePayload } from './rule/payload.js';
export { isEffectiveAt } from './rule/effective.js';
export { windowContains } from './rule/window.js';
export type { RuleWindow } from './rule/window.js';
export { findOverlappingVersions } from './rule/versions.js';
export type { VersionedRuleWindow, VersionOverlap, VersionOverlapReport } from './rule/versions.js';
export {
  isCivilDate,
  isInstant,
  isTimeZone,
  normalizeTimeZone,
  toReferenceDate,
} from './time/civil.js';
export type { CivilCalendar, CivilDate, Instant } from './time/civil.js';
export type { ExecutableRule, ExecutableRuleBase } from './rule/executable.js';
export type { StoredRuleRecord } from './rule/stored.js';
export { validateRuleDefinition, validateStoredRuleDefinition } from './rule/validate.js';
export type { RuleValidationIssue } from './rule/validate.js';
export {
  contributionMatchesDeclaration,
  DEFAULT_OUTPUT,
  DEFAULT_OUTPUT_DECLARATION,
  emptyOutput,
  normalizeOutputDeclaration,
  OUTPUTS_VARIABLE,
  sameDeclaration,
  validateOutputDeclaration,
  valueMatchesOutputType,
} from './decision/output.js';
export type { CombineStrategy, OutputDeclaration, OutputType } from './decision/output.js';
export type { OutputRounding, RoundingMode } from './decision/rounding.js';
export { joinStatus, OUTPUT_STATUSES } from './decision/status.js';
export type { OutputStatus } from './decision/status.js';
export { compareOutputValues } from './decision/compare.js';
export { isCanonicalDecimal, toCanonicalDecimal } from './decision/decimal.js';
export { PROOF_FORMAT, PROOF_SECTIONS } from './proof/types.js';
export { PROOF_FORMATS } from './proof/formats.js';
export { ERROR_CAUSES } from './proof/carriers.js';
export type { ErrorCause } from './proof/carriers.js';
export type {
  DecisionProof,
  ProofBounds,
  ProofComponent,
  ProofException,
  ProofFactRead,
  ProofHeader,
  ProofInput,
  ProofItem,
  ProofMissingFact,
  ProofOutput,
  ProofPending,
  ProofRuleRef,
  ProofRuleSet,
  ProofSection,
  ProofSelection,
  ProofSkip,
  ProofStatus,
  ProofStep,
  ProofUndeclaredRead,
  ProofVerification,
  Redacted,
  SettledStatus,
  Unsalted,
  UnsaltedProof,
  UnsignedProof,
} from './proof/types.js';
export { computeIdempotencyDigest, computeInputDigest, sealProof } from './proof/digest.js';
export { proofLeafHash, proofLeafHashes, verifyProofInclusion } from './proof/tree.js';
export type { ProofLeaf } from './proof/tree.js';
export { redactProof } from './proof/redact.js';
export { inclusionPath, merkleRoot, verifyInclusion } from './merkle.js';
export { deriveInputSeed, UNSALTED_SEED } from './input/seed.js';
export { INPUT_TREE_TAG, inputLeafHash, inputLeaves, verifyInputInclusion } from './input/tree.js';
export type { InputLeaf } from './input/tree.js';
export { DISCLOSURE_FORMAT } from './input/disclosure.js';
export { discloseFacts } from './input/disclose.js';
export { verifyFactDisclosure } from './input/verify-disclosure.js';
export type {
  AbsenceProof,
  DisclosedFact,
  DisclosedLeaf,
  FactDisclosure,
  FactDisclosureVerification,
  NeighbourLeaf,
} from './input/disclosure.js';
export type {
  AssertionMethod,
  AssertionStatus,
  FactAssertion,
  TemporalValue,
} from './input/types.js';
export {
  computeAssertionDigest,
  governingAssertion,
  isProvisionalAssertion,
} from './input/assertions.js';
export { validateProofInput } from './input/validate.js';
export { validateTemporalFact } from './input/temporal.js';
export { createSigningKeyPair, signProof } from './proof/sign.js';
export { verifyProof } from './proof/verify.js';
export { ATTESTATION_FORMAT } from './attestation/types.js';
export type { Attestation, AttestationSubject } from './attestation/types.js';
export { createAttestation } from './attestation/sign.js';
export { verifyAttestation } from './attestation/verify.js';
export { validateProof } from './proof/validate.js';
