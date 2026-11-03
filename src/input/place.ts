import { quoteText } from '../errors.js';
import { isSubject } from '../path/subject.js';
import { dimensionValueProblem, isUnnamable } from '../rule/dimensions.js';
import { citedNameProblem } from '../rule/ruleSet.js';
import { isCivilDate, isInstant } from '../time/civil.js';
import { MAX_INPUT_LEAF_TEXT, MAX_JSON_DEPTH, MAX_JSON_VALUES } from '../values.js';
import { assertionKeyProblem, DATE_FORMS } from './assertions.js';
import type { JsonScalar } from './leaves.js';
import { ASSERTION_METHODS, ASSERTION_STATUSES } from './types.js';
import {
  arrayIncludes,
  arrayJoin,
  arrayReduce,
  arraySlice,
  objectHasOwn,
  objectValues,
  regExpTest,
  stringStartsWith,
} from '../intrinsics.js';

/**
 * Internal to `@run-iq/spec`: where a leaf of the input tree (D-15) can sit in a valid input,
 * and what it may hold there, so that `inputLeafHash` refuses every leaf whose place, kind,
 * value or length no valid input has. A leaf is judged alone: what it would need of the other
 * leaves (siblings, sort order, the share of the budgets they take) is not checked beyond the
 * least each part of an input always holds.
 */

export type LeafKind = 'value' | 'array' | 'object';

/** What a leaf at one place of an input may be. */
export interface LeafPlace {
  /** The kinds a leaf there can have. */
  readonly kinds: readonly LeafKind[];
  /** The fewest elements of a list there (a list of dimension values holds at least two). */
  readonly minLength: number;
  /** The most elements of a list there (`MAX_JSON_VALUES` less the values above it). */
  readonly maxLength: number;
  /** The longest pointer a leaf there can have (`MAX_INPUT_LEAF_TEXT` less the other parts). */
  readonly maxPointer: number;
  /** What is wrong with a scalar there (as `/value`), or `undefined`. */
  readonly value: (value: JsonScalar) => string | undefined;
}

/** The members of `meta`, and the leaf each always gives at least (its own pointer). */
const META_PARTS: Readonly<Record<string, string>> = {
  tenantId: '/meta/tenantId',
  dates: '/meta/dates',
  tags: '/meta/tags',
  dimensions: '/meta/dimensions',
  context: '/meta/context',
  assertions: '/meta/assertions',
};
/** The shortest pointers of all the leaves of a valid input: `/data` and one per meta part. */
const LEAST_TEXT = arrayReduce(objectValues(META_PARTS), (sum, pointer) => sum + pointer.length, 5);
/** The values a valid input always holds: `data`, `meta` and the six members of `meta`. */
const LEAST_VALUES = 8;

const INDEX = /^(0|[1-9][0-9]*)$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FIELDS = [
  'by',
  'method',
  'at',
  'status',
  'basis',
  'evidenceDigest',
  'confidence',
  'complete',
];
const SOURCE_FIELDS = ['proofDigest', 'output', 'subject'];

const any = (): undefined => undefined;
const text = (value: JsonScalar): string | undefined =>
  typeof value === 'string' && value !== '' ? undefined : '/value must be a non-empty string';
const date = (value: JsonScalar): string | undefined =>
  isCivilDate(value) || isInstant(value) ? undefined : `/value must be ${DATE_FORMS}`;
const oneOf =
  (choices: readonly string[]) =>
  (value: JsonScalar): string | undefined =>
    typeof value === 'string' && arrayIncludes(choices, value)
      ? undefined
      : `/value must be one of ${arrayJoin(choices, ', ')}`;
const sha256 = (value: JsonScalar): string | undefined =>
  typeof value === 'string' && regExpTest(SHA256_HEX, value)
    ? undefined
    : '/value must be a lowercase sha256 hex string';

/** What each field of an assertion may hold. */
const FIELD_VALUES: Readonly<Record<string, (value: JsonScalar) => string | undefined>> = {
  by: text,
  method: oneOf(ASSERTION_METHODS),
  at: date,
  status: oneOf(ASSERTION_STATUSES),
  basis: text,
  evidenceDigest: sha256,
  confidence: (value) =>
    typeof value === 'number' && value >= 0 && value <= 1
      ? undefined
      : '/value must be a number from 0 to 1',
  complete: (value) => (value === false ? undefined : '/value must be false'),
  proofDigest: sha256,
  output: (value) =>
    typeof value === 'string' && value !== ''
      ? citedNameProblem(value, '/value', 'output')
      : '/value must be a non-empty string',
  subject: (value) =>
    isSubject(value)
      ? undefined
      : '/value must be a subject: a JSON pointer whose reserved segments are well formed',
};

/**
 * The place of the leaf whose pointer has `segments`, or why no valid input has a leaf there:
 * - `/data`: an empty object; `/data/<key>/…` below it, any kind, except under a key starting
 *   with `$` (reserved, D-3), at most `MAX_JSON_DEPTH` (1000) levels below `/data`, a list at
 *   that very depth empty;
 * - `/meta` is never a leaf (it always holds its six members), nor anything but them;
 * - `/meta/tenantId`: a non-empty string;
 * - `/meta/dates`: an empty object; `/meta/dates/<name>`: a civil date or an instant, `name`
 *   neither empty, `-` nor starting with `$`;
 * - `/meta/tags`: a list; `/meta/tags/<index>`: a non-empty string;
 * - `/meta/dimensions`: an empty object; `/meta/dimensions/<name>` (named as a date is): a
 *   dimension value, or a list of at least two; `/meta/dimensions/<name>/<index>`: a dimension
 *   value;
 * - `/meta/context`: an empty object; anything below it, any kind, as deep as below `/data`;
 * - `/meta/assertions`: an empty object; `/meta/assertions/<key>` is never a leaf (an assertion
 *   holds `by`, `method`, `at` and `status`), `key` as `assertionKeyProblem` accepts it;
 *   `/meta/assertions/<key>/<field>`: a value of that field (`source` is never a leaf: it holds
 *   `proofDigest` and `output`); `/meta/assertions/<key>/source/<field>` likewise;
 * - nothing is ever below a scalar of `meta`; an index is written `0|[1-9][0-9]*`.
 */
