import { toJsonValue } from '../canonical.js';
import type { JsonValue } from '../canonical.js';
import { SpecError, unreadableMessage } from '../errors.js';
import { isReservedOutputName, reservedOutputNameMessage } from '../decision/output.js';
import { hasLoneSurrogate, isPlainObject, loneSurrogateMessage } from '../values.js';
import { requireTimeZone } from '../time/civil.js';
import { isRuleVersion, RESERVED_RULE_FIELDS } from './definition.js';
import type { RuleDefinition, RuleDefinitionInput } from './definition.js';
import { exceptionModelIssues, readRuleExceptions } from './exceptions.js';
import { dimensionKeyMessage, extensionKeyMessage } from './validate.js';
import type { RuleValidationIssue } from './validate.js';
import {
  DEFAULT_EFFECTIVE_ON,
  effectiveOnContextProblem,
  readEffectiveOn,
  readRuleWindow,
} from './window.js';

const RESERVED = new Set(RESERVED_RULE_FIELDS);

/**
 * Builds the canonical definition of a rule, so that the same data always gives the same
 * definition however it was written:
 * - a civil bound `YYYY-MM-DD` stays civil; an instant bound becomes its canonical form
 *   `YYYY-MM-DDTHH:MM:SS.sssZ` (D-13; see `toReferenceDate` for the accepted forms);
 * - `timeZone` is written by `normalizeTimeZone` (`+00:00` and `-00:00` become `UTC`);
 * - `effectiveOn: '/$dates/effective'`, the default reference date, is dropped, as absent;
 * - defaults are made explicit: `effectiveUntil: null`, `dimensions: {}`, `tags: []`;
 * - `tags` are sorted and deduplicated;
 * - `exceptions` keep their order; each selector's `ids`, `tags`, `outputs` and `models` are
 *   sorted and deduplicated, and its empty fields dropped; an empty list is dropped, as absent;
 * - `checksum` is removed, and so is every top-level optional or extension field that is
 *   `null` or `undefined` (see `RuleDefinition`); nested `undefined` properties are dropped;
 * - nested values become plain JSON (`Date` to ISO string, `undefined` dropped);
 * - extension fields are kept at the top level.
 *
 * Never mutates `input`; the result shares no reference with it.
 * Throws `SpecError`: `INVALID_RULE` for a missing or mistyped field (`version` must be a
 * positive integer), for a malformed `exceptions` list, for a rule of model `EXCEPTION_MODEL`
 * with an `output` or without exceptions, for an output name starting with `$` (in `output`,
 * a `shortCircuit` output or selector `outputs`: reserved, ruling R36), when
 * `effectiveUntil <= effectiveFrom` (an empty window), for bounds of two forms (one civil, one
 * instant: `effectiveFrom and effectiveUntil must both be civil dates or both instants`), for an
 * invalid `timeZone` (`isTimeZone`) or `effectiveOn` (`/$dates/<name>`, `/$item/<path>` with a
 * `forEach`, `/$segment/from` with `forEach.segments`), for a lone UTF-16 surrogate in a string
 * field, a tag, a dimension key or value or an extension key, `INVALID_DATE`,
 * `NON_SERIALIZABLE`. The `INVALID_RULE` message names the path of the field, as the issues of
 * `validateRuleDefinition` do. A field that cannot be read while it is converted to JSON
 * (`params`, `condition.value`, `exceptions`, an extension: a getter or a Proxy trap that
 * throws) gives `INVALID_RULE` with `<field> could not be read: <reason>`, or `<field> is too
 * deeply nested` when it overflows the call stack, as in `validateRuleDefinition`; anything
 * else that cannot be read gives `rule definition could not be read: <reason>`.
 */
export function normalizeRuleDefinition(input: RuleDefinitionInput): RuleDefinition {
  try {
    return normalize(input);
  } catch (error) {
    if (error instanceof SpecError) throw error;
    // A hostile value (a throwing getter, a Proxy trap) never escapes as a raw error.
    invalidRule(unreadableMessage('rule definition', error));
  }
}

