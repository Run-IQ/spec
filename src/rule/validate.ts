import { toJsonDocument, toJsonValue } from '../canonical.js';
import type { JsonValue } from '../canonical.js';
import { citeName, isOwnError, quoteText, unreadableMessage } from '../errors.js';
import { IssueList } from '../issues.js';
import type { RuleValidationIssue } from '../issues.js';
import { isReservedName } from '../reserved.js';
import {
  hasLoneSurrogate,
  isPlainObject,
  loneSurrogateMessage,
  ownCopy,
  readList,
  spendValues,
  tooLargeMessage,
  withValueBudget,
} from '../values.js';
import { isTimeZone, readReferenceDate, timeZoneMessage } from '../time/civil.js';
import type { CivilDate, Instant } from '../time/civil.js';
import { isRuleVersion, RESERVED_RULE_FIELDS } from './definition.js';
import {
  isUnnamable,
  readDimensionSpec,
  reservedDimensionNameMessage,
  unnamableNameMessage,
} from './dimensions.js';
import {
  exceptionFreeForm,
  exceptionModelIssues,
  normalizedOutput,
  readRuleExceptions,
} from './exceptions.js';
import { readForEach } from './forEach.js';
import type { ForEach } from './forEach.js';
import { citedNameProblem, isRuleSetId, LOCAL_RULE_SET, ruleSetIdMessage } from './ruleSet.js';
import { effectiveOnContextProblem, effectiveOnIssue, windowShapeProblem } from './window.js';

const RESERVED = new Set(RESERVED_RULE_FIELDS);
const OPTIONAL_STRINGS = ['output', 'dominanceGroup', 'sourceRef'] as const;

export type { RuleValidationIssue } from '../issues.js';

/** The problems of one check, bounded (`IssueList`). */
type Issues = IssueList;

/**
 * Checks a rule definition without throwing and reports every problem found. Accepts exactly
 * what `normalizeRuleDefinition` accepts, and agrees with `schema/rule-definition.schema.json`
 * on JSON documents, plus checks JSON Schema cannot express: `effectiveUntil` must be after
 * `effectiveFrom`, an instant must stay within the years 0000 to 9999 once its offset is applied,
 * and an `effectiveOn` must hold no lone UTF-16 surrogate. Both bounds must have the same form (two
 * civil dates or two instants, D-13); `timeZone` must pass `isTimeZone`; `effectiveOn` must point
 * to `/$dates/<name>`, `/$item/<path>` (with a `forEach`) or `/$segment/from` (with
 * `forEach.segments`; `$item` also needs `forEach.path` without `groupBy`). It checks the closed
 * `forEach` format (`ForEach`; JSON Schema cannot count the key names per level, find a repeated
 * `orderBy` path, or compare `segments.from` with `segments.until`), the closed `exceptions`
 * format and the constraints of the reserved model `EXCEPTION_MODEL` (no `output` but the
 * default, a non-empty `exceptions` list); it refuses an `id` holding `:`, a `ruleSet` that is
 * not a rule set id, and output names that are not `name` or `<rule set>:<name>` (D-4: at most
 * one `:`, no `.`, no `$` at the start of either part, ruling R36) in `output`, in a
 * `shortCircuit` output and in selector `outputs`, a selector id of a rule set the selector does
 * not target, and an exception carrier's `<other set>:value` output (JSON Schema cannot relate
 * them to the rule's `ruleSet`). Each dimension must be a `DimensionSpec`; JSON
 * Schema cannot refuse an `except` value repeated in `anyOf`. Every text (a string field, a tag,
 * a dimension key or value, an extension key, any string inside `params`, `condition.value`,
 * `forEach`, `exceptions` or an
 * extension) that holds a lone UTF-16 surrogate is refused, as `canonicalize` refuses it: a
 * valid rule always has a checksum. JSON Schema cannot express this check. Like
 * normalize, it also accepts `Date` objects for the dates and refuses non-JSON values (Map,
 * Set, class instances, functions, `NaN`, `Infinity`...).
 *
 * `checksum` is ignored, as in normalize.
 *
 * It never throws. A field that cannot be read while its value is converted to JSON (`params`,
 * `condition.value`, `exceptions`, an extension: a getter or a Proxy trap that throws) gives
 * `<field> could not be read: <reason>`. A free-form value (`params`, `condition.value`, an
 * extension) nested more than `MAX_JSON_DEPTH` (1000) levels deep gives `<path> is nested
 * deeper than 1000 levels` at its first container past the limit (`params.a…`); the copy keeps
 * its own stack, so it never overflows the call stack. An array with a hole gives `<path> has a
 * hole at index <i>: arrays must be dense`, and one call reads at most `MAX_JSON_VALUES` values
 * (`<path> is too large: more than 10000000 values`, a list's size counted before any element
 * is read). Anything else that cannot be read (a top-level property, the object itself)
 * gives the single issue `rule definition could not be read: <reason>` at `''`. A member whose
 * value is `undefined` is absent in an object the format defines, known or not; inside a
 * free-form value or as an array item, it gives `<path> is not JSON: undefined`.
 *
 * `errors` holds the messages; `issues` holds the same problems, in the same order, each with
 * the path of the offending field (`params.rates[1]`, `dimensions.country`; `''` when the
 * value itself is not an object).
 *
 * Lists at most 100 problems, in the order found, then one last issue `further problems not
 * listed (limit 100)`; a path or message longer than 1024 code units is cut there, then `…`
 * (`IssueList`, shared by every validator of the package).
 */
