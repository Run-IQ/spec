import type { JsonValue } from '../canonical.js';
import { unreadableMessage } from '../errors.js';
import { isReservedName } from '../reserved.js';
import { IssueList } from '../issues.js';
import type { RuleValidationIssue } from '../issues.js';
import { isPlainObject } from '../values.js';
import { isCanonicalDecimal } from './decimal.js';

/**
 * What an output holds. An `enum` output holds one of the strings its declaration lists. A
 * `decimal` output holds an exact decimal as a canonical string (`isCanonicalDecimal`:
 * `"1234.5"`), never a JavaScript number; a `number` output holds a binary floating-point
 * number, so an amount is declared `decimal`.
 */
export type OutputType = 'number' | 'boolean' | 'string' | 'enum' | 'list' | 'object' | 'decimal';

/**
 * How the contributions of several rules to one output become its value:
 * - `sum`, `max`, `min`: numbers and decimals;
 * - `all`, `any`: booleans (logical AND, OR);
 * - `union`: lists;
 * - `highestPriority`: any type; the contribution of the rule with the highest priority.
 */
export type CombineStrategy = 'sum' | 'max' | 'min' | 'highestPriority' | 'union' | 'all' | 'any';

/**
 * How a value is rounded to `scale` decimal places:
 * - `halfUp`, `halfDown`, `halfEven`: to the nearest, a tie going away from zero, toward zero,
 *   or to the even neighbour;
 * - `up`, `down`: away from zero, toward zero;
 * - `ceiling`, `floor`: toward positive infinity, toward negative infinity.
 */
export type RoundingMode = 'halfUp' | 'halfDown' | 'halfEven' | 'up' | 'down' | 'ceiling' | 'floor';

/**
 * The rounding an output declares: `scale` decimal places (an integer from 0 to 20) in `mode`.
 * `at` says what is rounded: the combined value (`output`, the default) or each contribution
 * before they combine (`contribution`, as some schedules round line by line).
 */
export interface OutputRounding {
  scale: number;
  mode: RoundingMode;
  at?: 'output' | 'contribution';
}

/**
 * The type of an output and how its contributions combine; `values` lists an enum's strings,
 * `rounding` rounds a number or decimal output.
 */
export interface OutputDeclaration {
  type: OutputType;
  combine: CombineStrategy;
  /** Required for an `enum` output, absent otherwise: distinct non-empty strings, at least one. */
  values?: string[];
  /** Allowed on a `number` or `decimal` output only. */
  rounding?: OutputRounding;
}

/** The output a rule contributes to when it names none. */
export const DEFAULT_OUTPUT = 'value';

/**
 * The reserved variable through which a rule reads the outputs computed before it:
 * `$outputs.x` is output `x`, in a condition as in a model. Input facts cannot use this name.
 */
export const OUTPUTS_VARIABLE = '$outputs';

/**
 * Internal: true for an output name that starts with `$`. Such names are reserved (ruling
 * R36, `isReservedName`): `$outputs` and any future variable cannot collide with an output.
 */
export function isReservedOutputName(name: string): boolean {
  return isReservedName(name);
}

/** Internal: the message refusing the reserved output name at `path`. */
export function reservedOutputNameMessage(path: string): string {
  return `${path} must not start with "$": output names starting with "$" are reserved`;
}

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
  'decimal',
];

