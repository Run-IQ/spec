import { isOwnError, newSpecError, unreadableMessage } from '../errors.js';
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
 * `SpecError` when the rule itself is invalid, rather than hiding either as `false`; a rule
 * that is not an object, or whose `checksum` cannot be read (a getter or a Proxy trap that
 * throws), is `INVALID_RULE` too.
 */
export function verifyRuleChecksum(rule: RuleDefinitionInput & { checksum: string }): boolean {
  const expected = readChecksum(rule);
  if (typeof expected !== 'string') {
    throw newSpecError('INVALID_RULE', 'checksum must be a string to be verified');
  }
  return computeRuleChecksum(rule) === expected;
}

/** `rule.checksum`, read once; never a raw error. */
function readChecksum(rule: unknown): unknown {
  if (typeof rule !== 'object' || rule === null) {
    throw newSpecError('INVALID_RULE', 'a rule definition must be a plain object');
  }
  try {
    return (rule as { checksum?: unknown }).checksum;
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw newSpecError('INVALID_RULE', unreadableMessage('rule', error));
  }
}