export function leafPlace(segments: readonly string[]): LeafPlace | string {
  const [head, part, name, field, sub] = segments;
  if (head === 'data') {
    if (part === undefined) return place(['object'], '/data');
    if (stringStartsWith(part, '$')) return 'a root key of /data starting with "$" is reserved';
    return freePlace('/data', segments.length - 1);
  }
  if (head !== 'meta') return 'it is not below /data or /meta';
  if (part === undefined) return '/meta always holds its six members, so it is never a leaf';
  const partPointer = META_PARTS[part];
  if (partPointer === undefined || !objectHasOwn(META_PARTS, part)) {
    return `/meta has no member ${quoteText(part)}`;
  }
  const depth = segments.length - 2;
  if (name === undefined) {
    if (part === 'tenantId') return place(['value'], partPointer, 0, text);
    return place([part === 'tags' ? 'array' : 'object'], partPointer, 0);
  }
  switch (part) {
    case 'tenantId':
      return 'nothing is below /meta/tenantId, a string';
    case 'dates':
      return (
        nameProblem(name, 'date') ??
        (field === undefined ? place(['value'], partPointer, depth, date) : 'a date is a string')
      );
    case 'tags':
      if (!regExpTest(INDEX, name)) return 'a tag is named by its index, written 0|[1-9][0-9]*';
      return field === undefined ? place(['value'], partPointer, depth, text) : 'a tag is a string';
    case 'dimensions': {
      const problem = nameProblem(name, 'dimension');
      if (problem !== undefined) return problem;
      const value = (v: JsonScalar): string | undefined => dimensionValueProblem(v, '/value');
      if (field === undefined) return place(['value', 'array'], partPointer, depth, value);
      if (!regExpTest(INDEX, field))
        return 'a dimension value is named by its index, 0|[1-9][0-9]*';
      return sub === undefined ? place(['value'], partPointer, depth, value) : 'below a string';
    }
    case 'context':
      return freePlace(partPointer, depth);
    default:
      return assertionPlace(arraySlice(segments, 2), partPointer, depth);
  }
}

/** The place below `/meta/assertions`, from `[key, field, …]`. */
function assertionPlace(
  rest: readonly string[],
  partPointer: string,
  depth: number,
): LeafPlace | string {
  const [key = '', field, sub, below] = rest;
  const problem = assertionKeyProblem(key);
  if (problem !== undefined) return problem;
  if (field === undefined) {
    return 'an assertion holds by, method, at and status, so it is never a leaf';
  }
  if (field === 'source') {
    if (sub === undefined) return 'a source holds proofDigest and output, so it is never a leaf';
    if (!arrayIncludes(SOURCE_FIELDS, sub)) return `a source has no field ${quoteText(sub)}`;
    return below === undefined
      ? place(['value'], partPointer, depth, FIELD_VALUES[sub] ?? any)
      : 'a field of a source is a scalar';
  }
  if (!arrayIncludes(FIELDS, field)) return `an assertion has no field ${quoteText(field)}`;
  return sub === undefined
    ? place(['value'], partPointer, depth, FIELD_VALUES[field] ?? any)
    : 'a field of an assertion is a scalar';
}

/**
 * A place `depth` levels below `root` (`/data` or `/meta/context`), where any JSON is: at most
 * `MAX_JSON_DEPTH` levels below it, as `validateProofInput` counts them (a leaf deeper sits in a
 * container past the limit), and a list at that very depth holds nothing (its elements would
 * be one level deeper).
 */
function freePlace(root: string, depth: number): LeafPlace | string {
  if (depth > MAX_JSON_DEPTH) {
    return `it is nested deeper than ${MAX_JSON_DEPTH} levels below ${root}`;
  }
  const at = place(['value', 'array', 'object'], root, depth, any);
  return depth === MAX_JSON_DEPTH ? { ...at, maxLength: 0 } : at;
}

/** Why `name` names no date or dimension, or `undefined`. */
function nameProblem(name: string, kind: string): string | undefined {
  if (isUnnamable(name)) return `a ${kind} name is never empty or "-"`;
  if (stringStartsWith(name, '$')) return `a ${kind} name never starts with "$"`;
  return undefined;
}

/**
 * A place of the part whose own pointer is `partPointer`, `depth` values below the values every
 * input holds (`/data/a` and `/meta/dimensions/a` are 1 deep, `/meta/tags` 0):
 * its pointers leave room for the shortest pointers of the other parts, and its lists for the
 * values a valid input always holds and those above it.
 */
function place(
  kinds: readonly LeafKind[],
  partPointer: string,
  depth = 0,
  value: (value: JsonScalar) => string | undefined = any,
): LeafPlace {
  return {
    kinds,
    minLength: partPointer === '/meta/dimensions' && depth === 1 ? 2 : 0,
    maxLength: MAX_JSON_VALUES - LEAST_VALUES - depth,
    maxPointer: MAX_INPUT_LEAF_TEXT - (LEAST_TEXT - partPointer.length),
    value,
  };
}
