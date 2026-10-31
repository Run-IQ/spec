import { toJsonValue } from '../canonical.js';
import type { JsonValue } from '../canonical.js';
import { quoteText, SpecError, unreadableMessage } from '../errors.js';
import { isReservedOutputName, reservedOutputNameMessage } from '../decision/output.js';
import { hasLoneSurrogate, isPlainObject, loneSurrogateMessage } from '../values.js';
import { isTimeZone, readReferenceDate, timeZoneMessage } from '../time/civil.js';
import type { CivilDate, Instant } from '../time/civil.js';
import { isRuleVersion, RESERVED_RULE_FIELDS } from './definition.js';
import { exceptionModelIssues, readRuleExceptions } from './exceptions.js';
import { effectiveOnContextProblem, effectiveOnIssue, windowShapeProblem } from './window.js';

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
 * on JSON documents, plus checks JSON Schema cannot express: `effectiveUntil` must be after
 * `effectiveFrom`, an instant must stay within the years 0000 to 9999 once its offset is applied,
 * and an `effectiveOn` must hold no lone UTF-16 surrogate. Both bounds must have the same form (two
 * civil dates or two instants, D-13); `timeZone` must pass `isTimeZone`; `effectiveOn` must point
 * to `/$dates/<name>`, `/$item/<path>` (with a `forEach`) or `/$segment/from` (with
 * `forEach.segments`). It checks the closed `exceptions` format and the constraints of the reserved
 * model `EXCEPTION_MODEL` (no `output`, a non-empty `exceptions` list), and refuses output names
 * starting with `$` (reserved, ruling R36) in `output`, in a `shortCircuit` output and in selector
 * `outputs`. Every text (a string field, a tag, a dimension key or
 * value, an extension key, any string inside `params`, `condition.value`, `exceptions` or an
 * extension) that holds a lone UTF-16 surrogate is refused, as `canonicalize` refuses it: a
 * valid rule always has a checksum. JSON Schema cannot express this check. Like
 * normalize, it also accepts `Date` objects for the dates and refuses non-JSON values (Map,
 * Set, class instances, functions, `NaN`, `Infinity`...).
 *
 * `checksum` is ignored, as in normalize.
 *
 * It never throws. A field that cannot be read while its value is converted to JSON (`params`,
 * `condition.value`, `exceptions`, an extension: a getter or a Proxy trap that throws) gives
 * `<field> could not be read: <reason>`, or `<field> is too deeply nested` when it overflows
 * the call stack. Anything else that cannot be read (a top-level property, the object itself)
 * gives the single issue `rule definition could not be read: <reason>` at `''`.
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
  try {
    return definitionIssues(value);
  } catch (error) {
    const unreadable = new Issues();
    unreadable.add('', unreadableMessage('rule definition', error));
    return result(unreadable);
  }
}

function definitionIssues(value: unknown): {
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
  if (from !== undefined && until !== undefined) {
    const problem = windowShapeProblem(from, until);
    if (problem !== undefined) errors.add('effectiveUntil', problem);
  }
  if (value.timeZone != null && !isTimeZone(value.timeZone)) {
    errors.add('timeZone', timeZoneMessage(value.timeZone));
  }
  if (value.effectiveOn != null) checkEffectiveOn(value.effectiveOn, value.forEach, errors);

  if (value.condition != null) checkCondition(value.condition, errors);
  for (const field of OPTIONAL_STRINGS) {
    if (value[field] != null) checkNonEmptyString(value[field], field, errors);
  }
  if (typeof value.output === 'string' && isReservedOutputName(value.output)) {
    errors.add('output', reservedOutputNameMessage('output'));
  }
  if (value.dimensions != null) checkDimensions(value.dimensions, errors);
  if (value.tags != null) checkTags(value.tags, errors);
  if (value.exceptions != null) checkExceptions(value.exceptions, errors);
  for (const issue of exceptionModelIssues(value)) errors.add(issue.path, issue.message);

  for (const key of Object.keys(value)) {
    if (RESERVED.has(key) || value[key] == null) continue;
    if (hasLoneSurrogate(key)) errors.add('', extensionKeyMessage(key));
    else checkJson(value[key], key, errors);
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
  } else if (hasLoneSurrogate(value)) errors.add(field, loneSurrogateMessage(field));
}

/** Internal: the message refusing an extension key that holds a lone UTF-16 surrogate. */
export function extensionKeyMessage(key: string): string {
  return `rule definition has an extension key with a lone UTF-16 surrogate: ${quoteText(key)}`;
}

/** Internal: the message refusing a dimension key that holds a lone UTF-16 surrogate. */
export function dimensionKeyMessage(key: string): string {
  return `dimensions has a key with a lone UTF-16 surrogate: ${quoteText(key)}`;
}

function checkJson(value: unknown, field: string, errors: Issues): void {
  toJsonOrIssue(value, field, errors);
}

/** The JSON copy of `value`, or `undefined` after recording why it is not JSON. */
function toJsonOrIssue(value: unknown, field: string, errors: Issues): JsonValue | undefined {
  try {
    return toJsonValue(value, field);
  } catch (error) {
    addError(error, field, errors);
    return undefined;
  }
}

function checkExceptions(value: unknown, errors: Issues): void {
  const json = toJsonOrIssue(value, 'exceptions', errors);
  if (json === undefined) return;
  for (const issue of readRuleExceptions(json).issues) errors.add(issue.path, issue.message);
}

function checkDate(value: unknown, field: string, errors: Issues): CivilDate | Instant | undefined {
  try {
    return readReferenceDate(value, field);
  } catch (error) {
    addError(error, field, errors);
    return undefined;
  }
}

function checkEffectiveOn(value: unknown, forEach: unknown, errors: Issues): void {
  const problem =
    effectiveOnIssue(value) ??
    (typeof value === 'string' ? effectiveOnContextProblem(value, forEach) : undefined);
  if (problem !== undefined) errors.add('effectiveOn', problem);
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
    if (v == null) continue; // the dimension is unset: normalize drops the key
    if (hasLoneSurrogate(key)) errors.add('dimensions', dimensionKeyMessage(key));
    else if (typeof v !== 'string') {
      errors.add(`dimensions.${key}`, `dimensions.${key} must be a string`);
    } else if (hasLoneSurrogate(v)) {
      errors.add(`dimensions.${key}`, loneSurrogateMessage(`dimensions.${key}`));
    }
  }
}

function checkTags(value: unknown, errors: Issues): void {
  const tags: unknown[] | undefined = Array.isArray(value) ? Array.from(value) : undefined;
  if (!tags || !tags.every((t) => typeof t === 'string')) {
    errors.add('tags', 'tags must be an array of strings');
    return;
  }
  tags.forEach((tag, i) => {
    if (typeof tag === 'string' && hasLoneSurrogate(tag)) {
      errors.add(`tags[${i}]`, loneSurrogateMessage(`tags[${i}]`));
    }
  });
}

/**
 * Records a thrown error as an issue on `field`: a `SpecError` with its own message and path;
 * anything else was thrown while reading the value (a getter, a Proxy trap, a call stack
 * overflow) and gives `unreadableMessage(field, error)`.
 */
function addError(error: unknown, field: string, errors: Issues): void {
  if (error instanceof SpecError) errors.add(pathOf(error, field), error.message);
  else errors.add(field, unreadableMessage(field, error));
}

/** Path of a `SpecError` about one value, else the checked field. */
function pathOf(error: unknown, field: string): string {
  return error instanceof SpecError && error.path ? error.path : field;
}
