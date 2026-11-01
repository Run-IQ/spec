import { canonicalize } from '../canonical.js';
import type { JsonValue } from '../canonical.js';
import { citeName, newSpecError } from '../errors.js';
import { pathArgumentIssue } from '../issues.js';
import type { RuleValidationIssue } from '../issues.js';
import { isReservedName } from '../reserved.js';
import { isCivilDate, isInstant } from '../time/civil.js';
import { ownCopy, withValueBudget } from '../values.js';
import { isCanonicalDecimal } from './decimal.js';
import { readDeclaration } from './read-declaration.js';
import type { OutputRounding } from './rounding.js';
import type { OutputStatus } from './status.js';

/**
 * What an output holds. An `enum` output holds one of the strings its declaration lists, ranked
 * in their order. A `decimal` output holds an exact decimal as a canonical string
 * (`isCanonicalDecimal`: `"1234.5"`), never a JavaScript number; a `number` output holds a
 * binary floating-point number, so an amount is declared `decimal`. A `date` output holds a civil
 * date (`isCivilDate`: `"2028-02-29"`), a `dateTime` output an instant in its canonical form
 * (`isInstant`: `"2026-01-01T00:00:00.000Z"`).
 */
export type OutputType =
  'number' | 'boolean' | 'string' | 'enum' | 'list' | 'object' | 'decimal' | 'date' | 'dateTime';

/**
 * How the contributions of several rules to one output become its value:
 * - `sum`: numbers and decimals;
 * - `max`, `min`: numbers, decimals, enums (by rank), dates and instants (in time);
 * - `count`: a number, the count of the contributions that are `true` (each contribution is a
 *   boolean, `contributionMatchesDeclaration`);
 * - `all`, `any`: booleans (logical AND, OR);
 * - `union`: lists;
 * - `highestPriority`: any type; the contribution of the rule with the highest priority.
 */
export type CombineStrategy =
  'sum' | 'max' | 'min' | 'highestPriority' | 'union' | 'all' | 'any' | 'count';

/**
 * The type of an output and how its contributions combine. Each optional field has one written
 * form: `normalizeOutputDeclaration` gives it, `sameDeclaration` compares by it.
 */
export interface OutputDeclaration {
  type: OutputType;
  combine: CombineStrategy;
  /** Required for an `enum` output, absent otherwise: distinct non-empty strings, at least one. */
  values?: string[];
  /** Allowed on a `number` or `decimal` output only, never on a `count`. */
  rounding?: OutputRounding;
  /**
   * The unit of a `number` or `decimal` output (`"XOF"`, `"m²"`): a non-empty string without
   * white space around it. Two declarations that differ by unit are not the same (D-9).
   */
  unit?: string;
  /**
   * Allowed on an `all` output only: `true` makes an `all` that no rule reached `true` and
   * determined; absent (the normal form of `false`), it is undetermined (`emptyOutput`).
   */
  empty?: boolean;
  /**
   * One value per element of a collection: a pointer into the input data with `*` segments, as
   * `forEach.path` (the same refusals). Exclusive with `dimension`.
   */
  per?: string;
  /**
   * The dimension this `string` or `enum` output sets for the rules after it (D-19): a
   * dimension name (not empty, not `-`, not starting with `$`). Exclusive with `per`.
   */
  dimension?: string;
  /**
   * Allowed on a `sum` only: every contribution, so the sum, is at least 0 (`nonNegative`) or at
   * most 0 (`nonPositive`). Absent: no constraint.
   */
  sign?: 'nonNegative' | 'nonPositive';
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
  return `${citeName(path)} must not start with "$": output names starting with "$" are reserved`;
}

export { COMBINE_STRATEGIES, OUTPUT_TYPES } from './read-declaration.js';

/** The declaration of an output nobody declares: a number, summed. Frozen. */
export const DEFAULT_OUTPUT_DECLARATION: Readonly<OutputDeclaration> = Object.freeze({
  type: 'number',
  combine: 'sum',
});

