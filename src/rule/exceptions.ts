import type { JsonValue } from '../canonical.js';
import { DEFAULT_OUTPUT } from '../decision/output.js';
import type { RuleValidationIssue } from './validate.js';

/**
 * Which rules an exception targets. Fields combine by AND; the values of one field by OR
 * (`{ tags: ['a', 'b'], models: ['M'] }`: model `M` and tag `a` or `b`). `dimensions` requires
 * every listed key to be equal on the rule; `outputs` compares the rule's output, the default
 * output (`value`) when it names none. An empty field puts no constraint, like an absent one;
 * a selector must constrain at least one field.
 */
export interface RuleSelector {
  ids?: string[];
  tags?: string[];
  dimensions?: Record<string, string>;
  outputs?: string[];
  models?: string[];
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
 * True when the rule is one `selector` targets (see `RuleSelector`). A selector that
 * constrains no field matches nothing; validation refuses it anyway.
 */
export function matchesSelector(
  rule: {
    id: string;
    tags: readonly string[];
    dimensions: Readonly<Record<string, string>>;
    output?: string;
    model: string;
  },
  selector: RuleSelector,
): boolean {
  if (!constrains(selector)) return false;
  const { ids, tags, dimensions, outputs, models } = selector;
  if (ids?.length && !ids.includes(rule.id)) return false;
  if (tags?.length && !tags.some((tag) => rule.tags.includes(tag))) return false;
  if (outputs?.length && !outputs.includes(rule.output ?? DEFAULT_OUTPUT)) return false;
  if (models?.length && !models.includes(rule.model)) return false;
  if (dimensions) {
    for (const [key, value] of Object.entries(dimensions)) {
      if (!Object.hasOwn(rule.dimensions, key) || rule.dimensions[key] !== value) return false;
    }
  }
  return true;
}

/** Every exception kind. Internal: not exported from the package. */
export const KINDS = ['inhibit', 'substitute', 'shortCircuit'] as const;
const KEYS_BY_KIND: Readonly<Record<RuleException['kind'], readonly string[]>> = {
  inhibit: ['kind', 'targets'],
  substitute: ['kind', 'targets', 'params'],
  shortCircuit: ['kind', 'output', 'value', 'reason'],
};
const SELECTOR_LISTS = ['ids', 'tags', 'outputs', 'models'] as const;
const SELECTOR_KEYS: readonly string[] = ['ids', 'tags', 'dimensions', 'outputs', 'models'];

/**
 * Internal to `@run-iq/spec` (not exported from the package): shared by
 * `normalizeRuleDefinition` and `validateRuleDefinition` so that they cannot disagree.
 *
 * Reads the `exceptions` field of a rule, already converted to JSON, without throwing.
 * Returns every problem found, each with its path under `path`, and, when there is none, the
 * normalized list: each selector's `ids`, `tags`, `outputs` and `models` sorted and
 * deduplicated, empty selector fields dropped. The order of the list itself is kept: it has a
 * meaning. `null` gives an empty list (absent).
 */
export function readRuleExceptions(
  value: JsonValue,
  path = 'exceptions',
): { exceptions: RuleException[]; issues: RuleValidationIssue[] } {
  const issues: RuleValidationIssue[] = [];
  const add = (at: string, message: string): void => {
    issues.push({ path: at, message });
  };
  if (value === null) return { exceptions: [], issues };
  if (!Array.isArray(value)) {
    add(path, `${path} must be an array of exceptions`);
    return { exceptions: [], issues };
  }
  const exceptions: RuleException[] = [];
  value.forEach((item, i) => {
    const exception = readException(item, `${path}[${i}]`, add);
    if (exception) exceptions.push(exception);
  });
  return { exceptions: issues.length === 0 ? exceptions : [], issues };
}

/**
 * Internal to `@run-iq/spec` (not exported from the package): shared by
 * `normalizeRuleDefinition` and `validateRuleDefinition` so that they cannot disagree.
 *
 * The constraints of `EXCEPTION_MODEL` on a rule, checked on its raw fields: no `output`
 * (`null` counts as absent) and a non-empty `exceptions` list (`null` and `[]` count as
 * absent). Any other model gives no issue.
 */
export function exceptionModelIssues(rule: {
  readonly model?: unknown;
  readonly output?: unknown;
  readonly exceptions?: unknown;
}): RuleValidationIssue[] {
  if (rule.model !== EXCEPTION_MODEL) return [];
  const issues: RuleValidationIssue[] = [];
  if (rule.output != null) {
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

type Add = (path: string, message: string) => void;

function readException(item: JsonValue, path: string, add: Add): RuleException | undefined {
  if (!isJsonObject(item)) {
    add(path, `${path} must be an object with a kind`);
    return undefined;
  }
  const kind = KINDS.find((k) => k === item.kind);
  if (kind === undefined) {
    add(`${path}.kind`, `${path}.kind must be one of ${KINDS.join(', ')}`);
    return undefined;
  }
  let valid = true;
  const fail: Add = (at, message) => {
    valid = false;
    add(at, message);
  };
  for (const key of Object.keys(item)) {
    if (!KEYS_BY_KIND[kind].includes(key)) {
      fail(`${path}.${key}`, `${path} has an unknown key "${key}" for kind ${kind}`);
    }
  }

  let exception: RuleException | undefined;
  if (kind === 'shortCircuit') {
    const output = readNonEmptyString(item.output, `${path}.output`, fail);
    const value = item.value;
    if (value === undefined) fail(`${path}.value`, `${path}.value is required (null is a value)`);
    const reason =
      item.reason === undefined
        ? undefined
        : readNonEmptyString(item.reason, `${path}.reason`, fail);
    if (output !== undefined && value !== undefined) {
      exception = reason === undefined ? { kind, output, value } : { kind, output, value, reason };
    }
  } else {
    const targets = readSelector(item.targets, `${path}.targets`, fail);
    if (kind === 'inhibit') {
      if (targets) exception = { kind, targets };
    } else if (!isJsonObject(item.params)) {
      fail(`${path}.params`, `${path}.params must be an object of parameters to merge`);
    } else if (targets) {
      exception = { kind, targets, params: item.params };
    }
  }
  return valid ? exception : undefined;
}

function readSelector(
  value: JsonValue | undefined,
  path: string,
  add: Add,
): RuleSelector | undefined {
  if (value === undefined || !isJsonObject(value)) {
    add(path, `${path} must be a selector { ids?, tags?, dimensions?, outputs?, models? }`);
    return undefined;
  }
  let valid = true;
  const fail: Add = (at, message) => {
    valid = false;
    add(at, message);
  };
  for (const key of Object.keys(value)) {
    if (!SELECTOR_KEYS.includes(key)) fail(`${path}.${key}`, `${path} has an unknown key "${key}"`);
  }

  const selector: RuleSelector = {};
  for (const field of SELECTOR_LISTS) {
    const list = readList(value[field], `${path}.${field}`, field !== 'tags', fail);
    if (list && list.length > 0) selector[field] = [...new Set(list)].sort();
  }
  const dimensions = readDimensions(value.dimensions, `${path}.dimensions`, fail);
  if (dimensions && Object.keys(dimensions).length > 0) selector.dimensions = dimensions;

  if (valid && !constrains(selector)) {
    fail(
      path,
      `${path} must constrain at least one of ${SELECTOR_KEYS.join(', ')}: ` +
        'an empty selector would target every rule',
    );
  }
  return valid ? selector : undefined;
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
    fail(path, `${path} must be an array of ${nonEmpty ? 'non-empty strings' : 'strings'}`);
    return undefined;
  }
  const strings: string[] = [];
  value.forEach((item, i) => {
    if (typeof item !== 'string' || (nonEmpty && item === '')) {
      fail(`${path}[${i}]`, `${path}[${i}] must be ${expected}`);
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
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    fail(path, `${path} must be an object of strings`);
    return undefined;
  }
  const entries: [string, string][] = [];
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (typeof v === 'string') entries.push([key, v]);
    else fail(`${path}.${key}`, `${path}.${key} must be a string`);
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
  add(path, `${path} must be a non-empty string`);
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
