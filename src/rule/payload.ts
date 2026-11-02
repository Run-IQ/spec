import { canonicalize } from '../canonical.js';
import { ownCopy, withValueBudget } from '../values.js';
import type { RuleDefinitionInput } from './definition.js';
import { normalizeStoredRuleDefinition } from './normalize.js';

/**
 * The exact string the checksum hashes: `canonicalize` of the normalized definition (`normalizeRuleDefinition`, but a normalized definition is read back as it is: `effectiveUntil: null` is accepted).
 * `computeRuleChecksum(input)` is its lowercase sha256 hex. Throws `SpecError` like
 * `normalizeRuleDefinition`. Each value of `input` is counted once, as `normalizeRuleDefinition`
 * counts it: writing the normalized copy spends nothing more, so both accept the same rules.
 */
export function canonicalRulePayload(input: RuleDefinitionInput): string {
  return withValueBudget(() => {
    const definition = normalizeStoredRuleDefinition(input);
    return ownCopy(() => canonicalize(definition));
  });
}
