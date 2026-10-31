import type { JsonValue } from '../canonical.js';
import { describeError, quoteText } from '../errors.js';
import { comparePointers, parsePointer } from '../path/pointer.js';
import type { JsonPointer } from '../path/pointer.js';
import { isReservedName, reservedDatePointerMessage } from '../reserved.js';
import { typeName } from '../values.js';
import { emptyDimensionNameMessage, reservedDimensionNameMessage } from './dimensions.js';

/** The types an order key compares its values as (`OrderKey`). */
export type OrderKeyType = 'number' | 'decimal' | 'date' | 'dateTime' | 'string';

/**
 * One key of `forEach.orderBy`: the member `path` of each element (a JSON pointer into the
 * element, `/naissance`), compared as `type`, in the direction `dir`. Values compare by type:
 * `number` numerically, `decimal` by exact value (`'10'` after `'9'`), `date` as civil dates,
 * `dateTime` as instants, `string` by UTF-16 code units (`'Z'` before `'a'`).
 *
 * The keys are compared in their order. Two elements equal on every key are TIED: their rank
 * (`$index`) is unknown, and an instance that reads its rank (`$index`, `$prev`) waits with the
 * reason `AMBIGUOUS_ORDER` (D-20). The identity key never breaks a tie: to break one, name it
 * as a last order key (`{ path: '/id', type: 'string', dir: 'asc' }`).
 */
export interface OrderKey {
  path: JsonPointer;
  type: OrderKeyType;
  dir: 'asc' | 'desc';
}

/**
 * What a rule iterates over: it applies once per instance, each with a subject (`Subject`).
 *
 * A collection `{ path, key, orderBy?, dimensions?, recurse?, groupBy? }`:
 * - `path`: a JSON pointer into the input data whose `*` segments step into each element of a
 *   list (`/foyers/*\/personnes`): one LEVEL per list. It starts and ends with a member name,
 *   never holds two `*` in a row, a `-` segment, a literal segment starting with `@` or `!`
 *   (they mark subjects, D-2), nor starts with `$` (an engine variable, not data);
 * - `key`: the member that identifies the elements of each level, one name for every level or a
 *   list of one name per level (normal form: one name when all are equal);
 * - `orderBy`: the rank of the elements (`OrderKey`), in order; an empty list is absent;
 * - `dimensions`: dimension name to a JSON pointer into the element, read per element (G-7); an
 *   empty object is absent; names starting with `$` are reserved;
 * - `recurse`: a JSON pointer into the element to its child list, walked at every depth (G-18);
 * - `groupBy`: a JSON pointer into the element; one instance per group of equal values (G-17).
 *   `recurse` and `groupBy` exclude each other; a group has no single element, so `groupBy`
 *   excludes non-empty `dimensions` (and `effectiveOn: '/$item/…'`). `groupBy` also excludes
 *   a non-empty `orderBy` for now: the order of groups is not defined yet (accepting it later
 *   is additive). Empty `orderBy` and `dimensions` mean absent and go with `groupBy`.
 *
 * A literal segment of `path` made of digits (`/foyers/0/personnes`) is accepted here: an object
 * key may be digits, which no static check can tell from a list index. `core` refuses, at
 * evaluation, a path step that indexes into a list (a subject never holds an index, D-2).
 *
 * Time segments `{ segments: { from, until, facts } }` (G-15): the period from `from` to `until`
 * (two named dates `/$dates/<name>`, different) cut where the facts of `facts` (JSON pointers
 * into the input data; normal form sorted by `comparePointers`, without duplicates) change.
 *
 * Pointers into an element are non-empty and hold no `*` (they name one value) and no `-`
 * segment; `recurse` also has no segment starting with `@` or `!` (it enters subjects).
 */
export type ForEach =
  | {
      path: string;
      key: string | string[];
      orderBy?: OrderKey[];
      dimensions?: Record<string, JsonPointer>;
      recurse?: JsonPointer;
      groupBy?: JsonPointer;
    }
  | { segments: { from: JsonPointer; until: JsonPointer; facts: JsonPointer[] } };

type Collection = Exclude<ForEach, { segments: unknown }>;
type Add = (path: string, message: string) => void;
type JsonObject = { [k: string]: JsonValue };

const ORDER_TYPES: readonly OrderKeyType[] = ['number', 'decimal', 'date', 'dateTime', 'string'];
const COLLECTION_KEYS: readonly string[] = [
  'path',
  'key',
  'orderBy',
  'dimensions',
  'recurse',
  'groupBy',
];
const ORDER_KEYS: readonly string[] = ['path', 'type', 'dir'];
const SEGMENTS_KEYS: readonly string[] = ['from', 'until', 'facts'];
const SHAPE =
  'forEach must be an object { path, key, orderBy?, dimensions?, recurse?, groupBy? } ' +
  'or { segments }';
