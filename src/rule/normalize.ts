import { isPlainObject, toJsonValue } from '../canonical.js';
import { SpecError } from '../errors.js';
import { toIsoRuleDate } from './date.js';
import { RESERVED_RULE_FIELDS } from './definition.js';
import type { RuleDefinition, RuleDefinitionInput } from './definition.js';

const RESERVED = new Set(RESERVED_RULE_FIELDS);

/**
 * Builds the canonical definition of a rule, so that the same data always gives the same
 * definition however it was written:
 * - dates become full UTC ISO strings (see `parseRuleDate` for the accepted forms);
 * - defaults are made explicit: `effectiveUntil: null`, `dimensions: {}`, `tags: []`;
 * - `tags` are sorted and deduplicated;
 * - `checksum` is removed, and so is every top-level optional or extension field that is
 *   `null` or `undefined` (see `RuleDefinition`); nested `undefined` properties are dropped;
 * - nested values become plain JSON (`Date` to ISO string, `undefined` dropped);
 * - extension fields are kept at the top level.
 *
 * Never mutates `input`; the result shares no reference with it.
 * Throws `SpecError`: `INVALID_RULE` for a missing or mistyped field, `INVALID_DATE`,
 * `NON_SERIALIZABLE`.
 */
export function normalizeRuleDefinition(input: RuleDefinitionInput): RuleDefinition {
  if (!isPlainObject(input)) invalidRule('a rule definition must be a plain object');

  const out: Record<string, unknown> = {
    id: requireString(input.id, 'id'),
    version: requireNumber(input.version, 'version'),
    model: requireString(input.model, 'model'),
    params: requireParams(input.params),
    priority: requireNumber(input.priority, 'priority'),
    effectiveFrom: toIsoRuleDate(input.effectiveFrom, 'effectiveFrom'),
    effectiveUntil:
      input.effectiveUntil == null ? null : toIsoRuleDate(input.effectiveUntil, 'effectiveUntil'),
    dimensions: normalizeDimensions(input.dimensions),
    tags: normalizeTags(input.tags),
  };

  if (input.condition != null) out.condition = normalizeCondition(input.condition);
  for (const field of ['output', 'dominanceGroup', 'sourceRef'] as const) {
    const value = input[field];
    if (value != null) out[field] = requireString(value, field);
  }
  if (input.exceptions != null) out.exceptions = toJsonValue(input.exceptions, 'exceptions');

  for (const key of Object.keys(input)) {
    if (RESERVED.has(key)) continue;
    const value = input[key];
    if (value != null) defineField(out, key, toJsonValue(value, key));
  }

  return out as RuleDefinition;
}

function requireParams(value: unknown): unknown {
  if (value === undefined) invalidRule('params is required');
  return toJsonValue(value, 'params');
}

function normalizeCondition(value: unknown): { dsl: string; value: unknown } {
  if (!isPlainObject(value)) invalidRule('condition must be an object { dsl, value }');
  for (const key of Object.keys(value)) {
    if (key !== 'dsl' && key !== 'value') invalidRule(`condition has an unknown key "${key}"`);
  }
  if (value.value === undefined) invalidRule('condition.value is required');
  return {
    dsl: requireString(value.dsl, 'condition.dsl'),
    value: toJsonValue(value.value, 'condition.value'),
  };
}

function normalizeDimensions(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (!isPlainObject(value)) invalidRule('dimensions must be an object of strings');
  const out: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') invalidRule(`dimensions.${key} must be a string`);
    defineField(out, key, v);
  }
  return out;
}

function normalizeTags(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) invalidRule('tags must be an array of strings');
  const tags: unknown[] = Array.from(value);
  for (const tag of tags) {
    if (typeof tag !== 'string') invalidRule('tags must be an array of strings');
  }
  return [...new Set(tags as string[])].sort();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') invalidRule(`${field} must be a non-empty string`);
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidRule(`${field} must be a finite number`);
  }
  return value;
}

/** Plain assignment would turn a `__proto__` key into a prototype change. */
function defineField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function invalidRule(message: string): never {
  throw new SpecError('INVALID_RULE', message);
}
