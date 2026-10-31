import type { JsonValue } from '../canonical.js';
import type { RuleValidationIssue } from '../rule/validate.js';
import { isPlainObject } from '../values.js';

/** What an output holds. An `enum` output holds one of the strings its declaration lists. */
export type OutputType = 'number' | 'boolean' | 'string' | 'enum' | 'list' | 'object';

/**
 * How the contributions of several rules to one output become its value:
 * - `sum`, `max`, `min`: numbers;
 * - `all`, `any`: booleans (logical AND, OR);
 * - `union`: lists;
 * - `highestPriority`: any type; the contribution of the rule with the highest priority.
 */
export type CombineStrategy = 'sum' | 'max' | 'min' | 'highestPriority' | 'union' | 'all' | 'any';

/** The type of an output and how its contributions combine; `values` lists an enum's strings. */
export interface OutputDeclaration {
  type: OutputType;
  combine: CombineStrategy;
  /** Required for an `enum` output, absent otherwise: distinct non-empty strings, at least one. */
  values?: string[];
}

/** The output a rule contributes to when it names none. */
export const DEFAULT_OUTPUT = 'value';

/** The declaration of an output nobody declares: a number, summed. Frozen. */
export const DEFAULT_OUTPUT_DECLARATION: Readonly<OutputDeclaration> = Object.freeze({
  type: 'number',
  combine: 'sum',
});

/** Every output type, in documentation order. Internal: not exported from the package. */
export const OUTPUT_TYPES: readonly OutputType[] = [
  'number',
  'boolean',
  'string',
  'enum',
  'list',
  'object',
];

/** The output types each strategy can combine. */
const COMBINABLE: Readonly<Record<CombineStrategy, readonly OutputType[]>> = {
  sum: ['number'],
  max: ['number'],
  min: ['number'],
  highestPriority: OUTPUT_TYPES,
  union: ['list'],
  all: ['boolean'],
  any: ['boolean'],
};

/** Every combine strategy, in documentation order. Internal: not exported from the package. */
export const COMBINE_STRATEGIES: readonly CombineStrategy[] = [
  'sum',
  'max',
  'min',
  'highestPriority',
  'union',
  'all',
  'any',
];
const KEYS = new Set(['type', 'combine', 'values']);

/**
 * Checks an output declaration without throwing and reports every problem found, each with
 * its path under `path` (`output.combine`, `output.values[2]`):
 * - `type` and `combine` must be known, and `combine` must apply to `type` (`sum`, `max` and
 *   `min` to `number`; `all` and `any` to `boolean`; `union` to `list`; `highestPriority` to
 *   every type);
 * - `values` is required for an `enum` (a non-empty array of distinct non-empty strings) and
 *   refused for any other type;
 * - no other key is allowed.
 */
export function validateOutputDeclaration(
  declaration: unknown,
  path = 'output',
): RuleValidationIssue[] {
  const issues: RuleValidationIssue[] = [];
  const add = (at: string, message: string): void => {
    issues.push({ path: at, message });
  };

  if (!isPlainObject(declaration)) {
    add(path, `${path} must be an object { type, combine, values? }`);
    return issues;
  }
  for (const key of Object.keys(declaration)) {
    if (!KEYS.has(key)) add(`${path}.${key}`, `${path} has an unknown key "${key}"`);
  }

  const { type, combine, values } = declaration;
  const knownType = isOneOf(type, OUTPUT_TYPES);
  if (!knownType) add(`${path}.type`, `${path}.type must be one of ${OUTPUT_TYPES.join(', ')}`);
  if (!isOneOf(combine, COMBINE_STRATEGIES)) {
    add(`${path}.combine`, `${path}.combine must be one of ${COMBINE_STRATEGIES.join(', ')}`);
  } else if (knownType && !COMBINABLE[combine].includes(type)) {
    add(
      `${path}.combine`,
      `${path}.combine "${combine}" cannot combine a ${type} output: ` +
        `it applies to ${COMBINABLE[combine].join(', ')}`,
    );
  }

  if (type === 'enum') {
    checkEnumValues(values, `${path}.values`, add);
  } else if (knownType && values !== undefined) {
    add(`${path}.values`, `${path}.values applies only to an enum output`);
  }
  return issues;
}

function checkEnumValues(
  values: unknown,
  path: string,
  add: (path: string, message: string) => void,
): void {
  if (values === undefined) {
    add(path, `${path} is required for an enum output: list its allowed strings`);
    return;
  }
  if (!Array.isArray(values)) {
    add(path, `${path} must be an array of non-empty strings`);
    return;
  }
  const items: unknown[] = Array.from(values);
  if (items.length === 0) {
    add(path, `${path} must not be empty: an enum output needs at least one value`);
    return;
  }
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (typeof item !== 'string' || item === '') {
      add(`${path}[${i}]`, `${path}[${i}] must be a non-empty string`);
    } else if (seen.has(item)) add(`${path}[${i}]`, `${path}[${i}] repeats "${item}"`);
    else seen.add(item);
  });
}

/**
 * True when `value` has the type `declaration` gives: a finite number, a boolean, a string,
 * one of the listed `values` for an enum, an array for a list (any items), or an object that
 * is neither an array nor `null` for an object.
 */
export function valueMatchesOutputType(value: JsonValue, declaration: OutputDeclaration): boolean {
  switch (declaration.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'enum':
      return typeof value === 'string' && (declaration.values ?? []).includes(value);
    case 'list':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return allowed.some((item) => item === value);
}
