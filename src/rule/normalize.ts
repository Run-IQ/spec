import { toJsonDocument, toJsonValue } from '../canonical.js';
import type { JsonValue } from '../canonical.js';
import { citeName, isOwnError, newSpecError, quoteText, unreadableMessage } from '../errors.js';
import { DEFAULT_OUTPUT } from '../decision/output.js';
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
import { requireTimeZone } from '../time/civil.js';
import { isRuleVersion } from './definition.js';
import {
  isUnnamable,
  readDimensionSpec,
  reservedDimensionNameMessage,
  unnamableNameMessage,
} from './dimensions.js';
import type { DimensionSpec } from './dimensions.js';
import type { RuleDefinition, RuleDefinitionInput } from './definition.js';
import { exceptionFreeForm, exceptionModelIssues, readRuleExceptions } from './exceptions.js';
import { readForEach } from './forEach.js';
import type { ForEach } from './forEach.js';
import {
  citedNameProblem,
  isRuleSetId,
  LOCAL_RULE_SET,
  ruleSetIdMessage,
  shortestFrom,
} from './ruleSet.js';
import {
  CHECKSUM_NOT_STRING,
  EXTENSIONS_NOT_OBJECT,
  nullFieldMessage,
  unknownRuleFieldMessage,
  unknownRuleKeys,
} from './fields.js';
import { dimensionKeyMessage } from './validate.js';
import { boundIssueText, IssueList } from '../issues.js';
import type { RuleValidationIssue } from '../issues.js';
import {
  DEFAULT_EFFECTIVE_ON,
  effectiveOnContextProblem,
  readEffectiveOn,
  readRuleWindow,
} from './window.js';
import {
  NativeSet,
  arrayForEach,
  arrayIsArray,
  arraySort,
  numberIsFinite,
  objectDefineProperty,
  objectKeys,
  stringIncludes,
} from '../intrinsics.js';

