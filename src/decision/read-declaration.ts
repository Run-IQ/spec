import { citeName, quoteText, unreadableMessage } from '../errors.js';
import { IssueList } from '../issues.js';
import type { RuleValidationIssue } from '../issues.js';
import { isReservedName } from '../reserved.js';
import { reservedDimensionNameMessage } from '../rule/dimensions.js';
import { readCollectionPath } from '../rule/forEach.js';
import {
  hasLoneSurrogate,
  isPlainObject,
  loneSurrogateMessage,
  readList,
  spendValues,
  tooLargeMessage,
} from '../values.js';
import type { CombineStrategy, OutputDeclaration, OutputType } from './output.js';
import { checkRounding, isRoundable, roundingNotApplicable } from './rounding.js';
import type { OutputRounding } from './rounding.js';

// Internal to `@run-iq/spec`: the one reader of output declarations, shared by
// `validateOutputDeclaration`, `normalizeOutputDeclaration` and every function that takes a
// declaration, so that they cannot disagree.

/** Every output type, in documentation order. Internal: not exported from the package. */
export const OUTPUT_TYPES: readonly OutputType[] = [
  'number',
  'boolean',
  'string',
  'enum',
  'list',
  'object',
  'decimal',
  'date',
  'dateTime',
];

/** Every combine strategy, in documentation order. Internal: not exported from the package. */
export const COMBINE_STRATEGIES: readonly CombineStrategy[] = [
  'sum',
  'max',
  'min',
  'highestPriority',
  'union',
  'all',
  'any',
  'count',
];

/** The output types each strategy can combine. */
const COMBINABLE: Readonly<Record<CombineStrategy, readonly OutputType[]>> = {
  sum: ['number', 'decimal'],
  max: ['number', 'decimal', 'enum', 'date', 'dateTime'],
  min: ['number', 'decimal', 'enum', 'date', 'dateTime'],
  highestPriority: OUTPUT_TYPES,
  union: ['list'],
  all: ['boolean'],
  any: ['boolean'],
  count: ['number'],
};

/**
 * Internal: the problem of `combine` on a `type` it cannot combine, the text after the path
 * (`"sum" cannot combine a string output: it applies to number, decimal`), or `undefined`.
 * `type` and `combine` are known.
 */
export function combinationProblem(type: OutputType, combine: CombineStrategy): string | undefined {
  const types = COMBINABLE[combine];
  return types.includes(type)
    ? undefined
    : `${quoteText(combine)} cannot combine ${article(type)} ${type} output: ` +
        `it applies to ${types.join(', ')}`;
}

/** `an` before a type starting with a vowel (`an enum`, `an object`), `a` otherwise. */
export function article(type: string): string {
  return /^[aeiou]/.test(type) ? 'an' : 'a';
}

const KEYS = ['type', 'combine', 'values', 'rounding', 'unit', 'empty', 'per', 'dimension', 'sign'];
const KEY_SET = new Set(KEYS);
/** The members of a declaration, as a message lists them: `{ type, combine, values?, … }`. */
const SHAPE = `{ ${KEYS.map((key, i) => (i < 2 ? key : `${key}?`)).join(', ')} }`;
const SIGNS: readonly NonNullable<OutputDeclaration['sign']>[] = ['nonNegative', 'nonPositive'];

type Add = (path: string, message: string) => void;

/**
 * Internal: the problems of `declaration` at `path` (see `validateOutputDeclaration`) and, when
 * there are none, its normal form (see `normalizeOutputDeclaration`). Each member is read once
 * and counted in the current budget; a value that cannot be read is the single problem
 * `<path> could not be read: <reason>`.
 */
export function readDeclaration(
  declaration: unknown,
  path: string,
): { issues: RuleValidationIssue[]; normal?: OutputDeclaration } {
  const issues = new IssueList();
  try {
    const normal = readMembers(declaration, path, (at, message) => {
      issues.add(at, message);
    });
    return issues.length === 0 && normal !== undefined
      ? { issues: [], normal }
      : { issues: issues.toArray() };
  } catch (error) {
    return { issues: [{ path, message: unreadableMessage(path, error) }] };
  }
}

