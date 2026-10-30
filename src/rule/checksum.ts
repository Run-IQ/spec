import { SpecError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import type { RuleDefinitionInput } from './definition.js';
import { canonicalRulePayload } from './payload.js';

/**
 * Integrity seal of a rule: lowercase sha256 hex of
 * `canonicalRulePayload(input)`, that is `canonicalize(normalizeRuleDefinition(input))`.
 * Covers every content field, identity and dates included; ignores `checksum`.
 */
export function computeRuleChecksum(input: RuleDefinitionInput): string {
  return sha256Hex(canonicalRulePayload(input));
}

/**
 * True when `rule.checksum` equals the checksum recomputed from the rule. The comparison is
 * exact: the stored value must be the 64-character LOWERCASE hex string that
 * `computeRuleChecksum` returns (an uppercase copy does not match).
 * Throws `SpecError` (`INVALID_RULE`) when `checksum` is missing or not a string, and
 * `SpecError` when the rule itself is invalid, rather than hiding either as `false`.
 */
export function verifyRuleChecksum(rule: RuleDefinitionInput & { checksum: string }): boolean {
  const expected: unknown = (rule as { checksum?: unknown }).checksum;
  if (typeof expected !== 'string') {
    throw new SpecError('INVALID_RULE', 'checksum must be a string to be verified');
  }
  return computeRuleChecksum(rule) === expected;
}