export function validateRuleDefinition(value: unknown): {
  valid: boolean;
  errors: string[];
  issues: RuleValidationIssue[];
} {
  try {
    return withValueBudget(() => definitionIssues(value));
  } catch (error) {
    const unreadable = new IssueList();
    unreadable.add('', unreadableMessage('rule definition', error));
    return result(unreadable);
  }
}

function definitionIssues(value: unknown): {
  valid: boolean;
  errors: string[];
  issues: RuleValidationIssue[];
} {
  const errors = new IssueList();
  if (!isPlainObject(value)) {
    errors.add('', 'a rule definition must be a plain object');
    return result(errors);
  }
  if (!spendValues(Object.keys(value).length)) {
    errors.add('', tooLargeMessage('rule definition'));
    return result(errors);
  }

  checkNonEmptyString(value.id, 'id', errors);
  if (typeof value.id === 'string' && value.id.includes(':')) {
    errors.add('id', 'id must not contain ":"');
  }
  const ruleSetValue = value.ruleSet;
  let ruleSet: string | undefined = LOCAL_RULE_SET;
  if (ruleSetValue != null) {
    ruleSet = isRuleSetId(ruleSetValue) ? ruleSetValue : undefined;
    if (ruleSet === undefined) errors.add('ruleSet', ruleSetIdMessage('ruleSet', ruleSetValue));
  }
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
  const effectiveOn = value.effectiveOn;
  const pointer = effectiveOn == null ? undefined : checkEffectiveOn(effectiveOn, errors);

  if (value.condition != null) checkCondition(value.condition, errors);
  for (const field of OPTIONAL_STRINGS) {
    if (value[field] != null) checkNonEmptyString(value[field], field, errors);
  }
  const output = value.output;
  if (typeof output === 'string' && output !== '') {
    const problem = citedNameProblem(output, 'output', 'output');
    if (problem !== undefined) errors.add('output', problem);
  }
  if (value.dimensions != null) checkDimensions(value.dimensions, errors);
  if (value.tags != null) checkTags(value.tags, errors);
  if (value.exceptions != null) checkExceptions(value.exceptions, ruleSet, errors);
  const modelIssues = exceptionModelIssues({
    model: value.model,
    output: normalizedOutput(value.output, ruleSet),
    exceptions: value.exceptions,
  });
  for (const issue of modelIssues) errors.add(issue.path, issue.message);

  // `forEach` is read once, and `effectiveOn` checked against the copy normalize would keep.
  const forEachValue = value.forEach;
  const forEach = forEachValue == null ? null : checkForEach(forEachValue, errors);
  if (pointer !== undefined && forEach !== undefined) {
    const problem = effectiveOnContextProblem(pointer, forEach ?? undefined);
    if (problem !== undefined) errors.add('effectiveOn', problem);
  }

  for (const key of Object.keys(value)) {
    if (RESERVED.has(key)) continue;
    const extension = value[key];
    if (extension == null) continue;
    if (hasLoneSurrogate(key)) {
      errors.add('', extensionKeyMessage(key));
      continue;
    }
    toJsonOrIssue(extension, key, errors);
  }

  return result(errors);
}

function result(issues: Issues): {
  valid: boolean;
  errors: string[];
  issues: RuleValidationIssue[];
} {
  return { valid: issues.length === 0, errors: issues.messages(), issues: issues.toArray() };
}

