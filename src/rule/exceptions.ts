import type { JsonValue } from '../canonical.js';
import { DEFAULT_OUTPUT } from '../decision/output.js';
import { citeName, isOwnError, newSpecError, quoteText, unreadableMessage } from '../errors.js';
import { isReservedName } from '../reserved.js';
import { isPlainObject, readList as readCallerList, typeName, withValueBudget } from '../values.js';
import {
  readDimensionSpec,
  isUnnamable,
  reservedDimensionNameMessage,
  unnamableNameMessage,
  sameDimensionSpec,
} from './dimensions.js';
import type { DimensionSpec } from './dimensions.js';
import {
  citedNameProblem,
  isRuleSetId,
  LOCAL_RULE_SET,
  qualifiedFrom,
  qualifyName,
  RULE_SET_GRAMMAR,
  ruleSetIdMessage,
  ruleSetOf,
  shortestFrom,
} from './ruleSet.js';
import { IssueList } from '../issues.js';
import type { RuleValidationIssue } from '../issues.js';

/**
 * Which rules an exception targets. Fields combine by AND; the values of one field by OR
 * (`{ tags: ['a', 'b'], models: ['M'] }`: model `M` and tag `a` or `b`). `dimensions` requires
 * every listed key to be WRITTEN the same on the rule, both specs in normal form (X-10): the
 * selector `{ pays: 'UE' }` does not target a rule `{ pays: 'FR' }`, whatever the referential
 * says, so the set of targeted rules stays static. `outputs` compares the rule's output, the
 * default output (`value`) when it names none. An empty field puts no constraint, like an absent
 * one; a selector must constrain at least one field other than `ruleSets`.
 *
 * Rule sets (D-37): `ruleSets` lists the rule sets whose rules the selector targets (`local` for
 * the rules without a rule set); absent, only the rule set of the rule that carries the
 * exception (the carrier). `ids` and `outputs` are names cited from the carrier: bare, they
 * designate its rule set; qualified (`rgpd:profilage`), the named one. Validation refuses a name
 * that cannot match (D-23): an id must belong to a targeted rule set; an output must belong to
 * a targeted rule set or, when a pack is targeted, to any rule set but `local` (a pack may import
 * another rule set, never `local`). In normal form, names qualified
 * by the carrier's own rule set are written bare, and `ruleSets` listing only it is dropped.
 */
export interface RuleSelector {
  ids?: string[];
  tags?: string[];
  dimensions?: Record<string, DimensionSpec>;
  outputs?: string[];
  models?: string[];
  ruleSets?: string[];
}

/**
 * One exception a rule carries, applied when the rule itself applies:
 * - `inhibit`: the targeted rules do not apply;
 * - `substitute`: the targeted rules apply with `params` deep-merged into theirs;
 * - `shortCircuit`: the output named `output` takes `value`, whatever other rules contribute.
 */
export type RuleException =
  | { kind: 'inhibit'; targets: RuleSelector }
  | { kind: 'substitute'; targets: RuleSelector; params: { [k: string]: JsonValue } }
  | { kind: 'shortCircuit'; output: string; value: JsonValue; reason?: string };

/**
 * Reserved model of a rule that computes nothing and only carries exceptions. Such a rule has
 * a non-empty `exceptions` list and no `output`.
 */
export const EXCEPTION_MODEL = '@run-iq/exception';

