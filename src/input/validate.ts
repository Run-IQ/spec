import { citeName, unreadableMessage } from '../errors.js';
import { reservedDateNameMessage } from '../reserved.js';
import {
  dimensionValueProblem,
  isUnnamable,
  reservedDimensionNameMessage,
  unnamableNameMessage,
} from '../rule/dimensions.js';
import type { RuleValidationIssue } from '../rule/validate.js';
import { isCivilDate, isInstant } from '../time/civil.js';
import { hasLoneSurrogate, isPlainObject, loneSurrogateMessage } from '../values.js';
import { assertionKeyProblem, DATE_FORMS, readAssertion } from './assertions.js';
import {
  announce,
  checkText,
  childPointer,
  expectPlainObject,
  ownKeys,
  readFields,
  readMember,
  requireFields,
  runCheck,
  surrogateKeyMessage,
  walkJson,
} from './read.js';
import type { Reader } from './read.js';

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
 * (`<pointer> is nested deeper than 1000 levels`, at the first container past the limit); at most `MAX_INPUT_VALUES`
 * (10 000 000) property values in all, counted before they are read (`input too large: more
 * than 10000000 values`, which stops the check); the reserved segments of a `source.subject`
 * well formed (`isSubject`).
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
 * Never throws. Each property is read once, even when several paths lead to one object (an
 * object holding a value cut too deep is read again from a shorter path). A property that
 * cannot be read (a getter or a Proxy trap that throws) gives `<pointer> could not be read:
 * <reason>`; nesting is walked without recursion, so no input overflows the stack. At most
 * `MAX_ISSUES` (100) problems are listed, in the order found, then one last issue
 * `further problems not listed (limit 100)` (path `''`) and the check stops; a path or a
 * message longer than `MAX_ISSUE_TEXT` (1024) code units is cut there and followed by `…`.
 */
export function validateProofInput(value: unknown): RuleValidationIssue[] {
  return check(value).issues;
}

/**
 * Internal (not exported from the package): the property values `validateProofInput` reads
 * on `value`, so that tests bound the work without a clock.
 */
export function inputCheckReads(value: unknown): number {
  return check(value).reads;
}

function check(value: unknown): { issues: RuleValidationIssue[]; reads: number } {
  return runCheck(
    (reader) => {
      readInput(value, reader);
    },
    (error) => ({ path: '', message: unreadableMessage('proof input', error) }),
  );
}

function readInput(value: unknown, reader: Reader): void {
  const { add } = reader;
  if (!isPlainObject(value)) {
    add('', 'a proof input must be a plain object');
    return;
  }
  const fields = readFields(value, '', 'proof input', INPUT_KEYS, reader);
  if (fields === undefined) return;
  requireFields(fields, '', INPUT_KEYS, add);
  if (fields.values.has('data')) {
    const data = fields.values.get('data');
    if (expectPlainObject(data, '/data', PLAIN_OBJECT, add)) walkJson(data, '/data', reader, true);
  }
  if (fields.values.has('meta')) readMeta(fields.values.get('meta'), reader);
}

function readMeta(value: unknown, reader: Reader): void {
  const { add } = reader;
  if (!expectPlainObject(value, '/meta', PLAIN_OBJECT, add)) return;
  const fields = readFields(value, '/meta', '/meta', META_KEYS, reader);
  if (fields === undefined) return;
  requireFields(fields, '/meta', META_KEYS, add);
  const field = (key: string): { value: unknown } | undefined =>
    fields.values.has(key) ? { value: fields.values.get(key) } : undefined;

  const tenantId = field('tenantId');
  if (tenantId !== undefined) checkText(tenantId.value, '/meta/tenantId', add);
  const dates = field('dates');
  if (dates !== undefined) readDates(dates.value, reader);
  const tags = field('tags');
  if (tags !== undefined) readTags(tags.value, reader);
  const dimensions = field('dimensions');
  if (dimensions !== undefined) readDimensions(dimensions.value, reader);
  const context = field('context');
  if (context !== undefined) {
    if (expectPlainObject(context.value, '/meta/context', PLAIN_OBJECT, add)) {
      walkJson(context.value, '/meta/context', reader);
    }
  }
  const assertions = field('assertions');
  if (assertions !== undefined) readAssertions(assertions.value, reader);
}

/**
 * Reads each member of the object at `path` once, after counting them; a key holding a lone
 * surrogate is reported at `path` and not read. Calls `each` with the key, its pointer and its
 * value.
 */
