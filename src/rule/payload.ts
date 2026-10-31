import { canonicalize } from '../canonical.js';
import { ownCopy, withValueBudget } from '../values.js';
import type { RuleDefinitionInput } from './definition.js';
import { normalizeRuleDefinition } from './normalize.js';

/**
 * The exact string the checksum hashes: `canonicalize(normalizeRuleDefinition(input))`.
 * `computeRuleChecksum(input)` is its lowercase sha256 hex. Throws `SpecError` like
 * `normalizeRuleDefinition`. Each value of `input` is counted once, as `normalizeRuleDefinition`
 * counts it: writing the normalized copy spends nothing more, so both accept the same rules.
 */
export function canonicalRulePayload(input: RuleDefinitionInput): string {
  return withValueBudget(() => {
    const definition = normalizeRuleDefinition(input);
    return ownCopy(() => canonicalize(definition));
  });
}