/**
 * Builds the canonical definition of a rule, so that the same data always gives the same
 * definition however it was written:
 * - a civil bound `YYYY-MM-DD` stays civil; an instant bound becomes its canonical form
 *   `YYYY-MM-DDTHH:MM:SS.sssZ` (D-13; see `toReferenceDate` for the accepted forms);
 * - `timeZone` is written by `normalizeTimeZone` (`+00:00` and `-00:00` become `UTC`);
 * - `effectiveOn: '/$dates/effective'`, the default reference date, is dropped, as absent;
 * - defaults are made explicit: `effectiveUntil: null`, `dimensions: {}`, `tags: []`;
 * - each dimension spec takes its normal form (`DimensionSpec`): `anyOf` and `except` sorted
 *   and deduplicated, an empty `except` and `match: 'any'` dropped, `{ anyOf: [v] }` written `v`;
 * - `tags` are sorted and deduplicated;
 * - `ruleSet: 'local'` is dropped, as absent: a local rule has no rule set (D-4);
 * - `output: 'value'` (the default output; `rgpd:value` in a rule of `rgpd` too) is dropped;
 * - a name qualified by the rule's own rule set is written bare (`rgpd:x` in a rule of `rgpd`
 *   is `x`, D-37), in `output`, `shortCircuit` outputs and selector `ids` and `outputs`;
 * - `forEach` takes its normal form (`ForEach`): a `key` list whose names are all equal is
 *   written as that name, an empty `orderBy` or `dimensions` is dropped, the `facts` of
 *   `segments` are sorted by pointer and deduplicated; the order of `orderBy` is kept;
 * - `exceptions` keep their order; each selector's `ids`, `tags`, `outputs`, `models` and
 *   `ruleSets` are sorted and deduplicated, its dimension specs in normal form, its empty
 *   fields dropped, and `ruleSets` listing only the rule's own rule set dropped; an empty list
 *   is dropped, as absent;
 * - `checksum` is removed, and so is every top-level optional field that is `undefined`; a
 *   member whose value is `undefined` in an object the format defines (`condition`, a dimension
 *   spec, an exception, a selector, `forEach`) is absent, known or not. `null` is refused in an
 *   optional field (`<field> is null: omit the field instead`) and in `dimensions`
 *   (`dimensions.<name> is null: ...`), `effectiveUntil` and `checksum` included (see `RuleDefinition`);
 * - a top-level key that is not a reserved field is refused (`unknown rule field: <key>`, with
 *   `(did you mean <field>?)` for a misspelling); what a plugin adds goes under `extensions`,
 *   a plain object whose values are free-form JSON, kept as it is and dropped when empty;
 * - nested values become plain JSON (`Date` to ISO string); an `undefined` inside a free-form
 *   value (`params`, `condition.value`, an extension, a `substitute`'s `params`, a
 *   `shortCircuit`'s `value`) or as an array item anywhere is refused (`NON_SERIALIZABLE`,
 *   `<path> is not JSON: undefined`, as `validateRuleDefinition` reports it);
 *
 * Never mutates `input`; the result shares no reference with it.
 * Throws `SpecError`: `INVALID_RULE` for a missing or mistyped field (`version` must be a
 * positive integer), for a malformed `exceptions` list, for a rule of model `EXCEPTION_MODEL`
 * with an `output` or without exceptions, for an `id` holding `:`, a `ruleSet` that is not a
 * rule set id (`isRuleSetId`), an output name that is not `name` or `<rule set>:<name>` (in
 * `output`, a `shortCircuit` output or selector `outputs`: at most one `:`, no `.`, no `$` at the
 * start of either part, ruling R36 and D-4, the rule set part a rule set id other than `local`),
 * a selector id of a rule set the selector does not target, an invalid `forEach` (see
 * `ForEach`; its message names the path, `forEach.key has 3 names for 2 levels`), when
 * `effectiveUntil <= effectiveFrom` (an empty window), for bounds of two forms (one civil, one
 * instant: `effectiveFrom and effectiveUntil must both be civil dates or both instants`), for an
 * invalid `timeZone` (`isTimeZone`) or `effectiveOn` (`/$dates/<name>`, `/$item/<path>` with a
 * `forEach` that has `path` and no `groupBy`, `/$segment/from` with `forEach.segments`), for an
 * invalid dimension spec (an empty
 * value, an empty `anyOf`, an `except` value repeated in `anyOf`, an `except` without `ref`...:
 * see `DimensionSpec`), for a lone UTF-16 surrogate in a string
 * field, a tag, a dimension key or value, `INVALID_DATE`,
 * `NON_SERIALIZABLE`. The `INVALID_RULE` message names the path of the field, as the issues of
 * `validateRuleDefinition` do. A field that cannot be read while it is converted to JSON
 * (`params`, `condition.value`, `forEach`, `exceptions`, an extension: a getter or a Proxy trap
 * that throws) gives `INVALID_RULE` with `<field> could not be read: <reason>`, as in
 * `validateRuleDefinition`; a free-form value nested too deep, holding an array with a hole or
 * more than `MAX_JSON_VALUES` values gives `NON_SERIALIZABLE` (`<path> is nested deeper than
 * 1000 levels`, `<path> has a hole at index <i>: arrays must be dense`, `<path> is too large:
 * more than 10000000 values`, the list's size counted before any element is read); anything
 * else that cannot be read gives `rule definition could not be read: <reason>`. A message (and
 * a `NON_SERIALIZABLE` path) longer than 1024 code units is cut there and followed by `…`,
 * exactly as `validateRuleDefinition` cuts its issues: both give the same first message.
 */
export function normalizeRuleDefinition(input: RuleDefinitionInput): RuleDefinition {
  return normalizeForm(input, false);
}

