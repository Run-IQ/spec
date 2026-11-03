import { canonicalSha256Hex } from '../canonical.js';
import { ownCopy, withValueBudget } from '../values.js';
import type { RuleDefinitionInput } from './definition.js';
import { normalizeStoredRuleDefinition } from './normalize.js';

/**
 * Identity and validity window (its bounds, time zone and reference date say WHEN a rule applies,
 * not WHAT it does): left out of the fingerprint. `checksum` is already dropped.
 */
const NON_CONTENT_FIELDS = [
  'id',
  'version',
  'effectiveFrom',
  'effectiveUntil',
  'timeZone',
  'effectiveOn',
] as const;

/**
 * Content fingerprint of a rule: sha256 hex of the canonical NORMALIZED definition without
 * `id`, `version`, `effectiveFrom`, `effectiveUntil`, `timeZone`, `effectiveOn` and `checksum`.
 * Two rules with the same content under another id, version or window (time zone and reference
 * date included) share it. `ruleSet` and `forEach` stay in it: a bare name means another output
 * in another rule set (D-37), and iterating changes what a rule computes. It goes through the same
 * normalization as the checksum, so it does not depend on how the data is written.
 */
export function computeRuleFingerprint(input: RuleDefinitionInput): string {
  return withValueBudget(() => {
    const content: Record<string, unknown> = { ...normalizeStoredRuleDefinition(input) };
    for (const field of NON_CONTENT_FIELDS) delete content[field];
    // The normalized copy's values were counted when they were read from `input`.
    return ownCopy(() => canonicalSha256Hex(content));
  });
}
