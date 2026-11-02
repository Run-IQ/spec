import { isCanonicalText, canonicalSha256Hex } from '../canonical.js';
import { citeName, isOwnError, newSpecError, reasonOf, unreadableMessage } from '../errors.js';
import { sha256Hex } from '../hash.js';
import { isCivilDate } from '../time/civil.js';
import { isPlainObject, ownCopy, withValueBudget } from '../values.js';
import type { RuleDefinition, RuleDefinitionInput } from './definition.js';
import type { ExecutableRule } from './executable.js';
import { normalizeStoredRuleDefinition } from './normalize.js';
import { canonicalRulePayload } from './payload.js';
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
  const payload = canonicalRulePayload(input);
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
  return withValueBudget(() => {
    const definition = normalizeStoredRuleDefinition(input);
    // The normalized copy's values were counted when they were read from `input`.
    return executableOf(
      definition,
      ownCopy(() => canonicalSha256Hex(definition)),
    );
  });
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
  return withValueBudget(() => fromRecord(record));
}

function fromRecord(record: StoredRuleRecord): ExecutableRule {
  const { id, version, checksum, payload } = readRecord(record);
  const name = `${nameOf(id)}@${nameOf(version)}`;
  const fail = (reason: string): never => {
    throw newSpecError('INVALID_RULE', `Stored rule ${citeName(name)}: ${reason}`);
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
    fail(`payload is not valid JSON (${reasonOf(error)})`);
  }
  if (!isPlainObject(parsed)) return fail('invalid definition: the payload must be a JSON object');
  if (parsed.id !== id || parsed.version !== version) {
    fail(
      `id/version mismatch: the payload holds ` +
        `${citeName(nameOf(parsed.id))}@${citeName(nameOf(parsed.version))}`,
    );
  }

  let definition: RuleDefinition;
  try {
    definition = normalizeStoredRuleDefinition(parsed as unknown as RuleDefinitionInput);
  } catch (error) {
    // The error of `normalizeRuleDefinition` is its own: its message, already cited, as it is.
    return fail(`invalid definition: ${reasonOf(error)}`);
  }
  // The normalized copy's values were counted when they were read from the parsed payload.
  // Compared as it is written: the canonical text is never built.
  if (!ownCopy(() => isCanonicalText(definition, payload as string))) {
    fail('payload is not canonical');
  }
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
  return rule as unknown as ExecutableRule;
}

/**
 * The four fields of a stored record, each read once. A record that is not a plain object, or
 * that cannot be read (a getter or a Proxy trap that throws), is refused as `INVALID_RULE`.
 */
function readRecord(record: unknown): Record<'id' | 'version' | 'checksum' | 'payload', unknown> {
  try {
    if (!isPlainObject(record)) {
      throw newSpecError('INVALID_RULE', 'Stored rule: the record must be an object');
    }
    const { id, version, checksum, payload } = record;
    return { id, version, checksum, payload };
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw newSpecError('INVALID_RULE', unreadableMessage('stored rule record', error));
  }
}

/** A record field as a rule name shows it: a primitive as `String` writes it, never caller code. */
function nameOf(value: unknown): string {
  return typeof value === 'object' && value !== null
    ? 'an object'
    : typeof value === 'function'
      ? 'a function'
      : String(value);
}

/** A civil date stays a string; a canonical instant becomes a `Date`. */
function boundOf(bound: string): string | Date {
  return isCivilDate(bound) ? bound : new Date(bound);
}