const NO_DASH = "must not hold a '-' segment: '-' is not an index";

/**
 * Internal to `@run-iq/spec` (not exported from the package): shared by
 * `normalizeRuleDefinition` and `validateRuleDefinition` so that they cannot disagree.
 *
 * Reads the `forEach` field of a rule, already converted to JSON, without throwing. Reports
 * every problem found through `add` (each path under `forEach`) and returns the normal form
 * (see `ForEach`) when there is none.
 */
export function readForEach(value: JsonValue, add: Add): ForEach | undefined {
  let valid = true;
  const fail: Add = (path, message) => {
    valid = false;
    add(path, message);
  };
  if (!isJsonObject(value)) {
    fail('forEach', SHAPE);
    return undefined;
  }
  const forEach = Object.hasOwn(value, 'segments')
    ? readSegmentsForm(value, fail)
    : readCollection(value, fail);
  return valid ? forEach : undefined;
}

function readCollection(value: JsonObject, fail: Add): Collection | undefined {
  for (const key of Object.keys(value)) {
    if (!COLLECTION_KEYS.includes(key)) {
      fail(`forEach.${key}`, `forEach has an unknown key ${quoteText(key)}`);
    }
  }
  const levels = readPath(value.path, fail);
  const key = readKey(value.key, levels, fail);
  const orderBy = value.orderBy === undefined ? undefined : readOrderBy(value.orderBy, fail);
  const dimensions =
    value.dimensions === undefined ? undefined : readDimensions(value.dimensions, fail);
  const recurse =
    value.recurse === undefined
      ? undefined
      : readMember(value.recurse, 'forEach.recurse', fail, true);
  const groupBy =
    value.groupBy === undefined ? undefined : readMember(value.groupBy, 'forEach.groupBy', fail);
  if (value.recurse !== undefined && value.groupBy !== undefined) {
    fail('forEach.groupBy', 'forEach.recurse and forEach.groupBy cannot be combined');
  }
  // Empty means absent (normal form): only a non-empty orderBy or dimensions meets groupBy.
  if (isNonEmpty(value.orderBy) && value.groupBy !== undefined) {
    fail(
      'forEach.orderBy',
      'forEach.orderBy cannot be combined with forEach.groupBy: ' +
        'the order of groups is not defined yet',
    );
  }
  if (isNonEmpty(value.dimensions) && value.groupBy !== undefined) {
    fail(
      'forEach.dimensions',
      'forEach.dimensions cannot be combined with forEach.groupBy: ' +
        'a group has no single element to read them from',
    );
  }
  if (levels === undefined || key === undefined || typeof value.path !== 'string') return undefined;

  const out: Collection = { path: value.path, key };
  if (orderBy !== undefined && orderBy.length > 0) out.orderBy = orderBy;
  if (dimensions !== undefined && Object.keys(dimensions).length > 0) out.dimensions = dimensions;
  if (recurse !== undefined) out.recurse = recurse;
  if (groupBy !== undefined) out.groupBy = groupBy;
  return out;
}

/**
 * True for a non-empty list or object. `[]` and `{}` mean absent; a value of another type is
 * refused on its own (so it does not meet `groupBy` too, as in the JSON Schema).
 */
function isNonEmpty(value: JsonValue | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return isJsonObject(value) && Object.keys(value).length > 0;
}

/** The number of levels of a valid `forEach.path`, or `undefined` after reporting why not. */
function readPath(value: JsonValue | undefined, fail: Add): number | undefined {
  const at = 'forEach.path';
  if (value === undefined) {
    fail(at, `${at} is required: the JSON pointer to the collection`);
    return undefined;
  }
  const segments = pointerSegments(value, at, fail);
  if (segments === undefined) return undefined;
  const problem = pathProblem(segments);
  if (problem !== undefined) {
    fail(at, `${at} ${problem}`);
    return undefined;
  }
  return segments.filter((segment) => segment === '*').length + 1;
}

