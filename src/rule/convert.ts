import { canonicalize } from '../canonical.js';
import { citeName, SpecError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import { isCivilDate } from '../time/civil.js';
import { isPlainObject } from '../values.js';
import type { RuleDefinition, RuleDefinitionInput } from './definition.js';
import type { ExecutableRule } from './executable.js';
import { normalizeRuleDefinition } from './normalize.js';
import type { StoredRuleRecord } from './stored.js';

/**
 * Payload and checksum to store for a rule: `payload` is the canonical JSON of the normalized
 * definition, `checksum` its sha256 hex (equal to `computeRuleChecksum(input)`).
 * A `checksum` in `input` is ignored. Throws `SpecError` like `normalizeRuleDefinition`.
 *
 * It re-seals: whatever the input held, the result carries a fresh checksum. A caller that
 * loaded a rule, edits it and re-seals it should first check the loaded rule with
 * `verifyRuleChecksum`, or tampering before the edit goes unnoticed.
 */
export function toStoredPayload(input: RuleDefinitionInput): { payload: string; checksum: string } {
  const payload = canonicalize(normalizeRuleDefinition(input));
  return { payload, checksum: sha256Hex(payload) };
}

/**
 * Normalizes a definition into a rule ready for evaluation: a civil bound stays a `YYYY-MM-DD`
 * string, an instant bound becomes a `Date` (D-13), `checksum`
 * is computed (a `checksum` in `input` is ignored). Throws `SpecError` like
 * `normalizeRuleDefinition`.
 *
 * It re-seals: whatever the input held, the result carries a fresh checksum. A caller that
 * loaded a rule, edits it and re-seals it should first check the loaded rule with
 * `verifyRuleChecksum`, or tampering before the edit goes unnoticed.
 */
export function toExecutableRule(input: RuleDefinitionInput): ExecutableRule {
  const definition = normalizeRuleDefinition(input);
  return executableOf(definition, sha256Hex(canonicalize(definition)));
}

/**
 * Rebuilds the rule of a stored record and checks its integrity. Throws `SpecError`
 * (`INVALID_RULE`), with a message naming the rule (`id@version`) and the reason, when:
 * - the record is malformed;
 * - `payload` is not valid JSON;
 * - the payload's `id` or `version` differs from the record's;
 * - the payload is not a valid definition (whatever the underlying error code);
 * - the payload is not exactly `canonicalize` of its normalized definition (key order, date
 *   form, tag order, an embedded `checksum`, a null extension, duplicate keys...);
 * - `sha256(payload)` differs from `record.checksum`.
 *
 * Because the payload must be canonical, the checksum proves the stored bytes themselves.
 */
export function fromStoredRecord(record: StoredRuleRecord): ExecutableRule {
  const unknownRecord: unknown = record;
  if (!isPlainObject(unknownRecord)) {
    throw new SpecError('INVALID_RULE', 'Stored rule: the record must be an object');
  }
  const { id, version, checksum, payload } = unknownRecord;
  const name = `${String(id)}@${String(version)}`;
  const fail = (reason: string): never => {
    throw new SpecError('INVALID_RULE', `Stored rule ${citeName(name)}: ${reason}`);
  };
  if (typeof id !== 'string' || typeof version !== 'number') {
    fail('malformed record: id must be a string and version a number');
  }
  if (typeof checksum !== 'string' || typeof payload !== 'string') {
    fail('malformed record: checksum and payload must be strings');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload as string);
  } catch (error) {
    fail(`payload is not valid JSON (${citeName(messageOf(error))})`);
  }
  if (!isPlainObject(parsed)) return fail('invalid definition: the payload must be a JSON object');
  if (parsed.id !== id || parsed.version !== version) {
    fail(
      `id/version mismatch: the payload holds ` +
        `${citeName(String(parsed.id))}@${citeName(String(parsed.version))}`,
    );
  }

  let definition: RuleDefinition;
  try {
    definition = normalizeRuleDefinition(parsed as RuleDefinitionInput);
  } catch (error) {
    return fail(`invalid definition: ${citeName(messageOf(error))}`);
  }
  if (canonicalize(definition) !== payload) fail('payload is not canonical');
  const computed = sha256Hex(payload as string);
  if (computed !== checksum) {
    fail(
      `checksum mismatch: the record holds ${citeName(String(checksum))}, the payload gives ` +
        `${computed}`,
    );
  }
  return executableOf(definition, computed);
}

function executableOf(definition: RuleDefinition, checksum: string): ExecutableRule {
  const rule: Record<string, unknown> = { ...definition };
  rule.effectiveFrom = boundOf(definition.effectiveFrom);
  rule.effectiveUntil =
    definition.effectiveUntil === null ? null : boundOf(definition.effectiveUntil);
  rule.checksum = checksum;
  return rule as ExecutableRule;
}

/** A civil date stays a string; a canonical instant becomes a `Date`. */
function boundOf(bound: string): string | Date {
  return isCivilDate(bound) ? bound : new Date(bound);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