/**
 * True when the rule is one `selector` targets (see `RuleSelector`), the selector being carried
 * by a rule of the rule set `carrier` (`local` by default). A rule without `ruleSet` is a
 * `local` rule. Names are compared in full (D-37): the selector's bare names qualified by
 * `carrier`, the rule's id and output (the default output `value` when it names none) by the
 * rule's own rule set (`<pack>:value` for a pack rule without output). A selector that
 * constrains no field matches nothing; validation refuses it anyway. Dimension specs are
 * compared in normal form, so `{ anyOf: ['FR'] }` and `'FR'` are the same.
 *
 * Throws `SpecError` (`INVALID_RULE`), whatever the selector would match:
 * - `rule must be a plain object` for a rule that is not one;
 * - `rule could not be read: …` / `selector could not be read: …` when reading the rule or the
 *   selector throws (a throwing getter, a Proxy trap, a revoked Proxy); both are copied once,
 *   before any comparison;
 * - `rule ruleSet must be a string, got …` / `carrier ruleSet must be a string, got …`, then
 *   `rule ruleSet "X" is not a rule set id (…)` / `carrier ruleSet "X" is not a rule set id
 *   (…)` for a rule set that is not a rule set id;
 * - `rule.id must be a non-empty string`, `rule.model must be a non-empty string`,
 *   `rule.tags must be an array of strings`, `rule.output must be a string when present`,
 *   `rule.dimensions must be an object of dimension specs` for a malformed rule;
 * - `selector must be an object, got a value of type …`, `selector.<field> must be an array of
 *   strings` for `ids`, `tags`, `outputs`, `models` or `ruleSets` present but not an array of
 *   strings, and `selector.dimensions must be an object of dimension specs`;
 * - `qualifyName: …` for a rule id holding `:` (not a bare name);
 * - the message of `readDimensionSpec` for an invalid or unreadable compared dimension spec.
 */
export function matchesSelector(
  rule: {
    id: string;
    ruleSet?: string | undefined;
    tags: readonly string[];
    dimensions: Readonly<Record<string, DimensionSpec>>;
    output?: string | undefined;
    model: string;
  },
  selector: RuleSelector,
  carrier: string = LOCAL_RULE_SET,
): boolean {
  return withValueBudget(() => matches(rule, selector, carrier));
}

function matches(rule: unknown, selector: unknown, carrier: unknown): boolean {
  const target = readOnce('rule', () => copyRule(rule));
  const wanted = readOnce('selector', () => copySelector(selector));
  const { ruleSet } = target;
  requireRuleSet(carrier, 'carrier ruleSet');
  if (!constrains(wanted)) return false;
  const { ids, tags, dimensions, outputs, models } = wanted;
  const targeted = new Set(wanted.ruleSets?.length ? wanted.ruleSets : [carrier]);
  if (!targeted.has(ruleSet)) return false;
  if (ids?.length) {
    const id = qualifyName(ruleSet, target.id);
    if (!ids.some((name) => qualifiedFrom(carrier, name) === id)) return false;
  }
  if (tags?.length) {
    const own = new Set(target.tags);
    if (!tags.some((tag) => own.has(tag))) return false;
  }
  if (outputs?.length) {
    const output = qualifiedFrom(ruleSet, target.output ?? DEFAULT_OUTPUT);
    if (!outputs.some((name) => qualifiedFrom(carrier, name) === output)) return false;
  }
  if (models?.length && !models.includes(target.model)) return false;
  if (dimensions) {
    for (const [key, value] of Object.entries(dimensions)) {
      if (!Object.hasOwn(target.dimensions, key)) return false;
      if (!sameDimensionSpec(target.dimensions[key], value)) return false;
    }
  }
  return true;
}

/** Runs `read`, turning anything but a `SpecError` it throws into an unreadable `subject`. */
function readOnce<T>(subject: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw newSpecError('INVALID_RULE', unreadableMessage(subject, error));
  }
}

function requireRuleSet(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string') {
    selectorError(`${citeName(what)} must be a string, got ${typeName(value)}`);
  }
  if (!isRuleSetId(value)) {
    selectorError(
      `${citeName(what)} ${quoteText(value)} is not a rule set id (${RULE_SET_GRAMMAR})`,
    );
  }
}

/** What `matchesSelector` reads of a rule. */
interface RuleCopy {
  id: string;
  ruleSet: string;
  tags: string[];
  dimensions: Record<string, unknown>;
  output: string | undefined;
  model: string;
}

/** The fields of `rule` that `matchesSelector` reads, checked and copied once. */
function copyRule(rule: unknown): RuleCopy {
  if (!isPlainObject(rule)) selectorError('rule must be a plain object');
  const { id, tags, dimensions, output, model } = rule;
  const ruleSet = rule.ruleSet ?? LOCAL_RULE_SET;
  requireRuleSet(ruleSet, 'rule ruleSet');
  if (typeof id !== 'string' || id === '') selectorError('rule.id must be a non-empty string');
  if (typeof model !== 'string' || model === '') {
    selectorError('rule.model must be a non-empty string');
  }
  const tagList = stringList(tags, 'rule.tags');
  if (output !== undefined && typeof output !== 'string') {
    selectorError('rule.output must be a string when present');
  }
  if (!isPlainObject(dimensions)) {
    selectorError('rule.dimensions must be an object of dimension specs');
  }
  return { id, ruleSet, tags: tagList, dimensions: copyEntries(dimensions), output, model };
}

