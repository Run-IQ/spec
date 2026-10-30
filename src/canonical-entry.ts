/**
 * `@run-iq/spec/canonical`: the browser-safe part of `@run-iq/spec`. Its module graph imports
 * no `node:` module, so it runs in a browser or any other JavaScript runtime.
 *
 * It does not hash: `computeRuleChecksum(x)` is the lowercase sha256 hex of
 * `canonicalRulePayload(x)`, which the caller hashes with any sha256 implementation.
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
export { canonicalRulePayload } from './rule/payload.js';
export { isEffectiveAt } from './rule/effective.js';
export type { ExecutableRule, ExecutableRuleBase } from './rule/executable.js';
export type { StoredRuleRecord } from './rule/stored.js';
export { validateRuleDefinition } from './rule/validate.js';
export type { RuleValidationIssue } from './rule/validate.js';
