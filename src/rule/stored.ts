/**
 * The part of a stored rule (context-engine's `SerializedRule`) that conversion needs.
 * `payload` is `canonicalize(normalizeRuleDefinition(definition))` and `checksum` its sha256
 * hex, as returned by `toStoredPayload`. `id` and `version` must match the payload's.
 *
 * `fromStoredRecord` requires the payload to be canonical byte for byte
 * (`payload === canonicalize(normalizeRuleDefinition(JSON.parse(payload)))`) and
 * `checksum === sha256(payload)`: an equivalent but differently written payload is refused.
 */
export interface StoredRuleRecord {
  id: string;
  version: number;
  checksum: string;
  payload: string;
}
