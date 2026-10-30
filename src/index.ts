/**
 * @run-iq/spec: the canonical form of a Run-IQ rule, its checksum and its fingerprint, the
 * stored and executable forms of a rule, and its validator (`validateRuleDefinition`, which
 * agrees with `schema/rule-definition.schema.json`).
 *
 * Inputs must be plain JSON data: plain objects, arrays, strings, finite numbers, booleans,
 * null, and `Date` objects (any realm). Values such as `Decimal` (decimal.js), Luxon
 * `DateTime`, Map or Set are refused with `SpecError` (`NON_SERIALIZABLE`): convert them to
 * JSON (for example a decimal string) before calling. Strings are not Unicode-normalized.
 *
 * @packageDocumentation
 */
export { canonicalize } from './canonical.js';
export type { JsonValue } from './canonical.js';
export { SpecError } from './errors.js';
export type { SpecErrorCode } from './errors.js';
export { RESERVED_RULE_FIELDS } from './rule/definition.js';
export type {
  RuleCondition,
  RuleDefinition,
  RuleDefinitionBase,
  RuleDefinitionInput,
  RuleDefinitionInputBase,
} from './rule/definition.js';
export { normalizeRuleDefinition } from './rule/normalize.js';
export { computeRuleChecksum, verifyRuleChecksum } from './rule/checksum.js';
export { computeRuleFingerprint } from './rule/fingerprint.js';
export { isEffectiveAt } from './rule/effective.js';
export type { ExecutableRule, ExecutableRuleBase } from './rule/executable.js';
export type { StoredRuleRecord } from './rule/stored.js';
export { fromStoredRecord, toExecutableRule, toStoredPayload } from './rule/convert.js';
export { validateRuleDefinition } from './rule/validate.js';