/** The fields of `selector` that `matchesSelector` reads, checked and copied once. */
function copySelector(selector: unknown): RuleSelector {
  if (!isPlainObject(selector)) {
    selectorError(`selector must be an object, got a value of type ${typeName(selector)}`);
  }
  const copy: RuleSelector = {};
  for (const field of [...SELECTOR_LISTS, 'ruleSets'] as const) {
    const value = selector[field];
    if (value === undefined) continue;
    copy[field] = stringList(value, `selector.${field}`);
  }
  const dimensions = selector.dimensions;
  if (dimensions !== undefined) {
    if (!isPlainObject(dimensions)) {
      selectorError('selector.dimensions must be an object of dimension specs');
    }
    // Unchecked here on purpose: `sameDimensionSpec` checks (and safely reads) each compared
    // spec, refusing an invalid one with `INVALID_RULE`.
    copy.dimensions = copyEntries(dimensions) as Record<string, DimensionSpec>;
  }
  return copy;
}

/** A shallow copy of the own enumerable entries of `value`, as data (`__proto__` included). */
function copyEntries(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(value).map((key) => [key, value[key]]));
}

/**
 * A copy of the caller's list of strings at `path`, each element read once (`readList`: no hole,
 * at most `MAX_JSON_VALUES` elements, counted before any is read); `INVALID_RULE` otherwise.
 */
function stringList(value: unknown, path: string): string[] {
  const items = Array.isArray(value) ? readCallerList(value, path) : undefined;
  if (items !== undefined && !Array.isArray(items)) selectorError(items.message);
  if (items === undefined || !items.every((item): item is string => typeof item === 'string')) {
    selectorError(`${citeName(path)} must be an array of strings`);
  }
  return items;
}

function selectorError(message: string): never {
  throw newSpecError('INVALID_RULE', message);
}

/**
 * Internal: the members of `exceptions` that hold a free-form value, for `toJsonDocument`: the
 * `params` of a `substitute` and the `value` of a `shortCircuit` (members of an item, depth 1).
 * Anywhere else, an `undefined` member is absent.
 */
export function exceptionFreeForm(depth: number, key: string): boolean {
  return depth === 1 && (key === 'params' || key === 'value');
}

/** Every exception kind. Internal: not exported from the package. */
export const KINDS = ['inhibit', 'substitute', 'shortCircuit'] as const;
const KEYS_BY_KIND: Readonly<Record<RuleException['kind'], readonly string[]>> = {
  inhibit: ['kind', 'targets'],
  substitute: ['kind', 'targets', 'params'],
  shortCircuit: ['kind', 'output', 'value', 'reason'],
};
const SELECTOR_LISTS = ['ids', 'tags', 'outputs', 'models'] as const;
const SELECTOR_KEYS: readonly string[] = [
  'ids',
  'tags',
  'dimensions',
  'outputs',
  'models',
  'ruleSets',
];
/** The fields that constrain a selector: `ruleSets` alone would target a whole rule set. */
const CONSTRAINING_KEYS = 'ids, tags, dimensions, outputs, models';

/**
 * Internal to `@run-iq/spec` (not exported from the package): shared by
 * `normalizeRuleDefinition` and `validateRuleDefinition` so that they cannot disagree.
 *
 * Reads the `exceptions` field of a rule of the rule set `ruleSet` (the carrier), already
 * converted to JSON, without throwing. Returns every problem found, each with its path under
 * `path`, and, when there is none, the normalized list: each selector's `ids`, `tags`,
 * `outputs`, `models` and `ruleSets` sorted and deduplicated, names qualified by the carrier's
 * own rule set written bare (as in a `shortCircuit` output), `ruleSets` dropped when it lists
 * only the carrier's, its dimension specs in normal form, empty selector fields dropped. The
 * order of the list itself is kept: it has a meaning. `null` gives an empty list (absent).
 * `ruleSet` `undefined` means the rule's own rule set is invalid: the checks that need it are
 * skipped, since that rule is refused anyway.
 */
