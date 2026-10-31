/**
 * @run-iq/spec: the canonical form of a Run-IQ rule, its checksum and its fingerprint, the
 * stored and executable forms of a rule, and its validator (`validateRuleDefinition`, which
 * agrees with `schema/rule-definition.schema.json`); the rule exception format
 * (`RuleException`, `matchesSelector`), the output declarations (`OutputDeclaration`) and
 * exact decimals (`isCanonicalDecimal`, `toCanonicalDecimal`); the decision proof format
 * (`sealProof`, `signProof`, `verifyProof`, and `validateProof`, which agrees with
 * `schema/decision-proof.schema.json`; `PROOF_FORMATS`); JSON pointers (`parsePointer`,
 * `comparePointers`), subjects (`isSubject`, `subjectContains`) and the reserved `$` names
 * (`ENGINE_VARIABLES`, `isReservedName`); civil time (`CivilDate`, `Instant`,
 * `toReferenceDate`, `isTimeZone`, `CivilCalendar`), rule windows (`windowContains`) and
 * coexisting versions (`findOverlappingVersions`); structured dimensions (`DimensionSpec`,
 * `matchDimension`) and dated referentials (`Referential`, `validateReferential`, which agrees
 * with `schema/referential.schema.json`, `resolveMembership`, `computeReferentialDigest`);
 * collections (`ForEach`, `OrderKey`) and rule sets (`LOCAL_RULE_SET`, `qualifyName`,
 * `isRuleSetId`, `isPackId`, `packIdProblem`); the decision input (`ProofInput`,
 * `validateProofInput`, which agrees with `schema/proof-input.schema.json`), the provenance of
 * its facts (`FactAssertion`, `governingAssertion`, `isProvisionalAssertion`,
 * `computeAssertionDigest`) and temporal facts (`TemporalValue`, `validateTemporalFact`).
 *
 * Inputs must be plain JSON data: plain objects, arrays, strings, finite numbers, booleans,
 * null, and `Date` objects (any realm). Values such as `Decimal` (decimal.js), Luxon
 * `DateTime`, Map or Set are refused with `SpecError` (`NON_SERIALIZABLE`): convert them to
 * JSON (for example a decimal string) before calling. Strings are not Unicode-normalized, and a
 * string or key holding a lone UTF-16 surrogate is refused. `canonicalize` is JCS (RFC 8785).
 *
 * @packageDocumentation
 */
export { canonicalize, canonicalizeAt } from './canonical.js';
export type { JsonValue } from './canonical.js';
export { SpecError } from './errors.js';
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
export { computeRuleChecksum, verifyRuleChecksum } from './rule/checksum.js';
export { computeRuleFingerprint } from './rule/fingerprint.js';
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
export { fromStoredRecord, toExecutableRule, toStoredPayload } from './rule/convert.js';
export { validateRuleDefinition } from './rule/validate.js';
export type { RuleValidationIssue } from './rule/validate.js';
export {
  DEFAULT_OUTPUT,
  DEFAULT_OUTPUT_DECLARATION,
  OUTPUTS_VARIABLE,
  validateOutputDeclaration,
  valueMatchesOutputType,
} from './decision/output.js';
export type {
  CombineStrategy,
  OutputDeclaration,
  OutputRounding,
  OutputType,
  RoundingMode,
} from './decision/output.js';
export { isCanonicalDecimal, toCanonicalDecimal } from './decision/decimal.js';
export { PROOF_FORMAT } from './proof/types.js';
export { PROOF_FORMATS } from './proof/formats.js';
export type {
  DecisionProof,
  ProofException,
  ProofInput,
  ProofOutput,
  ProofRuleRef,
  ProofSkip,
  ProofStatus,
  ProofStep,
  ProofVerification,
  UnsignedProof,
} from './proof/types.js';
export { computeInputDigest, sealProof } from './proof/digest.js';
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
export { validateProof } from './proof/validate.js';