function checkNonEmptyString(value: unknown, field: string, errors: Issues): void {
  if (typeof value !== 'string' || value === '') {
    errors.add(field, `${citeName(field)} must be a non-empty string`);
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

/**
 * The JSON copy of `value` (`toJsonValue`, or `toJsonDocument` with `freeFormAt`), or
 * `undefined` after recording why it is not JSON.
 */
function toJsonOrIssue(
  value: unknown,
  field: string,
  errors: Issues,
  freeFormAt?: (depth: number, key: string) => boolean,
): JsonValue | undefined {
  try {
    return freeFormAt === undefined
      ? toJsonValue(value, field)
      : toJsonDocument(value, field, freeFormAt);
  } catch (error) {
    addError(error, field, errors);
    return undefined;
  }
}

/** No member of `forEach` holds a free-form value. */
const NOT_FREE_FORM = (): boolean => false;

function checkExceptions(value: unknown, ruleSet: string | undefined, errors: Issues): void {
  const json = toJsonOrIssue(value, 'exceptions', errors, exceptionFreeForm);
  if (json === undefined) return;
  // The copy's values were counted when they were read from the rule.
  errors.merge(ownCopy(() => readRuleExceptions(json, 'exceptions', ruleSet)).issues);
}

/** The normal form of a `forEach`, or `undefined` after recording why it is invalid. */
function checkForEach(value: unknown, errors: Issues): ForEach | undefined {
  const json = toJsonOrIssue(value, 'forEach', errors, NOT_FREE_FORM);
  if (json === undefined) return undefined;
  let valid = true;
  // The copy's values were counted when they were read from the rule.
  const forEach = ownCopy(() =>
    readForEach(json, (path, message) => {
      valid = false;
      errors.add(path, message);
    }),
  );
  return valid ? forEach : undefined;
}

function checkDate(value: unknown, field: string, errors: Issues): CivilDate | Instant | undefined {
  try {
    return readReferenceDate(value, field);
  } catch (error) {
    addError(error, field, errors);
    return undefined;
  }
}

/** The pointer of a valid `effectiveOn` shape, or `undefined` after recording why not. */
function checkEffectiveOn(value: unknown, errors: Issues): string | undefined {
  const problem = effectiveOnIssue(value);
  if (problem === undefined && typeof value === 'string') return value;
  errors.add('effectiveOn', problem ?? '');
  return undefined;
}

function checkCondition(value: unknown, errors: Issues): void {
  if (!isPlainObject(value)) {
    errors.add('condition', 'condition must be an object { dsl, value }');
    return;
  }
  const keys = Object.keys(value);
  if (!spendValues(keys.length)) {
    errors.add('condition', tooLargeMessage('condition'));
    return;
  }
  for (const key of keys) {
    // A member whose value is `undefined` is absent, known or not.
    if (key !== 'dsl' && key !== 'value' && value[key] !== undefined) {
      errors.add(`condition.${key}`, `condition has an unknown key ${quoteText(key)}`);
    }
  }
  checkNonEmptyString(value.dsl, 'condition.dsl', errors);
  if (value.value === undefined) errors.add('condition.value', 'condition.value is required');
  else checkJson(value.value, 'condition.value', errors);
}

function checkDimensions(value: unknown, errors: Issues): void {
  if (!isPlainObject(value)) {
    errors.add('dimensions', 'dimensions must be an object of dimension specs');
    return;
  }
  const keys = Object.keys(value);
  if (!spendValues(keys.length)) {
    errors.add('dimensions', tooLargeMessage('dimensions'));
    return;
  }
  for (const key of keys) {
    const v = value[key];
    if (isUnnamable(key)) {
      errors.add('dimensions', unnamableNameMessage('dimensions', 'dimension', key));
      continue;
    }
    if (isReservedName(key)) {
      errors.add(`dimensions.${key}`, reservedDimensionNameMessage(`dimensions.${key}`));
      continue;
    }
    if (v == null) continue; // the dimension is unset: normalize drops the key
    if (hasLoneSurrogate(key)) errors.add('dimensions', dimensionKeyMessage(key));
    else readDimensionSpec(v, `dimensions.${key}`, (path, message) => errors.add(path, message));
  }
}

function checkTags(value: unknown, errors: Issues): void {
  const tags = Array.isArray(value) ? readList(value, 'tags') : undefined;
  if (tags !== undefined && !Array.isArray(tags)) {
    errors.add(tags.path, tags.message);
    return;
  }
  if (!tags || !tags.every((t) => typeof t === 'string')) {
    errors.add('tags', 'tags must be an array of strings');
    return;
  }
  tags.forEach((tag, i) => {
    if (tag === '') errors.add(`tags[${i}]`, `tags[${i}] must be a non-empty string`);
    else if (typeof tag === 'string' && hasLoneSurrogate(tag)) {
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
  if (isOwnError(error)) errors.add(pathOf(error, field), error.message);
  else errors.add(field, unreadableMessage(field, error));
}

/** Path of a `SpecError` about one value, else the checked field. */
function pathOf(error: unknown, field: string): string {
  return isOwnError(error) && error.path ? error.path : field;
}