/**
 * Internal: `normalizeRuleDefinition` for a rule read back in its normalized or stored form, as
 * the functions listed in the README ("Rule definition") read it. The one difference:
 * `effectiveUntil: null`, the internal encoding of "no end" that a normalized definition holds,
 * is accepted. What an author writes (`normalizeRuleDefinition`, `validateRuleDefinition`)
 * refuses it: omit the field. A `null` `checksum` is refused in both forms.
 */
export function normalizeStoredRuleDefinition(input: RuleDefinitionInput): RuleDefinition {
  return normalizeForm(input, true);
}

function normalizeForm(input: RuleDefinitionInput, stored: boolean): RuleDefinition {
  try {
    return withValueBudget(() => normalize(input, stored));
  } catch (error) {
    // Cut as `validateRuleDefinition` cuts its issues, so both give the same first message.
    if (isOwnError(error)) {
      const message = boundIssueText(error.message);
      const path = error.path === undefined ? undefined : boundIssueText(error.path);
      if (message === error.message && path === error.path) throw error;
      throw newSpecError(error.code, message, path);
    }
    // A hostile value (a throwing getter, a Proxy trap) never escapes as a raw error.
    invalidRule(unreadableMessage('rule definition', error));
  }
}

function normalize(input: RuleDefinitionInput, stored: boolean): RuleDefinition {
  if (!isPlainObject(input)) invalidRule('a rule definition must be a plain object');
  if (!spendValues(objectKeys(input).length)) invalidRule(tooLargeMessage('rule definition'));

  // The keys alone, before any value: an unknown field is refused whatever it holds.
  for (const key of unknownRuleKeys(input)) invalidRule(unknownRuleFieldMessage(key));
  const untilInput = input.effectiveUntil;
  if (!stored) {
    if (untilInput === null) invalidRule(nullFieldMessage('effectiveUntil'));
  }
  const checksum = input.checksum;
  if (checksum === null || (checksum !== undefined && typeof checksum !== 'string')) {
    invalidRule(checksum === null ? nullFieldMessage('checksum') : CHECKSUM_NOT_STRING);
  }
  const { from, until } = readRuleWindow(input.effectiveFrom, untilInput);

  const ruleSet = readRuleSet(input.ruleSet);
  const out: Record<string, unknown> = {
    id: requireId(input.id),
    version: requireVersion(input.version),
    model: requireString(input.model, 'model'),
    params: requireParams(input.params),
    priority: requireNumber(input.priority, 'priority'),
    effectiveFrom: from,
    effectiveUntil: until,
    dimensions: normalizeDimensions(input.dimensions),
    tags: normalizeTags(input.tags),
  };

  if (ruleSet !== LOCAL_RULE_SET) out.ruleSet = ruleSet;
  const timeZone = given(input.timeZone, 'timeZone');
  if (timeZone !== undefined) out.timeZone = requireTimeZone(timeZone, 'INVALID_RULE');
  const effectiveOnInput = given(input.effectiveOn, 'effectiveOn');
  const effectiveOn =
    effectiveOnInput === undefined ? undefined : readEffectiveOn(effectiveOnInput);
  const condition = given(input.condition, 'condition');
  if (condition !== undefined) out.condition = normalizeCondition(condition);
  for (const field of ['output', 'dominanceGroup', 'sourceRef'] as const) {
    const value = given(input[field], field);
    if (value !== undefined) out[field] = requireString(value, field);
  }
  if (typeof out.output === 'string') {
    const problem = citedNameProblem(out.output, 'output', 'output');
    if (problem !== undefined) invalidRule(problem);
    const output = shortestFrom(ruleSet, out.output);
    // The default output is written as its absence: one rule, one checksum.
    if (output === DEFAULT_OUTPUT) delete out.output;
    else out.output = output;
  }
  const exceptions = given(input.exceptions, 'exceptions');
  if (exceptions !== undefined) {
    const json = readJson(exceptions, 'exceptions', exceptionFreeForm);
    // The copy's values were counted when they were read from the rule.
    const read = ownCopy(() => readRuleExceptions(json, 'exceptions', ruleSet));
    throwFirst(read.issues.toArray());
    if (read.exceptions.length > 0) out.exceptions = read.exceptions;
  }
  throwFirst(exceptionModelIssues({ model: input.model, output: out.output, exceptions }));
  const forEachInput = given(input.forEach, 'forEach');
  const forEach = forEachInput === undefined ? undefined : readForEachField(forEachInput);
  if (forEach !== undefined) out.forEach = forEach;

  const extensions = given(input.extensions, 'extensions');
  if (extensions !== undefined) {
    const read = readExtensions(extensions);
    if (read !== undefined) out.extensions = read;
  }

  // Checked on the copy the result keeps (`forEach` is read once), so the result is valid.
  if (effectiveOn !== undefined) {
    const problem = effectiveOnContextProblem(effectiveOn, forEach);
    if (problem !== undefined) invalidRule(problem);
    // The default reference date is written as its absence: one rule, one checksum.
    if (effectiveOn !== DEFAULT_EFFECTIVE_ON) out.effectiveOn = effectiveOn;
  }

  return out as unknown as RuleDefinition;
}