/**
 * Checks an output declaration without throwing and reports every problem found, each with
 * its path under `path` (`output.combine`, `output.values[2]`):
 * - `type` and `combine` must be known, and `combine` must apply to `type` (`sum` to `number`
 *   and `decimal`; `max` and `min` to `number`, `decimal`, `enum`, `date` and `dateTime`;
 *   `count` to `number`; `all` and `any` to `boolean`; `union` to `list`; `highestPriority` to
 *   every type);
 * - `values` is required for an `enum` (a non-empty array of distinct non-empty strings) and
 *   refused for any other type;
 * - `rounding` is allowed on a `number` or `decimal` output only, never on a `count`, and is
 *   `{ scale or increment, mode, at? }` (`OutputRounding`); no other key;
 * - `unit` (a `number` or `decimal` output), `empty` (an `all`), `sign` (a `sum`), `per` and
 *   `dimension` (a `string` or `enum`) as `OutputDeclaration` says; `per` and `dimension` are
 *   exclusive;
 * - no other key is allowed. A member whose value is `undefined` is absent, known or not.
 *
 * A text the declaration holds (an enum value, `unit`, `per`, `dimension`) with a lone UTF-16
 * surrogate is refused: it has no canonical form.
 *
 * A value that cannot be read (a getter or a Proxy trap that throws, at any depth) gives the
 * single issue `<path> could not be read: <reason>` at `path`.
 *
 * Lists at most 100 problems, in the order found, then one last issue `further problems not
 * listed (limit 100)`; a path or message longer than 1024 code units is cut there, then `…`
 * (`IssueList`, shared by every validator of the package).
 */
export function validateOutputDeclaration(
  declaration: unknown,
  path = 'output',
): RuleValidationIssue[] {
  const at: unknown = path;
  if (typeof at !== 'string') return [pathArgumentIssue(at)];
  return withValueBudget(() => readDeclaration(declaration, path).issues);
}

/**
 * The normal form of an output declaration: a plain copy, its members read once, where
 * `empty: false`, `rounding.at: 'output'` and `undefined` members are absent and an increment
 * that is a power of ten from 1 to 10^-20 is written as its `scale` (`OutputRounding`). Every
 * other member is kept as written (the order of enum `values` ranks them). Two declarations
 * with the same meaning have the same normal form, so the same canonical text and checksum.
 *
 * Throws `SpecError` (`INVALID_RULE`, `invalid output declaration: <first problem>`, the
 * problem's path as `path`) for a declaration `validateOutputDeclaration` refuses.
 */
export function normalizeOutputDeclaration(declaration: OutputDeclaration): OutputDeclaration {
  return withValueBudget(() => validDeclaration(declaration));
}

/**
 * True when two declarations have the same normal form (`normalizeOutputDeclaration`): rules
 * that feed one output must agree on it, unit included (D-9).
 *
 * Throws `SpecError` (`INVALID_RULE`) for a declaration `validateOutputDeclaration` refuses.
 */
export function sameDeclaration(a: OutputDeclaration, b: OutputDeclaration): boolean {
  return withValueBudget(() => {
    const first = validDeclaration(a);
    const second = validDeclaration(b);
    return ownCopy(() => canonicalize(first) === canonicalize(second));
  });
}

/**
 * True when `value` is a value of the output `declaration` declares: a finite number, a
 * boolean, a string, one of the listed `values` for an enum, an array for a list (any items),
 * an object that is neither an array nor `null` for an object, a canonical decimal string for a
 * decimal (`isCanonicalDecimal`: `"12.5"`, not `"12.50"`, `"-0"`, `"1e3"` nor the number
 * `12.5`), a civil date for a date (`isCivilDate`), a canonical instant for a dateTime
 * (`isInstant`). The combined value of a `count` is a non-negative safe integer; a declared
 * `sign` bounds a number or decimal at 0. A value that cannot be inspected (a revoked Proxy)
 * matches no type.
 *
 * Throws `SpecError` (`INVALID_RULE`) for a declaration `validateOutputDeclaration` refuses.
 */
