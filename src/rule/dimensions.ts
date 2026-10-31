import { quoteText, SpecError, unreadableMessage } from '../errors.js';
import { hasLoneSurrogate, isPlainObject, loneSurrogateMessage } from '../values.js';

/**
 * What a rule asks of one dimension of the input (D-18):
 * - a value (`'FR'`): the input value must be equal to it;
 * - `{ anyOf, except?, match? }` without `ref`: the input value must equal one of `anyOf`;
 * - with `ref`: the values of `anyOf` and `except` are groups or codes of the referential
 *   `ref`, and an input value matches when it belongs to a group of `anyOf` (or equals a code
 *   of it) and to none of `except`, at the rule's reference date, in three values;
 * - `match`: with several input values, `'any'` (the default) asks one of them to match,
 *   `'all'` asks every one to.
 *
 * A value is a non-empty code, or `<system>:<code>` (the first `:` separates; both parts
 * non-empty: `nace-2.1:62.10`). With `ref`, the values are unqualified: the referential fixes
 * the code system, so `nace-2.1:62.10` and `62.10` cannot be two spellings of one rule.
 * `except` needs `ref`: without a referential a value only equals itself, so `except` could
 * never remove anything.
 *
 * Normal form (one rule, one checksum): `anyOf` and `except` sorted by UTF-16 code unit without
 * duplicates, an empty `except` and `match: 'any'` dropped, and `{ anyOf: [v] }` alone (no `ref`,
 * no `except`, `match` any) written `v`.
 */
export type DimensionSpec =
  string | { ref?: string; anyOf: string[]; except?: string[]; match?: 'any' | 'all' };

/** A `DimensionSpec` as `normalizeRuleDefinition` accepts it: readonly lists. */
export type DimensionSpecInput =
  | string
  | {
      readonly ref?: string;
      readonly anyOf: readonly string[];
      readonly except?: readonly string[];
      readonly match?: 'any' | 'all';
    };

const SPEC_KEYS: readonly string[] = ['ref', 'anyOf', 'except', 'match'];

/** How a message names the expected shape of a dimension. */
const SPEC_SHAPE = 'a value or an object { ref?, anyOf, except?, match? }';

/**
 * Internal: the problem with `value` as a dimension value at `path`, or `undefined` for a
 * valid one: a non-empty string, with a non-empty system and code when it holds a `:`, and no
 * lone UTF-16 surrogate.
 */
export function dimensionValueProblem(value: unknown, path: string): string | undefined {
  if (typeof value !== 'string') return `${path} must be a string`;
  if (value === '') return `${path} must not be empty`;
  if (hasLoneSurrogate(value)) return loneSurrogateMessage(path);
  const colon = value.indexOf(':');
  if (colon === 0) return `${path} has an empty code system before ":"`;
  if (colon === value.length - 1) return `${path} has an empty code after ":"`;
  return undefined;
}

/**
 * Internal: a value split at its first `:` into its system and code; `system` is `undefined`
 * for an unqualified value.
 */
export function splitQualified(value: string): { system: string | undefined; code: string } {
  const colon = value.indexOf(':');
  return colon < 0
    ? { system: undefined, code: value }
    : { system: value.slice(0, colon), code: value.slice(colon + 1) };
}

type Add = (path: string, message: string) => void;

/**
 * Internal to `@run-iq/spec`: shared by `normalizeRuleDefinition`, `validateRuleDefinition`
 * and the exception selectors, so that they cannot disagree.
 *
 * Reads one dimension spec at `path`, without throwing: every problem goes to `add`, and the
 * normal form is returned when there is none. Each property is read once; a property that
 * cannot be read (a getter or a Proxy trap that throws) gives `<path> could not be read: …`.
 */
export function readDimensionSpec(
  value: unknown,
  path: string,
  add: Add,
): DimensionSpec | undefined {
  try {
    return readSpec(value, path, add);
  } catch (error) {
    add(path, unreadableMessage(path, error));
    return undefined;
  }
}

