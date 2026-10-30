import { toJsonValue } from '../canonical.js';
import { SpecError } from '../errors.js';
import { isPlainObject } from '../values.js';
import { parseRuleDate } from './date.js';
import { isRuleVersion, RESERVED_RULE_FIELDS } from './definition.js';

const RESERVED = new Set(RESERVED_RULE_FIELDS);
const OPTIONAL_STRINGS = ['output', 'dominanceGroup', 'sourceRef'] as const;

/** One problem found by `validateRuleDefinition`: the field path (`''` for the whole value). */
export interface RuleValidationIssue {
  path: string;
  message: string;
}

class Issues {
  readonly list: RuleValidationIssue[] = [];
  add(path: string, message: string): void {
    this.list.push({ path, message });
  }
}

/**
 * Checks a rule definition without throwing and reports every problem found. Accepts exactly
 * what `normalizeRuleDefinition` accepts, and agrees with `schema/rule-definition.schema.json`
 * on JSON documents, plus one check JSON Schema cannot express: `effectiveUntil` must be after
 * `effectiveFrom`. Like normalize, it also accepts `Date` objects for the dates and refuses
 * non-JSON values (Map, Set, class instances, functions, `NaN`, `Infinity`...).
 *
 * `checksum` is ignored, as in normalize.
 *
 * `errors` holds the messages; `issues` holds the same problems, in the same order, each with
 * the path of the offending field (`params.rates[1]`, `dimensions.country`; `''` when the
 * value itself is not an object).
 */
export function validateRuleDefinition(value: unknown): {
  valid: boolean;
  errors: string[];
  issues: RuleValidationIssue[];
} {
  const errors = new Issues();
  if (!isPlainObject(value)) {
    errors.add('', 'a rule definition must be a plain object');
    return result(errors);
  }

  checkNonEmptyString(value.id, 'id', errors);
  if (!isRuleVersion(value.version)) errors.add('version', 'version must be a positive integer');
  checkNonEmptyString(value.model, 'model', errors);
  if (value.params === undefined) errors.add('params', 'params is required');
  else checkJson(value.params, 'params', errors);
  if (typeof value.priority !== 'number' || !Number.isFinite(value.priority)) {
    errors.add('priority', 'priority must be a finite number');
  }

  const from = checkDate(value.effectiveFrom, 'effectiveFrom', errors);
  const until =
    value.effectiveUntil == null ? null : checkDate(value.effectiveUntil, 'effectiveUntil', errors);
  if (from !== undefined && until != null && until.getTime() <= from.getTime()) {
    errors.add(
      'effectiveUntil',
      'effectiveUntil must be after effectiveFrom: the window would be empty',
    );
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

  return result(errors);
}

function result(issues: Issues): {
  valid: boolean;
  errors: string[];
  issues: RuleValidationIssue[];
} {
  return {
    valid: issues.list.length === 0,
    errors: issues.list.map((i) => i.message),
    issues: issues.list,
  };
}

function checkNonEmptyString(value: unknown, field: string, errors: Issues): void {
  if (typeof value !== 'string' || value === '') {
    errors.add(field, `${field} must be a non-empty string`);
  }
}

function checkJson(value: unknown, field: string, errors: Issues): void {
  try {
    toJsonValue(value, field);
  } catch (error) {
    errors.add(pathOf(error, field), (error as Error).message);
  }
}

function checkDate(value: unknown, field: string, errors: Issues): Date | undefined {
  try {
    return parseRuleDate(value, field);
  } catch (error) {
    errors.add(pathOf(error, field), (error as Error).message);
    return undefined;
  }
}

function checkCondition(value: unknown, errors: Issues): void {
  if (!isPlainObject(value)) {
    errors.add('condition', 'condition must be an object { dsl, value }');
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'dsl' && key !== 'value') {
      errors.add(`condition.${key}`, `condition has an unknown key "${key}"`);
    }
  }
  checkNonEmptyString(value.dsl, 'condition.dsl', errors);
  if (value.value === undefined) errors.add('condition.value', 'condition.value is required');
  else checkJson(value.value, 'condition.value', errors);
}

function checkDimensions(value: unknown, errors: Issues): void {
  if (!isPlainObject(value)) {
    errors.add('dimensions', 'dimensions must be an object of strings');
    return;
  }
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v != null && typeof v !== 'string') {
      errors.add(`dimensions.${key}`, `dimensions.${key} must be a string`);
    }
  }
}

function checkTags(value: unknown, errors: Issues): void {
  if (
    !Array.isArray(value) ||
    !Array.from(value as unknown[]).every((t) => typeof t === 'string')
  ) {
    errors.add('tags', 'tags must be an array of strings');
  }
}

/** Path of a `SpecError` about one value, else the checked field. */
function pathOf(error: unknown, field: string): string {
  return error instanceof SpecError && error.path ? error.path : field;
}