function normalize(input: RuleDefinitionInput): RuleDefinition {
  if (!isPlainObject(input)) invalidRule('a rule definition must be a plain object');

  const { from, until } = readRuleWindow(input.effectiveFrom, input.effectiveUntil);

  const out: Record<string, unknown> = {
    id: requireString(input.id, 'id'),
    version: requireVersion(input.version),
    model: requireString(input.model, 'model'),
    params: requireParams(input.params),
    priority: requireNumber(input.priority, 'priority'),
    effectiveFrom: from,
    effectiveUntil: until,
    dimensions: normalizeDimensions(input.dimensions),
    tags: normalizeTags(input.tags),
  };

  const timeZone = input.timeZone;
  if (timeZone != null) out.timeZone = requireTimeZone(timeZone, 'INVALID_RULE');
  const effectiveOnInput = input.effectiveOn;
  const effectiveOn = effectiveOnInput == null ? undefined : readEffectiveOn(effectiveOnInput);
  if (input.condition != null) out.condition = normalizeCondition(input.condition);
  for (const field of ['output', 'dominanceGroup', 'sourceRef'] as const) {
    const value = input[field];
    if (value != null) out[field] = requireString(value, field);
  }
  if (typeof out.output === 'string' && isReservedOutputName(out.output)) {
    invalidRule(reservedOutputNameMessage('output'));
  }
  if (input.exceptions != null) {
    const read = readRuleExceptions(readJson(input.exceptions, 'exceptions'));
    throwFirst(read.issues);
    if (read.exceptions.length > 0) out.exceptions = read.exceptions;
  }
  throwFirst(exceptionModelIssues(input));

  for (const key of Object.keys(input)) {
    if (RESERVED.has(key)) continue;
    const value = input[key];
    if (value == null) continue;
    if (hasLoneSurrogate(key)) invalidRule(extensionKeyMessage(key));
    defineField(out, key, readJson(value, key));
  }

  // Checked on the copy the result keeps (`forEach` is read once), so the result is valid.
  if (effectiveOn !== undefined) {
    const forEach = Object.hasOwn(out, 'forEach') ? out.forEach : undefined;
    const problem = effectiveOnContextProblem(effectiveOn, forEach);
    if (problem !== undefined) invalidRule(problem);
    // The default reference date is written as its absence: one rule, one checksum.
    if (effectiveOn !== DEFAULT_EFFECTIVE_ON) out.effectiveOn = effectiveOn;
  }

  return out as RuleDefinition;
}

/**
 * `toJsonValue(value, field)`, where anything but a `SpecError` thrown while reading (a getter,
 * a Proxy trap, a call stack overflow) becomes `INVALID_RULE` naming `field`.
 */
function readJson(value: unknown, field: string): JsonValue {
  try {
    return toJsonValue(value, field);
  } catch (error) {
    if (error instanceof SpecError) throw error;
    invalidRule(unreadableMessage(field, error));
  }
}

function requireParams(value: unknown): unknown {
  if (value === undefined) invalidRule('params is required');
  return readJson(value, 'params');
}

function normalizeCondition(value: unknown): { dsl: string; value: unknown } {
  if (!isPlainObject(value)) invalidRule('condition must be an object { dsl, value }');
  for (const key of Object.keys(value)) {
    if (key !== 'dsl' && key !== 'value') invalidRule(`condition has an unknown key "${key}"`);
  }
  if (value.value === undefined) invalidRule('condition.value is required');
  return {
    dsl: requireString(value.dsl, 'condition.dsl'),
    value: readJson(value.value, 'condition.value'),
  };
}

function normalizeDimensions(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (!isPlainObject(value)) invalidRule('dimensions must be an object of strings');
  const out: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v == null) continue; // null or undefined: the dimension is unset
    if (hasLoneSurrogate(key)) invalidRule(dimensionKeyMessage(key));
    if (typeof v !== 'string') invalidRule(`dimensions.${key} must be a string`);
    if (hasLoneSurrogate(v)) invalidRule(loneSurrogateMessage(`dimensions.${key}`));
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
  tags.forEach((tag, i) => {
    if (typeof tag === 'string' && hasLoneSurrogate(tag)) {
      invalidRule(loneSurrogateMessage(`tags[${i}]`));
    }
  });
  return [...new Set(tags as string[])].sort();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') invalidRule(`${field} must be a non-empty string`);
  if (hasLoneSurrogate(value)) invalidRule(loneSurrogateMessage(field));
  return value;
}

function requireVersion(value: unknown): number {
  if (!isRuleVersion(value)) invalidRule('version must be a positive integer');
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

/** Throws the first issue as `INVALID_RULE`; its message already names the path. */
function throwFirst(issues: readonly RuleValidationIssue[]): void {
  const [first] = issues;
  if (first) invalidRule(first.message);
}

function invalidRule(message: string): never {
  throw new SpecError('INVALID_RULE', message);
}