export function valueMatchesOutputType(value: JsonValue, declaration: OutputDeclaration): boolean {
  return matchesValue(
    value,
    withValueBudget(() => validDeclaration(declaration)),
  );
}

/**
 * True when `value` may be one rule's contribution to the output `declaration` declares: a
 * boolean for a `count` (the contributions that are `true` are counted), otherwise a value of
 * the output (`valueMatchesOutputType`), its `sign` included.
 *
 * Throws `SpecError` (`INVALID_RULE`) for a declaration `validateOutputDeclaration` refuses.
 */
export function contributionMatchesDeclaration(
  value: JsonValue,
  declaration: OutputDeclaration,
): boolean {
  const normal = withValueBudget(() => validDeclaration(declaration));
  return normal.combine === 'count' ? typeof value === 'boolean' : matchesValue(value, normal);
}

/**
 * The output no contribution reached (gap-hunt X-4): the identity of its strategy, determined
 * (`sum` 0, `"0"` for a decimal; `count` 0; `union` `[]`; `any` `false`); for `all`, `true`
 * and determined when it declares `empty: true`, otherwise no value and `undetermined` (a
 * check that examined nothing is not passed); for `max`, `min` and `highestPriority`, no value
 * (the `value` member is absent, never `null`) and determined. A fresh object each call.
 *
 * Throws `SpecError` (`INVALID_RULE`) for a declaration `validateOutputDeclaration` refuses.
 */
export function emptyOutput(declaration: OutputDeclaration): {
  value?: JsonValue;
  status: OutputStatus;
} {
  const { type, combine, empty } = withValueBudget(() => validDeclaration(declaration));
  switch (combine) {
    case 'sum':
      return { value: type === 'decimal' ? '0' : 0, status: 'determined' };
    case 'count':
      return { value: 0, status: 'determined' };
    case 'union':
      return { value: [], status: 'determined' };
    case 'any':
      return { value: false, status: 'determined' };
    case 'all':
      return empty === true ? { value: true, status: 'determined' } : { status: 'undetermined' };
    case 'max':
    case 'min':
    case 'highestPriority':
      return { status: 'determined' };
  }
}

/**
 * Internal: the normal form of `declaration`, read once and counted in the current budget, or
 * throws `SpecError` (`INVALID_RULE`, `invalid output declaration: <first problem>`, the
 * problem's path as `path`).
 */
export function validDeclaration(declaration: unknown): OutputDeclaration {
  const { issues, normal } = readDeclaration(declaration, 'output');
  const [first] = issues;
  if (first !== undefined || normal === undefined) {
    const message = first?.message ?? 'unreadable';
    throw newSpecError('INVALID_RULE', `invalid output declaration: ${message}`, first?.path);
  }
  return normal;
}

/** Internal: true when `value` is a value of the valid, normal `declaration`. */
export function matchesValue(value: unknown, declaration: OutputDeclaration): boolean {
  const { type, combine, values = [], sign } = declaration;
  if (combine === 'count') {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && numberHasSign(value, sign);
    case 'decimal':
      return typeof value === 'string' && isCanonicalDecimal(value) && decimalHasSign(value, sign);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'enum':
      return typeof value === 'string' && values.includes(value);
    case 'list':
      return isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !isArray(value);
    case 'date':
      return isCivilDate(value);
    case 'dateTime':
      return isInstant(value);
  }
}

/** True when the number `value` respects `sign` (0 and -0 respect both). */
function numberHasSign(value: number, sign: OutputDeclaration['sign']): boolean {
  if (sign === 'nonNegative') return value >= 0;
  return sign === 'nonPositive' ? value <= 0 : true;
}

/** True when the canonical decimal `value` respects `sign` (`"0"` respects both). */
function decimalHasSign(value: string, sign: OutputDeclaration['sign']): boolean {
  if (sign === 'nonNegative') return !value.startsWith('-');
  return sign === 'nonPositive' ? value === '0' || value.startsWith('-') : true;
}

/** `Array.isArray`, false when it throws (a revoked Proxy is no JSON value). */
function isArray(value: unknown): boolean {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}