export function readRuleExceptions(
  value: JsonValue,
  path: string,
  ruleSet: string | undefined,
): { exceptions: RuleException[]; issues: IssueList } {
  const issues = new IssueList();
  const add = (at: string, message: string): void => {
    issues.add(at, message);
  };
  if (value === null) return { exceptions: [], issues };
  if (!Array.isArray(value)) {
    add(path, `${citeName(path)} must be an array of exceptions`);
    return { exceptions: [], issues };
  }
  const exceptions: RuleException[] = [];
  value.forEach((item, i) => {
    const exception = readException(item, `${path}[${i}]`, ruleSet, add);
    if (exception) exceptions.push(exception);
  });
  return { exceptions: issues.length === 0 ? exceptions : [], issues };
}

/**
 * Internal to `@run-iq/spec` (not exported from the package): shared by
 * `normalizeRuleDefinition` and `validateRuleDefinition` so that they cannot disagree.
 *
 * The constraints of `EXCEPTION_MODEL` on a rule: no `output` and a non-empty `exceptions` list
 * (`null` and `[]` count as absent). `output` is the normalized one (see `normalizedOutput`):
 * the default output (`value`, `<own set>:value`) is absent, exactly as in the normal form.
 * Any other model gives no issue.
 */
export function exceptionModelIssues(rule: {
  readonly model?: unknown;
  readonly output?: unknown;
  readonly exceptions?: unknown;
}): RuleValidationIssue[] {
  if (rule.model !== EXCEPTION_MODEL) return [];
  const issues: RuleValidationIssue[] = [];
  if (rule.output !== undefined) {
    issues.push({
      path: 'output',
      message: `output must be absent: a rule of model "${EXCEPTION_MODEL}" produces no output`,
    });
  }
  if (rule.exceptions == null || (Array.isArray(rule.exceptions) && rule.exceptions.length === 0)) {
    issues.push({
      path: 'exceptions',
      message:
        'exceptions must list at least one exception: ' +
        `a rule of model "${EXCEPTION_MODEL}" only carries exceptions`,
    });
  }
  return issues;
}

/**
 * Internal: the `output` the normal form keeps for a raw `output` in a rule of `ruleSet`:
 * `undefined` for an absent (`null`) or default one (`value`, `<ruleSet>:value`, D-37), the
 * shortest spelling otherwise. Any other value (not a string, an invalid name) is returned
 * as is, to be refused. With `ruleSet` `undefined` (not a rule set id), a qualified name is
 * not judged: `undefined` too, since the rule set issue already refuses the rule.
 */
export function normalizedOutput(output: unknown, ruleSet: string | undefined): unknown {
  if (output == null) return undefined;
  if (typeof output !== 'string' || citedNameProblem(output, 'output', 'output') !== undefined) {
    return output;
  }
  if (ruleSet === undefined) {
    return output.includes(':') || output === DEFAULT_OUTPUT ? undefined : output;
  }
  const shortest = shortestFrom(ruleSet, output);
  return shortest === DEFAULT_OUTPUT ? undefined : shortest;
}

type Add = (path: string, message: string) => void;

/**
 * Refuses the selector names that no targeted rule can ever match (D-23), bare names being
 * resolved in `carrier`. An id of rule set S names a rule of S: S must be targeted. An output of
 * S is fed by the rules of S or by the packs that import S, and a pack never imports `local`
 * (a certified pack cannot depend on uncorrected content): S must be targeted, or not `local`
 * with at least one targeted pack.
 */
