import type { JsonValue } from '../canonical.js';
import { citeName, newSpecError, unreadableMessage } from '../errors.js';
import type { JsonPointer } from '../path/pointer.js';
import { reservedDateNameMessage } from '../reserved.js';
import {
  dimensionValueProblem,
  isUnnamable,
  reservedDimensionNameMessage,
  unnamableNameMessage,
} from '../rule/dimensions.js';
import type { RuleValidationIssue } from '../rule/validate.js';
import { isCivilDate, isInstant } from '../time/civil.js';
import type { CivilDate, Instant } from '../time/civil.js';
import {
  hasLoneSurrogate,
  isPlainObject,
  loneSurrogateMessage,
  notADateMessage,
  MAX_INPUT_LEAF_TEXT,
} from '../values.js';
import { assertionKeyProblem, DATE_FORMS, readAssertion } from './assertions.js';
import {
  announce,
  addText,
  checkText,
  childPointer,
  copyWork,
  expectPlainObject,
  ownKeys,
  readFields,
  readElement,
  readMember,
  requireFields,
  runCheck,
  surrogateKeyMessage,
  walkJson,
} from './read.js';
import type { LeafCount, Reader } from './read.js';
import type { FactAssertion, ProofInput } from './types.js';

const INPUT_KEYS: readonly string[] = ['data', 'meta'];
const META_KEYS: readonly string[] = [
  'tenantId',
  'dates',
  'tags',
  'dimensions',
  'context',
  'assertions',
];
const PLAIN_OBJECT = 'a plain object';

/**
 * Checks a proof input (`ProofInput`) in its canonical form without throwing, and returns
 * every problem found, each at the JSON pointer of its value in the input (`/data/id`,
 * `/meta/dates/facture`; `''` for the whole value). It agrees with
 * `schema/proof-input.schema.json` on JSON documents, and also checks what JSON Schema cannot
 * express: `meta.tags` and each list of dimension values sorted by UTF-16 code unit
 * (`tags must be sorted without duplicates`); no text or key with a lone UTF-16 surrogate;
 * values at most `MAX_JSON_DEPTH` (1000) levels below `data` or `meta.context`
 * (`<pointer> is nested deeper than 1000 levels`, at the first container past the limit);
 * lists without holes (`<pointer> has a hole at index <i>: arrays must be dense`); at most
 * `MAX_JSON_VALUES` (10 000 000) property values in all, counted before they are read
 * (`<pointer> is too large: more than 10000000 values`, which stops the check); the reserved
 * segments of a `source.subject` well formed (`isSubject`); once no other problem is found, at
 * most `MAX_INPUT_LEAF_TEXT` (2^28) UTF-16 code units in the pointers of its leaves, all
 * added up, each leaf on each path counted (the leaves of the input tree, D-15; at `''`: `the
 * leaf pointers of the input hold more than 268435456 code units`): the work of a digest
 * follows them.
 *
 * The canonical form is closed: `data` and `meta` with exactly `tenantId`, `dates`, `tags`,
 * `dimensions`, `context` and `assertions` (the former `effectiveDate` is
 * `meta.dates.effective`). A date is a civil date or a canonical instant, never an offset: the
 * caller (`core`) normalizes first. `data` and `meta.context` hold plain JSON without a number
 * of absolute value 2^53 or more (`number beyond 2^53 at /data/id`, D-5); a root key of `data`
 * starting with `$` is reserved (`reserved key /data/$x`, D-3). A dimension is a value or a
 * sorted list of at least two values. Tags, dimension names and date names are never empty;
 * dimension and date names are never `-` and never start with `$` (no pointer could name them).
 * An assertion is keyed by a context pointer (`assertionKeyProblem`), carries every required
 * field, `source` with `method: 'decision'` only, and `complete` only as `false` (a list is
 * complete by default).
 *
 * A member whose value is `undefined` is absent in an object the format defines (`meta`, a
 * map of dates, dimensions or assertions, an assertion), known or not; inside `data` or
 * `meta.context`, and as a list item, it is refused (`<pointer> is not JSON: undefined`).
 *
 * Never throws. Each property is read once, even when several paths lead to one object (an
 * object holding a value cut too deep is read again from a shorter path); its values are
 * counted on every path, as the JSON text holds them (`MAX_JSON_VALUES`). A property that
 * cannot be read (a getter or a Proxy trap that throws) gives `<pointer> could not be read:
 * <reason>`; nesting is walked without recursion, so no input overflows the stack. At most
 * `MAX_ISSUES` (100) problems are listed, in the order found, then one last issue
 * `further problems not listed (limit 100)` (path `''`) and the check stops; a path or a
 * message longer than `MAX_ISSUE_TEXT` (1024) code units is cut there and followed by `…`.
 */