function eachMember(
  value: unknown,
  path: string,
  reader: Reader,
  each: (key: string, at: string, member: unknown) => void,
): void {
  const { add } = reader;
  if (!expectPlainObject(value, path, PLAIN_OBJECT, add)) return;
  const keys = ownKeys(value, path, add);
  if (keys === undefined) return;
  announce(reader, keys.length, path);
  for (const key of keys) {
    if (hasLoneSurrogate(key)) {
      add(path, surrogateKeyMessage(path, key));
      continue;
    }
    const at = childPointer(path, key);
    const read = readMember(value, key, at, add);
    if (read !== 'failed') each(key, at, read.value);
  }
}

function readDates(value: unknown, reader: Reader): void {
  const path = '/meta/dates';
  eachMember(value, path, reader, (key, at, date) => {
    if (isUnnamable(key)) reader.add(path, unnamableNameMessage(path, 'date', key));
    else if (key.startsWith('$')) reader.add(at, reservedDateNameMessage(at));
    else if (!isCivilDate(date) && !isInstant(date)) {
      reader.add(at, `${citeName(at)} must be ${DATE_FORMS}`);
    }
  });
}

/**
 * The elements of the list at `path`, each read once after counting them: `not a list` when
 * `value` is not a list (or announces an impossible length), `failed` after reporting a read
 * that threw.
 */
function readList(
  value: unknown,
  path: string,
  reader: Reader,
): unknown[] | 'not a list' | 'failed' {
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
  const items: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const read = readMember(value, i, `${path}/${i}`, add);
    if (read === 'failed') return 'failed';
    items.push(read.value);
  }
  return items;
}

/** True when `items` are strictly increasing in UTF-16 code units: sorted, no duplicate. */
function strictlySorted(items: readonly string[]): boolean {
  return items.every((item, i) => i === 0 || (items[i - 1] ?? '') < item);
}

function readTags(value: unknown, reader: Reader): void {
  const path = '/meta/tags';
  const tags = readList(value, path, reader);
  if (tags === 'failed') return;
  const texts =
    tags === 'not a list' ? [] : tags.filter((tag): tag is string => typeof tag === 'string');
  if (tags === 'not a list' || texts.length !== tags.length) {
    reader.add(path, `${citeName(path)} must be an array of strings`);
    return;
  }
  texts.forEach((tag, i) => {
    const at = `${path}/${i}`;
    if (tag === '') reader.add(at, `${citeName(at)} must be a non-empty string`);
    else if (hasLoneSurrogate(tag)) reader.add(at, loneSurrogateMessage(at));
  });
  if (!strictlySorted(texts)) reader.add(path, 'tags must be sorted without duplicates');
}

function readDimensions(value: unknown, reader: Reader): void {
  const path = '/meta/dimensions';
  eachMember(value, path, reader, (key, at, dimension) => {
    if (isUnnamable(key)) {
      reader.add(path, unnamableNameMessage(path, 'dimension', key));
      return;
    }
    if (key.startsWith('$')) {
      reader.add(at, reservedDimensionNameMessage(at));
      return;
    }
    readDimension(dimension, at, reader);
  });
}

/** A dimension value, or a sorted list of at least two values without duplicates. */
function readDimension(value: unknown, path: string, reader: Reader): void {
  const { add } = reader;
  if (typeof value === 'string') {
    const problem = dimensionValueProblem(value, path);
    if (problem !== undefined) add(path, problem);
    return;
  }
  const values = readList(value, path, reader);
  if (values === 'failed') return;
  if (values === 'not a list') {
    add(path, `${citeName(path)} must be a value or a sorted list of at least two values`);
    return;
  }
  let valid = true;
  values.forEach((item, i) => {
    const problem = dimensionValueProblem(item, `${path}/${i}`);
    if (problem !== undefined) {
      add(`${path}/${i}`, problem);
      valid = false;
    }
  });
  const texts = values.filter((item): item is string => typeof item === 'string');
  if (!valid || texts.length !== values.length) return;
  if (texts.length === 0) add(path, `${citeName(path)} must not be an empty list`);
  else if (texts.length === 1) {
    add(path, `${citeName(path)} holds a single value: write it as a string, not a list`);
  } else if (!strictlySorted(texts)) {
    add(path, `${citeName(path)} must be sorted without duplicates`);
  }
}

function readAssertions(value: unknown, reader: Reader): void {
  eachMember(value, '/meta/assertions', reader, (key, at, assertion) => {
    const problem = assertionKeyProblem(key);
    if (problem !== undefined) reader.add(at, problem);
    else readAssertion(assertion, at, reader);
  });
}