/** What is wrong with the decoded segments of a `forEach.path`, or `undefined`. */
function pathProblem(segments: readonly string[]): string | undefined {
  const [first] = segments;
  if (first === undefined) return 'must name a collection, not the whole input';
  if (first === '*') return 'must start with a collection name, not "*"';
  if (isReservedName(first)) {
    return `must point into the input data: ${quoteText(first)} is an engine variable`;
  }
  for (const [i, segment] of segments.entries()) {
    if (segment === '-') return NO_DASH;
    if (segment === '*') {
      if (i === segments.length - 1) return 'must end with a collection name, not "*"';
      if (segments[i + 1] === '*') return 'must name a collection between two "*"';
    } else if (marksSubject(segment)) {
      return `segment ${quoteText(segment)} must not start with "@" or "!": these mark subjects`;
    }
  }
  return undefined;
}

/** The normal form of `forEach.key` for `levels` levels, or `undefined` after reporting. */
function readKey(
  value: JsonValue | undefined,
  levels: number | undefined,
  fail: Add,
): string | string[] | undefined {
  const at = 'forEach.key';
  if (value === undefined) {
    fail(at, `${at} is required: the member that identifies each element`);
    return undefined;
  }
  if (typeof value === 'string') {
    if (value !== '') return value;
    fail(at, `${at} must not be empty`);
    return undefined;
  }
  if (!Array.isArray(value)) {
    fail(at, `${at} must be a member name or a list of member names, one per level`);
    return undefined;
  }
  const names: string[] = [];
  value.forEach((name, i) => {
    if (typeof name === 'string' && name !== '') names.push(name);
    else fail(`${at}[${i}]`, `${at}[${i}] must be a non-empty string`);
  });
  if (names.length !== value.length || levels === undefined) return undefined;
  if (names.length !== levels) {
    fail(at, `${at} has ${count(names.length, 'name')} for ${count(levels, 'level')}`);
    return undefined;
  }
  const [first = ''] = names;
  return names.every((name) => name === first) ? first : names;
}