/** The output types each strategy can combine. */
const COMBINABLE: Readonly<Record<CombineStrategy, readonly OutputType[]>> = {
  sum: ['number', 'decimal'],
  max: ['number', 'decimal'],
  min: ['number', 'decimal'],
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
const KEYS = new Set(['type', 'combine', 'values', 'rounding']);

/** Every rounding mode, in documentation order. */
const ROUNDING_MODES: readonly RoundingMode[] = [
  'halfUp',
  'halfDown',
  'halfEven',
  'up',
  'down',
  'ceiling',
  'floor',
];
const ROUNDING_TARGETS: readonly NonNullable<OutputRounding['at']>[] = ['output', 'contribution'];
const ROUNDING_KEYS = new Set(['scale', 'mode', 'at']);
/** The output types a rounding applies to. */
const ROUNDABLE: readonly OutputType[] = ['number', 'decimal'];
/** The largest rounding scale. */
const MAX_SCALE = 20;

/**
 * Checks an output declaration without throwing and reports every problem found, each with
 * its path under `path` (`output.combine`, `output.values[2]`):
 * - `type` and `combine` must be known, and `combine` must apply to `type` (`sum`, `max` and
 *   `min` to `number` and `decimal`; `all` and `any` to `boolean`; `union` to `list`;
 *   `highestPriority` to every type);
 * - `values` is required for an `enum` (a non-empty array of distinct non-empty strings) and
 *   refused for any other type;
 * - `rounding` is allowed on a `number` or `decimal` output only, and is
 *   `{ scale, mode, at? }`: `scale` an integer from 0 to 20, `mode` a `RoundingMode`, `at`
 *   `output` or `contribution`; no other key;
 * - no other key is allowed.
 *
 * A value that cannot be read (a getter or a Proxy trap that throws, at any depth) gives the
 * single issue `<path> could not be read: <reason>` at `path` (`<path> is too deeply nested`
 * when reading it overflows the call stack).
 *
 * Lists at most 100 problems, in the order found, then one last issue `further problems not
 * listed (limit 100)`; a path or message longer than 1024 code units is cut there, then `…`
 * (`IssueList`, shared by every validator of the package).
 */
export function validateOutputDeclaration(
  declaration: unknown,
  path = 'output',
): RuleValidationIssue[] {
  try {
    return declarationIssues(declaration, path);
  } catch (error) {
    return [{ path, message: unreadableMessage(path, error) }];
  }
}

function declarationIssues(declaration: unknown, path: string): RuleValidationIssue[] {
  const issues = new IssueList();
  const add = (at: string, message: string): void => {
    issues.add(at, message);
  };

  if (!isPlainObject(declaration)) {
    add(path, `${path} must be an object { type, combine, values?, rounding? }`);
    return issues.toArray();
  }
  for (const key of Object.keys(declaration)) {
    if (!KEYS.has(key)) add(`${path}.${key}`, `${path} has an unknown key "${key}"`);
  }

  const { type, combine, values, rounding } = declaration;
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

  if (rounding !== undefined) {
    if (knownType && !ROUNDABLE.includes(type)) roundingNotApplicable(`${path}.rounding`, add);
    else checkRounding(rounding, `${path}.rounding`, add);
  }
  return issues.toArray();
}

/**
 * Internal: checks a rounding `{ scale, mode, at? }` at `path`, for an output declaration and
 * for the outputs of a proof alike. An unknown key is refused whatever its value; a known key
 * whose value is `undefined` counts as absent.
 */
export function checkRounding(
  rounding: unknown,
  path: string,
  add: (path: string, message: string) => void,
): void {
  if (!isPlainObject(rounding)) {
    add(path, `${path} must be an object { scale, mode, at? }`);
    return;
  }
  const members = new Map<string, unknown>(Object.entries(rounding));
  for (const key of members.keys()) {
    if (!ROUNDING_KEYS.has(key)) {
      add(`${path}.${key}`, `${path} has an unknown key "${key}"`);
    }
  }
  const scale = members.get('scale');
  const mode = members.get('mode');
  const at = members.get('at');
  if (scale === undefined) add(`${path}.scale`, `${path}.scale is required`);
  else if (!isScale(scale)) {
    add(`${path}.scale`, `${path}.scale must be an integer from 0 to ${MAX_SCALE}`);
  }
  if (mode === undefined) add(`${path}.mode`, `${path}.mode is required`);
  else if (!isOneOf(mode, ROUNDING_MODES)) {
    add(`${path}.mode`, `${path}.mode must be one of ${ROUNDING_MODES.join(', ')}`);
  }
  if (at !== undefined && !isOneOf(at, ROUNDING_TARGETS)) {
    add(`${path}.at`, `${path}.at must be one of ${ROUNDING_TARGETS.join(', ')}`);
  }
}

/** Internal: reports a rounding on an output whose type cannot be rounded. */
export function roundingNotApplicable(
  path: string,
  add: (path: string, message: string) => void,
): void {
  add(path, `${path} applies only to a number or decimal output`);
}

/** Internal: true for an output type a rounding applies to. */
export function isRoundable(type: unknown): boolean {
  return ROUNDABLE.some((item) => item === type);
}

function isScale(value: unknown): boolean {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SCALE
  );
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
 * one of the listed `values` for an enum, an array for a list (any items), an object that is
 * neither an array nor `null` for an object, or a canonical decimal string for a decimal
 * (`isCanonicalDecimal`: `"12.5"`, not `"12.50"`, `"-0"`, `"1e3"` nor the number `12.5`).
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
    case 'decimal':
      return typeof value === 'string' && isCanonicalDecimal(value);
  }
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return allowed.some((item) => item === value);
}