function readMembers(declaration: unknown, path: string, add: Add): OutputDeclaration | undefined {
  if (!isPlainObject(declaration)) {
    add(path, `${citeName(path)} must be an object ${SHAPE}`);
    return undefined;
  }
  const keys = Object.keys(declaration);
  if (!spendValues(keys.length)) {
    add(path, tooLargeMessage(path));
    return undefined;
  }
  let failed = false;
  const fail: Add = (at, message) => {
    failed = true;
    add(at, message);
  };
  const members = new Map<string, unknown>();
  for (const key of keys) {
    const member = declaration[key];
    // A member whose value is `undefined` is absent, known or not.
    if (member === undefined) continue;
    if (KEY_SET.has(key)) members.set(key, member);
    else fail(`${path}.${key}`, `${citeName(path)} has an unknown key ${quoteText(key)}`);
  }
  const type = members.get('type');
  const combine = members.get('combine');
  if (!isOneOf(type, OUTPUT_TYPES)) {
    fail(`${path}.type`, `${citeName(path)}.type must be one of ${OUTPUT_TYPES.join(', ')}`);
  }
  if (!isOneOf(combine, COMBINE_STRATEGIES)) {
    const at = `${path}.combine`;
    fail(at, `${citeName(at)} must be one of ${COMBINE_STRATEGIES.join(', ')}`);
  } else if (isOneOf(type, OUTPUT_TYPES)) {
    const problem = combinationProblem(type, combine);
    if (problem !== undefined) fail(`${path}.combine`, `${citeName(path)}.combine ${problem}`);
  }
  const read = new Fields(members, path, fail, type, combine);
  const values = read.values();
  const rounding = read.rounding();
  const unit = read.unit();
  const empty = read.empty();
  const sign = read.sign();
  const per = read.per();
  const dimension = read.dimension();
  // Exclusive as written, valid or not: every problem is reported at once.
  if (members.has('per') && members.has('dimension')) {
    fail(path, `${citeName(path)}: per and dimension are exclusive`);
  }
  if (failed || !isOneOf(type, OUTPUT_TYPES) || !isOneOf(combine, COMBINE_STRATEGIES)) {
    return undefined;
  }
  const normal: OutputDeclaration = { type, combine };
  if (values !== undefined) normal.values = values;
  if (rounding !== undefined) normal.rounding = rounding;
  if (unit !== undefined) normal.unit = unit;
  if (empty === true) normal.empty = true;
  if (per !== undefined) normal.per = per;
  if (dimension !== undefined) normal.dimension = dimension;
  if (sign !== undefined) normal.sign = sign;
  return normal;
}

/** The optional members of a declaration, each checked against its `type` and `combine`. */
class Fields {
  constructor(
    private readonly members: ReadonlyMap<string, unknown>,
    private readonly path: string,
    private readonly fail: Add,
    private readonly type: unknown,
    private readonly combine: unknown,
  ) {}

  /** The enum values, copied; refused on any other known type. */
  values(): string[] | undefined {
    const values = this.members.get('values');
    const at = `${this.path}.values`;
    if (this.type === 'enum') return enumValues(values, at, this.fail);
    if (values !== undefined && isOneOf(this.type, OUTPUT_TYPES)) {
      this.fail(at, `${citeName(this.path)}.values applies only to an enum output`);
    }
    return undefined;
  }

  rounding(): OutputRounding | undefined {
    const rounding = this.members.get('rounding');
    const at = `${this.path}.rounding`;
    if (rounding === undefined) return undefined;
    if (isOneOf(this.type, OUTPUT_TYPES) && !isRoundable(this.type)) {
      roundingNotApplicable(at, this.fail);
    } else if (this.combine === 'count') {
      this.fail(at, `${citeName(at)} does not apply to a count: its value is an integer`);
    } else {
      return checkRounding(rounding, at, this.fail)?.normal;
    }
    return undefined;
  }