function checkReach(
  lists: Partial<Record<(typeof SELECTOR_LISTS)[number], string[]>>,
  targetedList: readonly string[],
  carrier: string,
  path: string,
  fail: Add,
): void {
  const targeted = new Set(targetedList);
  const packTargeted = targetedList.some((set) => set !== LOCAL_RULE_SET);
  lists.ids?.forEach((name, i) => {
    const set = ruleSetOf(carrier, name);
    if (!targeted.has(set)) {
      fail(
        `${path}.ids[${i}]`,
        `${citeName(path)}.ids[${i}] names a rule of ${quoteText(set)}, a rule set the selector ` +
          `does ` +
          'not target',
      );
    }
  });
  lists.outputs?.forEach((name, i) => {
    const set = ruleSetOf(carrier, name);
    if (!targeted.has(set) && (set === LOCAL_RULE_SET || !packTargeted)) {
      fail(
        `${path}.outputs[${i}]`,
        `${citeName(path)}.outputs[${i}] names an output of ${quoteText(set)}: ` +
          (set === LOCAL_RULE_SET
            ? 'only local rules feed it (a pack never imports local), and the selector does ' +
              'not target local'
            : `only rules of ${citeName(set)} or of a pack that imports it feed it, and the ` +
              `selector ` +
              `targets neither ${citeName(set)} nor any pack`),
      );
    }
  });
}

function readException(
  item: JsonValue,
  path: string,
  ruleSet: string | undefined,
  add: Add,
): RuleException | undefined {
  if (!isJsonObject(item)) {
    add(path, `${citeName(path)} must be an object with a kind`);
    return undefined;
  }
  const kind = KINDS.find((k) => k === item.kind);
  if (kind === undefined) {
    add(`${path}.kind`, `${citeName(path)}.kind must be one of ${KINDS.join(', ')}`);
    return undefined;
  }
  let valid = true;
  const fail: Add = (at, message) => {
    valid = false;
    add(at, message);
  };
  for (const key of Object.keys(item)) {
    if (!KEYS_BY_KIND[kind].includes(key)) {
      fail(
        `${path}.${key}`,
        `${citeName(path)} has an unknown key ${quoteText(key)} for kind ${kind}`,
      );
    }
  }

  let exception: RuleException | undefined;
  if (kind === 'shortCircuit') {
    let output = readNonEmptyString(item.output, `${path}.output`, fail);
    const problem =
      output === undefined ? undefined : citedNameProblem(output, `${path}.output`, 'output');
    if (problem !== undefined) {
      fail(`${path}.output`, problem);
      output = undefined;
    }
    if (output !== undefined && ruleSet !== undefined) output = shortestFrom(ruleSet, output);
    const value = item.value;
    if (value === undefined) {
      fail(`${path}.value`, `${citeName(path)}.value is required (null is a value)`);
    }
    const reason =
      item.reason === undefined
        ? undefined
        : readNonEmptyString(item.reason, `${path}.reason`, fail);
    if (output !== undefined && value !== undefined) {
      exception = reason === undefined ? { kind, output, value } : { kind, output, value, reason };
    }
  } else {
    const targets = readSelector(item.targets, `${path}.targets`, ruleSet, fail);
    if (kind === 'inhibit') {
      if (targets) exception = { kind, targets };
    } else if (!isJsonObject(item.params)) {
      fail(`${path}.params`, `${citeName(path)}.params must be an object of parameters to merge`);
    } else if (targets) {
      exception = { kind, targets, params: item.params };
    }
  }
  return valid ? exception : undefined;
}

