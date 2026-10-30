import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import type { RuleDefinitionInput } from './definition.js';
import { normalizeRuleDefinition } from './normalize.js';

/** Identity and validity window: left out of the fingerprint. `checksum` is already dropped. */
const NON_CONTENT_FIELDS = ['id', 'version', 'effectiveFrom', 'effectiveUntil'] as const;

/**
 * Content fingerprint of a rule: sha256 hex of the canonical NORMALIZED definition without
 * `id`, `version`, `effectiveFrom`, `effectiveUntil` and `checksum`. Two rules with the same
 * content under another id, version or window share it; it goes through the same
 * normalization as the checksum, so it does not depend on how the data is written.
 */
export function computeRuleFingerprint(input: RuleDefinitionInput): string {
  const content: Record<string, unknown> = normalizeRuleDefinition(input);
  for (const field of NON_CONTENT_FIELDS) delete content[field];
  return sha256Hex(canonicalize(content));
}
