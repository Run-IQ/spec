import { canonicalize } from '../canonical.js';
import type { RuleDefinitionInput } from './definition.js';
import { normalizeRuleDefinition } from './normalize.js';

/**
 * The exact string the checksum hashes: `canonicalize(normalizeRuleDefinition(input))`.
 * `computeRuleChecksum(input)` is its lowercase sha256 hex. Throws `SpecError` like
 * `normalizeRuleDefinition`.
 */
export function canonicalRulePayload(input: RuleDefinitionInput): string {
  return canonicalize(normalizeRuleDefinition(input));
}