export function validateProofInput(value: unknown): RuleValidationIssue[] {
  return check(value, false).issues;
}

/**
 * Internal (not exported from the package): the property values `validateProofInput` reads
 * on `value`, so that tests bound the work without a clock. Like `validateProofInput`, it keeps
 * no copy of `value`: beyond the input, its memory is the walk's state and the issues.
 */
export function inputCheckReads(value: unknown): number {
  return check(value, false).reads;
}

/**
 * Internal (not exported from the package), for tests: the UTF-16 code units of the leaf
 * pointers of `value` as `validateProofInput` counts them while it reads (D-15), stopped one past
 * `MAX_INPUT_LEAF_TEXT`.
 */
export function inputLeafText(value: unknown): number {
  return check(value, false).leafText;
}

/**
 * Internal: the problems of `value` as `validateProofInput` finds them, and, when there are
 * none, its plain copy, built from the very values checked (each read and counted once): what
 * `computeInputDigest` hashes.
 */
export function readProofInput(value: unknown): {
  issues: RuleValidationIssue[];
  snapshot: ProofInput | undefined;
} {
  const { issues, snapshot } = check(value, true);
  return { issues, snapshot: issues.length === 0 ? snapshot : undefined };
}

/**
 * Internal: the plain copy of `value` when `validateProofInput` finds no problem in it (each
 * value read and counted once); otherwise throws `SpecError` (`INVALID_INPUT`, `invalid input:
 * <first problem>`, the problem's path as `path`). What every digest of an input hashes.
 */
export function readValidInput(value: unknown): ProofInput {
  const { issues, snapshot } = readProofInput(value);
  const [first] = issues;
  if (first !== undefined || snapshot === undefined) {
    throw newSpecError(
      'INVALID_INPUT',
      `invalid input: ${first?.message ?? 'unreadable'}`,
      first?.path,
    );
  }
  return snapshot;
}

/** The problem of an input whose leaf pointers pass `MAX_INPUT_LEAF_TEXT`. */
const POINTER_TEXT_MESSAGE =
  'the leaf pointers of the input hold more than ' + `${MAX_INPUT_LEAF_TEXT} code units`;

function check(
  value: unknown,
  copy: boolean,
): {
  issues: RuleValidationIssue[];
  reads: number;
  snapshot: ProofInput | undefined;
  leafText: number;
} {
  let snapshot: ProofInput | undefined;
  let leafText = 0;
  const { issues, reads } = runCheck(
    (reader) => {
      snapshot = readInput(value, reader);
      leafText = reader.leafText;
    },
    (error) => ({ path: '', message: unreadableMessage('proof input', error) }),
    { copy },
  );
  // The leaves are those the input tree hashes (D-15), counted as the input was read.
  if (issues.length === 0 && leafText > MAX_INPUT_LEAF_TEXT) {
    issues.push({ path: '', message: POINTER_TEXT_MESSAGE });
  }
  return { issues, reads, snapshot: issues.length === 0 ? snapshot : undefined, leafText };
}

/** Adds to `reader.leafText` the leaves of a value walked at `path` (`walkJson`). */
function countLeaves(reader: Reader, path: string, count: LeafCount): void {
  reader.leafText = addText(reader.leafText, addText(count.units, count.leaves * path.length));
}

/** Adds `units` code units of leaf pointers to `reader.leafText`. */
function countText(reader: Reader, units: number): void {
  reader.leafText = addText(reader.leafText, units);
}

/** The input read, as a plain copy (with `reader.copies`); complete only without a problem. */
function readInput(value: unknown, reader: Reader): ProofInput | undefined {
  const { add } = reader;
  if (!isPlainObject(value)) {
    add('', 'a proof input must be a plain object');
    return undefined;
  }
  const fields = readFields(value, '', 'proof input', INPUT_KEYS, reader);
  if (fields === undefined) return undefined;
  requireFields(fields, '', INPUT_KEYS, add);
  let data: JsonValue | undefined;
  if (fields.values.has('data')) {
    const value = fields.values.get('data');
    if (expectPlainObject(value, '/data', PLAIN_OBJECT, add)) {
      const walked = walkJson(value, '/data', reader, true);
      countLeaves(reader, '/data', walked);
      data = walked.copy;
    }
  }
  const meta = fields.values.has('meta') ? readMeta(fields.values.get('meta'), reader) : undefined;
  if (reader.copies === undefined || !isJsonObject(data) || meta === undefined) return undefined;
  return { data, meta };
}