/**
 * `toJsonValue(value, field)` (or `toJsonDocument` with `freeFormAt`), where anything but a
 * `SpecError` thrown while reading (a getter, a Proxy trap) becomes `INVALID_RULE` naming
 * `field`.
 */
function readJson(
  value: unknown,
  field: string,
  freeFormAt?: (depth: number, key: string) => boolean,
): JsonValue {
  try {
    return freeFormAt === undefined
      ? toJsonValue(value, field)
      : toJsonDocument(value, field, freeFormAt);
  } catch (error) {
    if (isOwnError(error)) throw error;
    invalidRule(unreadableMessage(field, error));
  }
}

/** `value` itself, read once; `undefined` when absent. `null` is refused: omit the field. */
function given(value: unknown, field: string): unknown {
  if (value === null) invalidRule(nullFieldMessage(field));
  return value;
}

/**
 * The `extensions` object of the rule (read once, as JSON), or `undefined` when it is empty.
 * Its keys are free names, reserved ones included; its values are free-form JSON, but a name
 * whose value is `null` is refused (omit it): deeper, `null` is data.
 */
function readExtensions(value: unknown): Record<string, JsonValue> | undefined {
  if (!isPlainObject(value)) invalidRule(EXTENSIONS_NOT_OBJECT);
  const json = readJson(value, 'extensions') as Record<string, JsonValue>;
  const keys = objectKeys(json);
  // A name with no value is written by omitting it: `null` at the first level is refused, as
  // at the top level of the rule. Deeper, `null` is data.
  for (const key of keys) {
    if (json[key] === null) invalidRule(nullFieldMessage(`extensions.${key}`));
  }
  return keys.length === 0 ? undefined : json;
}

/** The rule set of the rule: `local` when absent (`undefined`); `null` is refused. */
function readRuleSet(value: unknown): string {
  if (value === undefined) return LOCAL_RULE_SET;
  given(value, 'ruleSet');
  if (!isRuleSetId(value)) invalidRule(ruleSetIdMessage('ruleSet', value));
  return value;
}

/** A non-empty `id` without `:`, which separates a rule set from a name (D-4). */
function requireId(value: unknown): string {
  const id = requireString(value, 'id');
  if (stringIncludes(id, ':')) invalidRule('id must not contain ":"');
  return id;
}

/** The normal form of `forEach` (read once, as JSON), or `INVALID_RULE` for its first problem. */
function readForEachField(value: unknown): ForEach | undefined {
  const problems = new IssueList();
  const json = readJson(value, 'forEach', () => false);
  // The copy's values were counted when they were read from the rule.
  const forEach = ownCopy(() =>
    readForEach(json, (path, message) => {
      problems.add(path, message);
    }),
  );
  throwFirst(problems.toArray());
  return forEach;
}

