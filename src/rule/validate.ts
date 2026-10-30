import { toJsonValue } from '../canonical.js';
import { isPlainObject } from '../values.js';
import { parseRuleDate } from './date.js';
import { isRuleVersion, RESERVED_RULE_FIELDS } from './definition.js';

const RESERVED = new Set(RESERVED_RULE_FIELDS);
const OPTIONAL_STRINGS = ['output', 'dominanceGroup', 'sourceRef'] as const;

/**
 * Checks a rule definition without throwing and reports every problem found. Accepts exactly
 * what `normalizeRuleDefinition` accepts, and agrees with `schema/rule-definition.schema.json`
 * on JSON documents, plus one check JSON Schema cannot express: `effectiveUntil` must be after
 * `effectiveFrom`. Like normalize, it also accepts `Date` objects for the dates and refuses
 * non-JSON values (Map, Set, class instances, functions, `NaN`, `Infinity`...).
 *
 * `checksum` is ignored, as in normalize.
 */
export function validateRuleDefinition(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return { valid: false, errors: ['a rule definition must be a plain object'] };
  }

  checkNonEmptyString(value.id, 'id', errors);
  if (!isRuleVersion(value.version)) errors.push('version must be a positive integer');
  checkNonEmptyString(value.model, 'model', errors);
  if (value.params === undefined) errors.push('params is required');
  else checkJson(value.params, 'params', errors);
  if (typeof value.priority !== 'number' || !Number.isFinite(value.priority)) {
    errors.push('priority must be a finite number');
  }

  const from = checkDate(value.effectiveFrom, 'effectiveFrom', errors);
  const until =
    value.effectiveUntil == null ? null : checkDate(value.effectiveUntil, 'effectiveUntil', errors);
  if (from !== undefined && until != null && until.getTime() <= from.getTime()) {
    errors.push('effectiveUntil must be after effectiveFrom: the window would be empty');
  }

  if (value.condition != null) checkCondition(value.condition, errors);
  for (const field of OPTIONAL_STRINGS) {
    if (value[field] != null) checkNonEmptyString(value[field], field, errors);
  }
  if (value.dimensions != null) checkDimensions(value.dimensions, errors);
  if (value.tags != null) checkTags(value.tags, errors);
  if (value.exceptions != null) checkJson(value.exceptions, 'exceptions', errors);

  for (const key of Object.keys(value)) {
    if (RESERVED.has(key) || value[key] == null) continue;
    checkJson(value[key], key, errors);
  }

  return { valid: errors.length === 0, errors };
}

function checkNonEmptyString(value: unknown, field: string, errors: string[]): void {
  if (typeof value !== 'string' || value === '') errors.push(`${field} must be a non-empty string`);
}

function checkJson(value: unknown, field: string, errors: string[]): void {
  try {
    toJsonValue(value, field);
  } catch (error) {
    errors.push((error as Error).message);
  }
}

function checkDate(value: unknown, field: string, errors: string[]): Date | undefined {
  try {
    return parseRuleDate(value, field);
  } catch (error) {
    errors.push((error as Error).message);
    return undefined;
  }
}

function checkCondition(value: unknown, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push('condition must be an object { dsl, value }');
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'dsl' && key !== 'value') errors.push(`condition has an unknown key "${key}"`);
  }
  checkNonEmptyString(value.dsl, 'condition.dsl', errors);
  if (value.value === undefined) errors.push('condition.value is required');
  else checkJson(value.value, 'condition.value', errors);
}

function checkDimensions(value: unknown, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push('dimensions must be an object of strings');
    return;
  }
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v != null && typeof v !== 'string') errors.push(`dimensions.${key} must be a string`);
  }
}

function checkTags(value: unknown, errors: string[]): void {
  if (
    !Array.isArray(value) ||
    !Array.from(value as unknown[]).every((t) => typeof t === 'string')
  ) {
    errors.push('tags must be an array of strings');
  }
}
