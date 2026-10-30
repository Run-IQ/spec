import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import type { RuleDefinitionInput } from './definition.js';
import { normalizeRuleDefinition } from './normalize.js';

/**
 * Integrity seal of a rule: sha256 hex of `canonicalize(normalizeRuleDefinition(input))`.
 * Covers every content field, identity and dates included; ignores `checksum`.
 */
export function computeRuleChecksum(input: RuleDefinitionInput): string {
  return sha256Hex(canonicalize(normalizeRuleDefinition(input)));
}

/**
 * True when `rule.checksum` equals the checksum recomputed from the rule.
 * Throws `SpecError` when the rule itself is invalid, rather than hiding it as `false`.
 */
export function verifyRuleChecksum(rule: RuleDefinitionInput & { checksum: string }): boolean {
  return computeRuleChecksum(rule) === rule.checksum;
}
