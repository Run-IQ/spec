/**
 * The part of a stored rule (context-engine's `SerializedRule`) that conversion needs.
 * `payload` is `canonicalize(normalizeRuleDefinition(definition))` and `checksum` its sha256
 * hex, as returned by `toStoredPayload`. `id` and `version` must match the payload's.
 */
export interface StoredRuleRecord {
  id: string;
  version: number;
  checksum: string;
  payload: string;
}
