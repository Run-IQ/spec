import { canonicalize } from '../canonical.js';
import { SpecError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import { isPlainObject } from '../values.js';
import type { RuleDefinition, RuleDefinitionInput } from './definition.js';
import type { ExecutableRule } from './executable.js';
import { normalizeRuleDefinition } from './normalize.js';
import type { StoredRuleRecord } from './stored.js';

/**
 * Payload and checksum to store for a rule: `payload` is the canonical JSON of the normalized
 * definition, `checksum` its sha256 hex (equal to `computeRuleChecksum(input)`).
 * A `checksum` in `input` is ignored. Throws `SpecError` like `normalizeRuleDefinition`.
 */
export function toStoredPayload(input: RuleDefinitionInput): { payload: string; checksum: string } {
  const payload = canonicalize(normalizeRuleDefinition(input));
  return { payload, checksum: sha256Hex(payload) };
}

/**
 * Normalizes a definition into a rule ready for evaluation: dates become `Date`, `checksum`
 * is computed (a `checksum` in `input` is ignored). Throws `SpecError` like
 * `normalizeRuleDefinition`.
 */
export function toExecutableRule(input: RuleDefinitionInput): ExecutableRule {
  return executableOf(normalizeRuleDefinition(input));
}

/**
 * Rebuilds the rule of a stored record and checks its integrity. Throws `SpecError`
 * (`INVALID_RULE`), with a message naming the rule (`id@version`) and the reason, when:
 * - the record is malformed;
 * - `payload` is not valid JSON;
 * - the payload's `id` or `version` differs from the record's;
 * - the payload is not a valid definition (whatever the underlying error code);
 * - the checksum recomputed from the payload differs from `record.checksum`.
 */
export function fromStoredRecord(record: StoredRuleRecord): ExecutableRule {
  const unknownRecord: unknown = record;
  if (!isPlainObject(unknownRecord)) {
    throw new SpecError('INVALID_RULE', 'Stored rule: the record must be an object');
  }
  const { id, version, checksum, payload } = unknownRecord;
  const name = `${String(id)}@${String(version)}`;
  const fail = (reason: string): never => {
    throw new SpecError('INVALID_RULE', `Stored rule ${name}: ${reason}`);
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
    fail(`payload is not valid JSON (${(error as Error).message})`);
  }
  if (!isPlainObject(parsed)) return fail('invalid definition: the payload must be a JSON object');
  if (parsed.id !== id || parsed.version !== version) {
    fail(`id/version mismatch: the payload holds ${String(parsed.id)}@${String(parsed.version)}`);
  }

  let definition: RuleDefinition;
  try {
    definition = normalizeRuleDefinition(parsed as RuleDefinitionInput);
  } catch (error) {
    return fail(`invalid definition: ${(error as Error).message}`);
  }
  const computed = sha256Hex(canonicalize(definition));
  if (computed !== checksum) {
    fail(`checksum mismatch: the record holds ${String(checksum)}, the payload gives ${computed}`);
  }
  return executableOf(definition);
}

function executableOf(definition: RuleDefinition): ExecutableRule {
  const checksum = sha256Hex(canonicalize(definition));
  const rule: Record<string, unknown> = { ...definition };
  rule.effectiveFrom = new Date(definition.effectiveFrom);
  rule.effectiveUntil =
    definition.effectiveUntil === null ? null : new Date(definition.effectiveUntil);
  rule.checksum = checksum;
  return rule as ExecutableRule;
}
