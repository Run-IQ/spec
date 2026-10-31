/**
 * @run-iq/spec: the canonical form of a Run-IQ rule, its checksum and its fingerprint, the
 * stored and executable forms of a rule, and its validator (`validateRuleDefinition`, which
 * agrees with `schema/rule-definition.schema.json`); the rule exception format
 * (`RuleException`, `matchesSelector`) and the output declarations (`OutputDeclaration`); the
 * decision proof format (`sealProof`, `signProof`, `verifyProof`, and `validateProof`, which
 * agrees with `schema/decision-proof.schema.json`).
 *
 * Inputs must be plain JSON data: plain objects, arrays, strings, finite numbers, booleans,
 * null, and `Date` objects (any realm). Values such as `Decimal` (decimal.js), Luxon
 * `DateTime`, Map or Set are refused with `SpecError` (`NON_SERIALIZABLE`): convert them to
 * JSON (for example a decimal string) before calling. Strings are not Unicode-normalized.
 *
 * @packageDocumentation
 */
export { canonicalize, canonicalizeAt } from './canonical.js';
export type { JsonValue } from './canonical.js';
export { SpecError } from './errors.js';
export type { SpecErrorCode } from './errors.js';
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
export { normalizeRuleDefinition } from './rule/normalize.js';
export { canonicalRulePayload } from './rule/payload.js';
export { computeRuleChecksum, verifyRuleChecksum } from './rule/checksum.js';
export { computeRuleFingerprint } from './rule/fingerprint.js';
export { isEffectiveAt } from './rule/effective.js';
export type { ExecutableRule, ExecutableRuleBase } from './rule/executable.js';
export type { StoredRuleRecord } from './rule/stored.js';
export { fromStoredRecord, toExecutableRule, toStoredPayload } from './rule/convert.js';
export { validateRuleDefinition } from './rule/validate.js';
export type { RuleValidationIssue } from './rule/validate.js';
export {
  DEFAULT_OUTPUT,
  DEFAULT_OUTPUT_DECLARATION,
  validateOutputDeclaration,
  valueMatchesOutputType,
} from './decision/output.js';
export type { CombineStrategy, OutputDeclaration, OutputType } from './decision/output.js';
export { PROOF_FORMAT } from './proof/types.js';
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
export { createSigningKeyPair, signProof } from './proof/sign.js';
export { verifyProof } from './proof/verify.js';
export { validateProof } from './proof/validate.js';