function requireParams(value: unknown): unknown {
  if (value === undefined) invalidRule('params is required');
  return readJson(value, 'params');
}

function normalizeCondition(value: unknown): { dsl: string; value: unknown } {
  if (!isPlainObject(value)) invalidRule('condition must be an object { dsl, value }');
  const keys = objectKeys(value);
  if (!spendValues(keys.length)) invalidRule(tooLargeMessage('condition'));
  for (const key of keys) {
    // A member whose value is `undefined` is absent, known or not.
    if (key !== 'dsl' && key !== 'value' && value[key] !== undefined) {
      invalidRule(`condition has an unknown key ${quoteText(key)}`);
    }
  }
  if (value.value === undefined) invalidRule('condition.value is required');
  return {
    dsl: requireString(value.dsl, 'condition.dsl'),
    value: readJson(value.value, 'condition.value'),
  };
}

function normalizeDimensions(input: unknown): Record<string, DimensionSpec> {
  const value = given(input, 'dimensions');
  if (value === undefined) return {};
  if (!isPlainObject(value)) invalidRule('dimensions must be an object of dimension specs');
  const keys = objectKeys(value);
  if (!spendValues(keys.length)) invalidRule(tooLargeMessage('dimensions'));
  const out: Record<string, DimensionSpec> = {};
  for (const key of arraySort(keys)) {
    const v = value[key];
    if (isUnnamable(key)) invalidRule(unnamableNameMessage('dimensions', 'dimension', key));
    if (isReservedName(key)) invalidRule(reservedDimensionNameMessage(`dimensions.${key}`));
    if (v === undefined) continue; // the dimension is unset
    if (v === null) invalidRule(nullFieldMessage(`dimensions.${key}`));
    if (hasLoneSurrogate(key)) invalidRule(dimensionKeyMessage(key));
    const problems = new IssueList();
    const spec = readDimensionSpec(v, `dimensions.${key}`, (path, message) => {
      problems.add(path, message);
    });
    throwFirst(problems.toArray());
    if (spec !== undefined) defineField(out, key, spec);
  }
  return out;
}

function normalizeTags(input: unknown): string[] {
  const value = given(input, 'tags');
  if (value === undefined) return [];
  if (!arrayIsArray(value)) invalidRule('tags must be an array of strings');
  const tags = readList(value, 'tags');
  if (!arrayIsArray(tags)) invalidRule(tags.message);
  for (const tag of tags) {
    if (typeof tag !== 'string') invalidRule('tags must be an array of strings');
  }
  arrayForEach(tags, (tag, i) => {
    if (tag === '') invalidRule(`tags[${i}] must be a non-empty string`);
    if (typeof tag === 'string' && hasLoneSurrogate(tag)) {
      invalidRule(loneSurrogateMessage(`tags[${i}]`));
    }
  });
  return arraySort([...new NativeSet(tags as string[])]);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    invalidRule(`${citeName(field)} must be a non-empty string`);
  }
  if (hasLoneSurrogate(value)) invalidRule(loneSurrogateMessage(field));
  return value;
}

function requireVersion(value: unknown): number {
  if (!isRuleVersion(value)) invalidRule('version must be a positive integer');
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !numberIsFinite(value)) {
    invalidRule(`${citeName(field)} must be a finite number`);
  }
  return value;
}

/** Plain assignment would turn a `__proto__` key into a prototype change. */
function defineField(target: Record<string, unknown>, key: string, value: unknown): void {
  objectDefineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Throws the first issue as `INVALID_RULE`; its message already names the path. */
function throwFirst(issues: readonly RuleValidationIssue[]): void {
  const [first] = issues;
  if (first) invalidRule(first.message);
}

function invalidRule(message: string): never {
  throw newSpecError('INVALID_RULE', message);
}