function isJsonObject(value: JsonValue | undefined): value is { [k: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMeta(value: unknown, reader: Reader): ProofInput['meta'] | undefined {
  const { add } = reader;
  if (!expectPlainObject(value, '/meta', PLAIN_OBJECT, add)) return undefined;
  const fields = readFields(value, '/meta', '/meta', META_KEYS, reader);
  if (fields === undefined) return undefined;
  requireFields(fields, '/meta', META_KEYS, add);
  const field = (key: string): { value: unknown } | undefined =>
    fields.values.has(key) ? { value: fields.values.get(key) } : undefined;

  const tenantId = field('tenantId');
  if (tenantId !== undefined) checkText(tenantId.value, '/meta/tenantId', add);
  countText(reader, '/meta/tenantId'.length);
  const dates = field('dates');
  const datesCopy = dates === undefined ? undefined : readDates(dates.value, reader);
  const tags = field('tags');
  const tagsCopy = tags === undefined ? undefined : readTags(tags.value, reader);
  const dimensions = field('dimensions');
  const dimensionsCopy =
    dimensions === undefined ? undefined : readDimensions(dimensions.value, reader);
  const context = field('context');
  let contextCopy: JsonValue | undefined;
  if (context !== undefined) {
    if (expectPlainObject(context.value, '/meta/context', PLAIN_OBJECT, add)) {
      const walked = walkJson(context.value, '/meta/context', reader);
      countLeaves(reader, '/meta/context', walked);
      contextCopy = walked.copy;
    }
  }
  const assertions = field('assertions');
  const assertionsCopy =
    assertions === undefined ? undefined : readAssertions(assertions.value, reader);
  if (
    typeof tenantId?.value !== 'string' ||
    datesCopy === undefined ||
    tagsCopy === undefined ||
    dimensionsCopy === undefined ||
    !isJsonObject(contextCopy) ||
    assertionsCopy === undefined
  ) {
    return undefined;
  }
  return {
    tenantId: tenantId.value,
    dates: datesCopy,
    tags: tagsCopy,
    dimensions: dimensionsCopy,
    context: contextCopy,
    assertions: assertionsCopy,
  };
}

/**
 * Reads each member of the object at `path` once, after counting them; a member whose value is
 * `undefined` is absent; a key holding a lone surrogate is reported at `path`. Calls `each` with
 * the key, its pointer and its value. With `reader.copies`, returns the copy of the values
 * `each` returns (a value `each` refuses is left out: the problem is reported); without, an
 * empty record (no copy is kept). `undefined` when `value` is not an object or its keys cannot
 * be listed. An object without member is a leaf (D-15): its pointer is counted.
 */
function eachMember<T>(
  value: unknown,
  path: string,
  reader: Reader,
  each: (key: string, at: string, member: unknown) => T | undefined,
): Record<string, T> | undefined {
  const { add } = reader;
  if (!expectPlainObject(value, path, PLAIN_OBJECT, add)) return undefined;
  const keys = ownKeys(value, path, add);
  if (keys === undefined) return undefined;
  announce(reader, keys.length, path);
  const copy: Record<string, T> = {};
  let members = 0;
  for (const key of keys) {
    const at = childPointer(path, key);
    const read = readMember(value, key, at, add);
    if (read === 'failed' || read.value === undefined) continue;
    members += 1;
    if (hasLoneSurrogate(key)) {
      add(path, surrogateKeyMessage(path, key));
      continue;
    }
    const member = each(key, at, read.value);
    // Plain assignment would turn a `__proto__` key into a prototype change.
    if (member !== undefined && reader.copies !== undefined) {
      copyWork.values += 1;
      Object.defineProperty(copy, key, {
        value: member,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  if (members === 0) countText(reader, path.length);
  return copy;
}

function readDates(
  value: unknown,
  reader: Reader,
): Record<string, CivilDate | Instant> | undefined {
  const path = '/meta/dates';
  return eachMember(value, path, reader, (key, at, date) => {
    if (isUnnamable(key)) reader.add(path, unnamableNameMessage(path, 'date', key));
    else if (key.startsWith('$')) reader.add(at, reservedDateNameMessage(at));
    else if (!isCivilDate(date) && !isInstant(date)) {
      const notDate = notADateMessage(date);
      reader.add(
        at,
        notDate === undefined
          ? `${citeName(at)} must be ${DATE_FORMS}`
          : `${citeName(at)} must be ${DATE_FORMS}; got ${notDate}`,
      );
    } else {
      countText(reader, at.length);
      return date;
    }
    return undefined;
  });
}

/**
 * Reads the elements of the list at `path`, each once after counting them, and calls `each`
 * with each in order (none is kept): `not a list` when `value` is not a list (or announces an
 * impossible length), `failed` after reporting a read that threw, else the length. The list and
 * each element are leaves (D-15): their pointers are counted.
 */
function eachElement(
  value: unknown,
  path: string,
  reader: Reader,
  each: (item: unknown, at: string) => void,
): number | 'not a list' | 'failed' {
  const { add } = reader;
  let length: unknown;
  try {
    if (!Array.isArray(value)) return 'not a list';
    length = value.length;
  } catch (error) {
    add(path, unreadableMessage(path, error));
    return 'failed';
  }
  // Only a Proxy can announce such a length.
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    return 'not a list';
  }
  announce(reader, length, path);
  countText(reader, path.length);
  for (let i = 0; i < length; i++) {
    const read = readElement(value, i, path, add);
    if (read === 'failed') return 'failed';
    const at = `${path}/${i}`;
    countText(reader, at.length);
    each(read.value, at);
  }
  return length;
}

/**
 * Checks, element by element, that the strings of a list are strictly increasing in UTF-16 code
 * units (sorted, no duplicate), keeping only the last one; `copy` keeps them all when a copy is
 * made.
 */
class SortedTexts {
  private last: string | undefined;
  sorted = true;
  allTexts = true;
  readonly copy: string[] | undefined;

  constructor(reader: Reader) {
    this.copy = reader.copies === undefined ? undefined : [];
  }

  add(item: unknown): item is string {
    if (typeof item !== 'string') {
      this.allTexts = false;
      return false;
    }
    if (this.last !== undefined && !(this.last < item)) this.sorted = false;
    this.last = item;
    if (this.copy !== undefined) {
      copyWork.values += 1;
      this.copy.push(item);
    }
    return true;
  }
}

function readTags(value: unknown, reader: Reader): string[] | undefined {
  const path = '/meta/tags';
  const tags = new SortedTexts(reader);
  const length = eachElement(value, path, reader, (tag, at) => {
    if (!tags.add(tag)) return;
    if (tag === '') reader.add(at, `${citeName(at)} must be a non-empty string`);
    else if (hasLoneSurrogate(tag)) reader.add(at, loneSurrogateMessage(at));
  });
  if (length === 'failed') return undefined;
  if (length === 'not a list' || !tags.allTexts) {
    reader.add(path, `${citeName(path)} must be an array of strings`);
    return undefined;
  }
  if (!tags.sorted) reader.add(path, 'tags must be sorted without duplicates');
  return tags.copy ?? [];
}

function readDimensions(
  value: unknown,
  reader: Reader,
): Record<string, string | string[]> | undefined {
  const path = '/meta/dimensions';
  return eachMember(value, path, reader, (key, at, dimension) => {
    if (isUnnamable(key)) {
      reader.add(path, unnamableNameMessage(path, 'dimension', key));
      return undefined;
    }
    if (key.startsWith('$')) {
      reader.add(at, reservedDimensionNameMessage(at));
      return undefined;
    }
    return readDimension(dimension, at, reader);
  });
}

/**
 * A dimension value, or a sorted list of at least two values without duplicates; its copy, or
 * `undefined` after reporting a problem.
 */
function readDimension(
  value: unknown,
  path: string,
  reader: Reader,
): string | string[] | undefined {
  const { add } = reader;
  if (typeof value === 'string') {
    countText(reader, path.length);
    const problem = dimensionValueProblem(value, path);
    if (problem === undefined) return value;
    add(path, problem);
    return undefined;
  }
  const values = new SortedTexts(reader);
  let valid = true;
  const length = eachElement(value, path, reader, (item, at) => {
    values.add(item);
    const problem = dimensionValueProblem(item, at);
    if (problem !== undefined) {
      add(at, problem);
      valid = false;
    }
  });
  if (length === 'failed') return undefined;
  if (length === 'not a list') {
    add(path, `${citeName(path)} must be a value or a sorted list of at least two values`);
    return undefined;
  }
  if (!valid || !values.allTexts) return undefined;
  if (length === 0) add(path, `${citeName(path)} must not be an empty list`);
  else if (length === 1) {
    add(path, `${citeName(path)} holds a single value: write it as a string, not a list`);
  } else if (!values.sorted) {
    add(path, `${citeName(path)} must be sorted without duplicates`);
  } else return values.copy ?? [];
  return undefined;
}

function readAssertions(
  value: unknown,
  reader: Reader,
): Record<JsonPointer, FactAssertion> | undefined {
  return eachMember(value, '/meta/assertions', reader, (key, at, assertion) => {
    const problem = assertionKeyProblem(key);
    if (problem !== undefined) {
      reader.add(at, problem);
      return undefined;
    }
    const read = readAssertion(assertion, at, reader);
    // Its fields are its leaves (D-15); `source` holds the leaves of its own fields.
    if (read !== undefined) {
      for (const [field, member] of Object.entries(read)) {
        const fieldAt = `${at}/${field}`;
        if (typeof member !== 'object') countText(reader, fieldAt.length);
        else
          for (const name of Object.keys(member))
            countText(reader, fieldAt.length + 1 + name.length);
      }
    }
    return read;
  });
}