function readOrderBy(value: JsonValue, fail: Add): OrderKey[] | undefined {
  const at = 'forEach.orderBy';
  if (!Array.isArray(value)) {
    fail(at, `${at} must be a list of order keys { path, type, dir }`);
    return undefined;
  }
  const keys: OrderKey[] = [];
  const firstAt = new Map<string, number>();
  value.forEach((item, i) => {
    const here = `${at}[${i}]`;
    if (!isJsonObject(item)) {
      fail(here, `${here} must be an order key { path, type, dir }`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (!ORDER_KEYS.includes(key)) {
        fail(`${here}.${key}`, `${here} has an unknown key ${quoteText(key)}`);
      }
    }
    const path = readMember(item.path, `${here}.path`, fail);
    const type = ORDER_TYPES.find((t) => t === item.type);
    if (type === undefined) {
      fail(`${here}.type`, `${here}.type must be one of ${ORDER_TYPES.join(', ')}`);
    }
    const dir = item.dir === 'asc' || item.dir === 'desc' ? item.dir : undefined;
    if (dir === undefined) fail(`${here}.dir`, `${here}.dir must be asc or desc`);
    if (path === undefined) return;
    const earlier = firstAt.get(path);
    if (earlier !== undefined) {
      fail(
        `${here}.path`,
        `${here}.path repeats ${at}[${earlier}].path: a key already compared cannot break a tie`,
      );
      return;
    }
    firstAt.set(path, i);
    if (type !== undefined && dir !== undefined) keys.push({ path, type, dir });
  });
  return keys.length === value.length ? keys : undefined;
}

function readDimensions(value: JsonValue, fail: Add): Record<string, JsonPointer> | undefined {
  const at = 'forEach.dimensions';
  if (!isJsonObject(value)) {
    fail(at, `${at} must be an object of JSON pointers into the element`);
    return undefined;
  }
  const entries: [string, JsonPointer][] = [];
  const names = Object.keys(value).sort();
  for (const name of names) {
    const here = `${at}.${name}`;
    if (name === '') {
      fail(at, emptyDimensionNameMessage(at));
    } else if (isReservedName(name)) {
      fail(here, reservedDimensionNameMessage(here));
    } else {
      const pointer = readMember(value[name], here, fail);
      if (pointer !== undefined) entries.push([name, pointer]);
    }
  }
  // `Object.fromEntries` defines own properties: a `__proto__` name stays data.
  return entries.length === names.length ? Object.fromEntries(entries) : undefined;
}

/**
 * A JSON pointer into an element (`orderBy` paths, `dimensions`, `recurse`, `groupBy`): not
 * empty, no `*` nor `-` segment; with `subject`, no segment starting with `@` or `!` either.
 */
function readMember(
  value: JsonValue | undefined,
  at: string,
  fail: Add,
  subject = false,
): JsonPointer | undefined {
  const segments = pointerSegments(value, at, fail);
  if (segments === undefined) return undefined;
  const problem =
    segments.length === 0
      ? 'must name a member of the element, not the element itself'
      : (onePointProblem(segments) ?? (subject ? subjectSegmentProblem(segments) : undefined));
  if (problem !== undefined) {
    fail(at, `${at} ${problem}`);
    return undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function readSegmentsForm(
  value: JsonObject,
  fail: Add,
): { segments: { from: JsonPointer; until: JsonPointer; facts: JsonPointer[] } } | undefined {
  for (const key of Object.keys(value)) {
    if (key !== 'segments') {
      fail(`forEach.${key}`, `forEach.${key} cannot be combined with forEach.segments`);
    }
  }
  const at = 'forEach.segments';
  const segments = value.segments;
  if (!isJsonObject(segments)) {
    fail(at, `${at} must be an object { from, until, facts }`);
    return undefined;
  }
  for (const key of Object.keys(segments)) {
    if (!SEGMENTS_KEYS.includes(key)) {
      fail(`${at}.${key}`, `${at} has an unknown key ${quoteText(key)}`);
    }
  }
  const from = readNamedDate(segments.from, `${at}.from`, fail);
  const until = readNamedDate(segments.until, `${at}.until`, fail);
  const empty = from !== undefined && from === until;
  if (empty) {
    fail(`${at}.until`, `${at}.until must differ from ${at}.from: the period would be empty`);
  }
  // Read even after a problem above, so that every problem is reported at once.
  const facts = readFacts(segments.facts, `${at}.facts`, fail);
  if (empty || from === undefined || until === undefined || facts === undefined) return undefined;
  return { segments: { from, until, facts } };
}

/** A named date of the input, `/$dates/<name>`, or `undefined` after reporting why not. */
function readNamedDate(value: JsonValue | undefined, at: string, fail: Add): string | undefined {
  const segments = pointerSegments(value, at, fail);
  if (segments === undefined) return undefined;
  const [head, name, ...rest] = segments;
  if (head === '$dates' && name !== undefined && isReservedName(name) && !rest.length) {
    fail(at, reservedDatePointerMessage(at));
    return undefined;
  }
  if (head === '$dates' && name !== undefined && name !== '' && name !== '-' && !rest.length) {
    return typeof value === 'string' ? value : undefined;
  }
  fail(at, `${at} must name a date: /$dates/<name>`);
  return undefined;
}

/** The facts of `segments`, sorted by pointer without duplicates, or `undefined`. */
function readFacts(value: JsonValue | undefined, at: string, fail: Add): string[] | undefined {
  if (!Array.isArray(value)) {
    fail(at, `${at} must be a list of JSON pointers to facts`);
    return undefined;
  }
  const facts: string[] = [];
  value.forEach((item, i) => {
    const here = `${at}[${i}]`;
    const segments = pointerSegments(item, here, fail);
    if (segments === undefined || typeof item !== 'string') return;
    const [first] = segments;
    const problem =
      first === undefined
        ? 'must name a fact, not the whole input'
        : isReservedName(first)
          ? `must point into the input data: ${quoteText(first)} is an engine variable`
          : onePointProblem(segments);
    if (problem === undefined) facts.push(item);
    else fail(here, `${here} ${problem}`);
  });
  if (facts.length !== value.length) return undefined;
  return [...new Set(facts)].sort(comparePointers);
}

/** The decoded segments of a pointer, or `undefined` after reporting why it is not one. */
function pointerSegments(
  value: JsonValue | undefined,
  at: string,
  fail: Add,
): string[] | undefined {
  if (typeof value !== 'string') {
    fail(at, `${at} must be a JSON pointer: got a value of type ${typeName(value)}`);
    return undefined;
  }
  try {
    return parsePointer(value);
  } catch (error) {
    fail(at, `${at} must be a JSON pointer: ${describeError(error)}`);
    return undefined;
  }
}

/** A pointer that names one value has no `*` (a wildcard) and no `-` segment. */
function onePointProblem(segments: readonly string[]): string | undefined {
  if (segments.includes('*')) return 'must not hold a "*" segment: it names one value';
  return segments.includes('-') ? NO_DASH : undefined;
}

function subjectSegmentProblem(segments: readonly string[]): string | undefined {
  const marked = segments.find(marksSubject);
  return marked === undefined
    ? undefined
    : `segment ${quoteText(marked)} must not start with "@" or "!": these mark subjects`;
}

/** `@` starts an element segment and `!` a reserved one, in a subject (D-2). */
function marksSubject(segment: string): boolean {
  return segment.startsWith('@') || segment.startsWith('!');
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