function readSpec(value: unknown, path: string, add: Add): DimensionSpec | undefined {
  if (typeof value === 'string') {
    const problem = dimensionValueProblem(value, path);
    if (problem === undefined) return value;
    add(path, problem);
    return undefined;
  }
  if (!isPlainObject(value)) {
    add(path, `${path} must be ${SPEC_SHAPE}`);
    return undefined;
  }
  let valid = true;
  const fail: Add = (at, message) => {
    valid = false;
    add(at, message);
  };
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (!SPEC_KEYS.includes(key)) {
      fail(`${path}.${key}`, `${path} has an unknown key ${quoteText(key)}`);
      continue;
    }
    fields[key] = value[key];
  }

  const ref = fields.ref;
  if (ref !== undefined && (typeof ref !== 'string' || ref === '')) {
    fail(`${path}.ref`, `${path}.ref must be a non-empty string`);
  } else if (typeof ref === 'string' && hasLoneSurrogate(ref)) {
    fail(`${path}.ref`, loneSurrogateMessage(`${path}.ref`));
  }
  const plain = ref !== undefined;
  const anyOf = readValues(fields.anyOf, `${path}.anyOf`, true, plain, fail);
  const except =
    fields.except === undefined
      ? []
      : readValues(fields.except, `${path}.except`, false, plain, fail);
  const match = fields.match;
  if (match !== undefined && match !== 'any' && match !== 'all') {
    fail(`${path}.match`, `${path}.match must be "any" or "all"`);
  }
  if (except !== undefined && except.length > 0 && ref === undefined) {
    fail(
      `${path}.except`,
      `${path}.except needs ref: without a referential a value only equals itself`,
    );
  }
  if (anyOf !== undefined && except !== undefined) {
    const repeated = except.find((v) => anyOf.includes(v));
    if (repeated !== undefined) {
      fail(`${path}.except`, `${path}.except repeats anyOf value ${quoteText(repeated)}`);
    }
  }
  if (!valid || anyOf === undefined || except === undefined) return undefined;
  return normalForm(
    typeof ref === 'string' ? ref : undefined,
    anyOf,
    except,
    match === 'all' ? 'all' : 'any',
  );
}

/**
 * The values of a list, sorted and deduplicated; `undefined` after reporting a problem. With
 * `plain` (the spec has `ref`), a qualified value is refused.
 */
function readValues(
  value: unknown,
  path: string,
  required: boolean,
  plain: boolean,
  fail: Add,
): string[] | undefined {
  if (!Array.isArray(value)) {
    fail(path, `${path} must be ${required ? 'a non-empty array' : 'an array'} of values`);
    return undefined;
  }
  const items: unknown[] = Array.from(value);
  if (required && items.length === 0) {
    fail(path, `${path} must list at least one value`);
    return undefined;
  }
  let valid = true;
  items.forEach((item, i) => {
    const at = `${path}[${i}]`;
    const problem = dimensionValueProblem(item, at);
    if (problem !== undefined) {
      valid = false;
      fail(at, problem);
    } else if (plain && typeof item === 'string' && item.includes(':')) {
      valid = false;
      fail(at, `${at} must not be qualified: the referential fixes the code system`);
    }
  });
  return valid ? [...new Set(items as string[])].sort() : undefined;
}

function normalForm(
  ref: string | undefined,
  anyOf: string[],
  except: string[],
  match: 'any' | 'all',
): DimensionSpec {
  const [single] = anyOf;
  if (ref === undefined && anyOf.length === 1 && except.length === 0 && match === 'any') {
    if (single !== undefined) return single;
  }
  const spec: Exclude<DimensionSpec, string> = { anyOf };
  if (ref !== undefined) spec.ref = ref;
  if (except.length > 0) spec.except = except;
  if (match === 'all') spec.match = 'all';
  return spec;
}

/**
 * Internal: the normal form of `spec`; throws `SpecError` (`INVALID_RULE`) naming `path` with
 * the first problem of an invalid spec.
 */
export function normalizeDimensionSpec(spec: unknown, path = 'dimension'): DimensionSpec {
  const problems: string[] = [];
  const normal = readDimensionSpec(spec, path, (_at, message) => problems.push(message));
  const [first] = problems;
  if (first !== undefined || normal === undefined) {
    throw new SpecError('INVALID_RULE', first ?? `${path} must be ${SPEC_SHAPE}`);
  }
  return normal;
}

/**
 * Internal: true when two dimension specs have the same normal form. Compares what is written,
 * never a membership (X-10: an exception selector stays static). Throws `SpecError`
 * (`INVALID_RULE`) for an invalid spec.
 */
export function sameDimensionSpec(a: unknown, b: unknown): boolean {
  const left = normalizeDimensionSpec(a);
  const right = normalizeDimensionSpec(b);
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  return (
    left.ref === right.ref &&
    (left.match ?? 'any') === (right.match ?? 'any') &&
    sameList(left.anyOf, right.anyOf) &&
    sameList(left.except ?? [], right.except ?? [])
  );
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Internal: the message refusing a dimension name starting with `$` at `path` (rule
 * `dimensions`, selector `dimensions`, `forEach.dimensions`): every name starting with `$` is
 * the engine's (D-3).
 */
export function reservedDimensionNameMessage(path: string): string {
  return `${path} must not start with "$": dimension names starting with "$" are reserved`;
}