  unit(): string | undefined {
    const unit = this.members.get('unit');
    const at = `${this.path}.unit`;
    if (unit === undefined) return undefined;
    if (typeof unit !== 'string' || unit === '') {
      this.fail(at, `${citeName(at)} must be a non-empty string`);
    } else if (hasLoneSurrogate(unit)) {
      this.fail(at, loneSurrogateMessage(at));
    } else if (/^\s|\s$/.test(unit)) {
      this.fail(at, `${citeName(at)} must not start or end with white space`);
    } else if (isOneOf(this.type, OUTPUT_TYPES) && !isRoundable(this.type)) {
      this.fail(at, `${citeName(at)} applies only to a number or decimal output`);
    } else {
      return unit;
    }
    return undefined;
  }

  empty(): boolean | undefined {
    const empty = this.members.get('empty');
    const at = `${this.path}.empty`;
    if (empty === undefined) return undefined;
    if (typeof empty !== 'boolean') this.fail(at, `${citeName(at)} must be a boolean`);
    else if (isOneOf(this.combine, COMBINE_STRATEGIES) && this.combine !== 'all') {
      this.fail(at, `${citeName(at)} applies only to an all output`);
    } else return empty;
    return undefined;
  }

  sign(): OutputDeclaration['sign'] {
    const sign = this.members.get('sign');
    const at = `${this.path}.sign`;
    if (sign === undefined) return undefined;
    if (!isOneOf(sign, SIGNS)) {
      this.fail(at, `${citeName(at)} must be one of ${SIGNS.join(', ')}`);
    } else if (isOneOf(this.combine, COMBINE_STRATEGIES) && this.combine !== 'sum') {
      this.fail(at, `${citeName(at)} applies only to a sum output`);
    } else return sign;
    return undefined;
  }

  per(): string | undefined {
    const per = this.members.get('per');
    if (per === undefined) return undefined;
    const levels = readCollectionPath(per, `${this.path}.per`, this.fail);
    return levels !== undefined && typeof per === 'string' ? per : undefined;
  }

  dimension(): string | undefined {
    const dimension = this.members.get('dimension');
    const at = `${this.path}.dimension`;
    if (dimension === undefined) return undefined;
    if (typeof dimension !== 'string') {
      this.fail(at, `${citeName(at)} must be a string: the name of the dimension the output sets`);
    } else if (dimension === '' || dimension === '-') {
      this.fail(at, `${citeName(at)} must not be ${dimension === '' ? 'empty' : '"-"'}`);
    } else if (isReservedName(dimension)) {
      this.fail(at, reservedDimensionNameMessage(at));
    } else if (hasLoneSurrogate(dimension)) {
      this.fail(at, loneSurrogateMessage(at));
    } else if (isOneOf(this.type, OUTPUT_TYPES) && this.type !== 'string' && this.type !== 'enum') {
      this.fail(at, `${citeName(at)} applies only to a string or enum output`);
    } else return dimension;
    return undefined;
  }
}

/** The values of an enum, read once and copied, or `undefined` after reporting why not. */
function enumValues(values: unknown, path: string, fail: Add): string[] | undefined {
  if (values === undefined) {
    fail(path, `${citeName(path)} is required for an enum output: list its allowed strings`);
    return undefined;
  }
  if (!Array.isArray(values)) {
    fail(path, `${citeName(path)} must be an array of non-empty strings`);
    return undefined;
  }
  const items = readList(values, path);
  if (!Array.isArray(items)) {
    fail(items.path, items.message);
    return undefined;
  }
  if (items.length === 0) {
    fail(path, `${citeName(path)} must not be empty: an enum output needs at least one value`);
    return undefined;
  }
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const at = `${path}[${i}]`;
    if (typeof item !== 'string' || item === '') {
      fail(at, `${citeName(at)} must be a non-empty string`);
    } else if (hasLoneSurrogate(item)) {
      fail(at, loneSurrogateMessage(at));
    } else if (seen.has(item)) {
      fail(at, `${citeName(at)} repeats ${quoteText(item)}`);
    } else {
      seen.add(item);
    }
  });
  return seen.size === items.length ? [...seen] : undefined;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return allowed.some((item) => item === value);
}