function readSelector(
  value: JsonValue | undefined,
  path: string,
  carrier: string | undefined,
  add: Add,
): RuleSelector | undefined {
  if (value === undefined || !isJsonObject(value)) {
    add(
      path,
      `${citeName(path)} must be a selector { ${SELECTOR_KEYS.map((k) => `${k}?`).join(', ')} }`,
    );
    return undefined;
  }
  let valid = true;
  const fail: Add = (at, message) => {
    valid = false;
    add(at, message);
  };
  for (const key of Object.keys(value)) {
    if (!SELECTOR_KEYS.includes(key)) {
      fail(`${path}.${key}`, `${citeName(path)} has an unknown key ${quoteText(key)}`);
    }
  }

  const ruleSets = readRuleSets(value.ruleSets, `${path}.ruleSets`, fail);
  const lists: Partial<Record<(typeof SELECTOR_LISTS)[number], string[]>> = {};
  for (const field of SELECTOR_LISTS) {
    const list = readList(value[field], `${path}.${field}`, true, fail);
    if (list === undefined) continue;
    if (field === 'ids' || field === 'outputs') {
      list.forEach((name, i) => {
        const at = `${path}.${field}[${i}]`;
        const problem = citedNameProblem(name, at, field === 'ids' ? 'rule' : 'output');
        if (problem !== undefined) fail(at, problem);
      });
    }
    lists[field] = list;
  }
  if (valid && carrier !== undefined) {
    checkReach(lists, ruleSets?.length ? ruleSets : [carrier], carrier, path, fail);
  }

  const selector: RuleSelector = {};
  for (const field of SELECTOR_LISTS) {
    let list = lists[field];
    if (list === undefined || list.length === 0) continue;
    if (carrier !== undefined && (field === 'ids' || field === 'outputs')) {
      list = list.map((name) => shortestFrom(carrier, name));
    }
    selector[field] = [...new Set(list)].sort();
  }
  const dimensions = readDimensions(value.dimensions, `${path}.dimensions`, fail);
  if (dimensions && Object.keys(dimensions).length > 0) selector.dimensions = dimensions;
  if (ruleSets !== undefined && ruleSets.length > 0) {
    const sorted = [...new Set(ruleSets)].sort();
    // Listing only the carrier's rule set is the default: one meaning, one spelling.
    if (!(sorted.length === 1 && sorted[0] === carrier)) selector.ruleSets = sorted;
  }

  if (valid && !constrains(selector)) {
    fail(
      path,
      `${citeName(path)} must constrain at least one of ${CONSTRAINING_KEYS}: ` +
        'an empty selector would target every rule',
    );
  }
  return valid ? selector : undefined;
}

/** `ruleSets`: a list of rule set ids, `local` included; `undefined` when absent or invalid. */
function readRuleSets(value: JsonValue | undefined, path: string, fail: Add): string[] | undefined {
  const list = readList(value, path, true, fail);
  if (list === undefined) return undefined;
  let valid = true;
  list.forEach((id, i) => {
    if (!isRuleSetId(id)) {
      valid = false;
      fail(`${path}[${i}]`, ruleSetIdMessage(`${path}[${i}]`, id));
    }
  });
  return valid ? list : undefined;
}

/** A list of strings (non-empty ones when `nonEmpty`); `undefined` when absent or invalid. */
function readList(
  value: JsonValue | undefined,
  path: string,
  nonEmpty: boolean,
  fail: Add,
): string[] | undefined {
  if (value === undefined) return undefined;
  const expected = nonEmpty ? 'a non-empty string' : 'a string';
  if (!Array.isArray(value)) {
    fail(
      path,
      `${citeName(path)} must be an array of ${nonEmpty ? 'non-empty strings' : 'strings'}`,
    );
    return undefined;
  }
  const strings: string[] = [];
  value.forEach((item, i) => {
    if (typeof item !== 'string' || (nonEmpty && item === '')) {
      fail(`${path}[${i}]`, `${citeName(path)}[${i}] must be ${expected}`);
    } else {
      strings.push(item);
    }
  });
  return strings.length === value.length ? strings : undefined;
}

function readDimensions(
  value: JsonValue | undefined,
  path: string,
  fail: Add,
): Record<string, DimensionSpec> | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    fail(path, `${citeName(path)} must be an object of dimension specs`);
    return undefined;
  }
  const entries: [string, DimensionSpec][] = [];
  for (const key of Object.keys(value).sort()) {
    if (isUnnamable(key)) {
      fail(path, unnamableNameMessage(path, 'dimension', key));
      continue;
    }
    if (isReservedName(key)) {
      fail(`${path}.${key}`, reservedDimensionNameMessage(`${path}.${key}`));
      continue;
    }
    const spec = readDimensionSpec(value[key], `${path}.${key}`, fail);
    if (spec !== undefined) entries.push([key, spec]);
  }
  // `Object.fromEntries` defines own properties: a `__proto__` key stays data.
  return Object.fromEntries(entries);
}

function readNonEmptyString(
  value: JsonValue | undefined,
  path: string,
  add: Add,
): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  add(path, `${citeName(path)} must be a non-empty string`);
  return undefined;
}

/** True when at least one field of the selector is non-empty. */
function constrains(selector: RuleSelector): boolean {
  return (
    SELECTOR_LISTS.some((field) => (selector[field]?.length ?? 0) > 0) ||
    Object.keys(selector.dimensions ?? {}).length > 0
  );
}

function isJsonObject(value: JsonValue | undefined): value is { [k: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
