import { citeName, unreadableMessage } from '../errors.js';
import { pathArgumentIssue } from '../issues.js';
import type { RuleValidationIssue } from '../rule/validate.js';
import { isCivilDate } from '../time/civil.js';
import type { CivilDate } from '../time/civil.js';
import {
  announce,
  childPointer,
  expectPlainObject,
  readFields,
  readElement,
  requireFields,
  runCheck,
  walkJson,
} from './read.js';
import type { Reader } from './read.js';

const PERIOD_KEYS: readonly string[] = ['from', 'until', 'value'];
const SHAPE = 'a period { from, until, value }';

/** One period read and found well formed, with its index in the fact. */
interface Span {
  index: number;
  from: CivilDate;
  until: CivilDate | null;
  /** The encoding of its value (`walkJson`), `undefined` when the value has a problem. */
  value: string | undefined;
}

/**
 * Checks a temporal fact (`TemporalValue[]`) without throwing, and returns every problem found.
 * Every path is a JSON pointer below `path`, the pointer of the fact (`/salaire`): a period is
 * `/salaire/1`, its fields `/salaire/1/until`, a value inside it `/salaire/1/value/n` (D-1).
 *
 * Each period is `{ from, until, value }`, all three present: `from` a civil date, `until` a
 * civil date after `from` or `null` (no end), `value` plain JSON as in `data` (no number of
 * absolute value 2^53 or more, no lone surrogate, at most 1000 levels deep). Periods are sorted
 * by `from` (`/salaire/1 must start after /salaire/0: periods are sorted by from`). A period
 * that starts before an earlier one ends is refused (`overlap at /salaire/1`); a gap between
 * periods is allowed (no value then). A period that starts the day the previous one ends with
 * the same value (same canonical form) is refused (`merge adjacent periods with the same value
 * at /salaire/1`): one meaning, one written form. An empty list is refused (`/salaire is empty:
 * omit the fact: an empty history says nothing`): a fact with no value at any date is written by
 * leaving it out.
 *
 * Never throws; each property is read once; the work and the list of issues are bounded as in
 * `validateProofInput` (at most 100 problems, then `further problems not listed (limit 100)`).
 */
export function validateTemporalFact(value: unknown, path: string): RuleValidationIssue[] {
  const at: unknown = path;
  if (typeof at !== 'string') return [pathArgumentIssue(at)];
  return runCheck(
    (reader) => {
      readFact(value, path, reader);
    },
    (error) => ({ path, message: unreadableMessage(path, error) }),
    true,
  ).issues;
}

function readFact(value: unknown, path: string, reader: Reader): void {
  const { add } = reader;
  let list: readonly unknown[] | undefined;
  let length: unknown;
  try {
    if (Array.isArray(value)) {
      list = value;
      length = value.length;
    }
  } catch (error) {
    add(path, unreadableMessage(path, error));
    return;
  }
  // Not a list, or a Proxy announcing an impossible length.
  if (
    list === undefined ||
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    add(path, `${citeName(path)} must be a list of periods { from, until, value }`);
    return;
  }
  if (length === 0) {
    add(path, `${citeName(path)} is empty: omit the fact: an empty history says nothing`);
    return;
  }
  announce(reader, length, path);
  const spans: Span[] = [];
  for (let index = 0; index < length; index++) {
    const at = `${path}/${index}`;
    const read = readElement(list, index, path, add);
    if (read === 'failed') continue;
    const span = readPeriod(read.value, at, reader);
    if (span !== undefined) spans.push({ index, ...span });
  }
  checkOrder(spans, path, reader);
}

/** The bounds of the period at `path`, when they are well formed; every problem is reported. */
function readPeriod(value: unknown, path: string, reader: Reader): Omit<Span, 'index'> | undefined {
  const { add } = reader;
  if (!expectPlainObject(value, path, SHAPE, add)) return undefined;
  const fields = readFields(value, path, path, PERIOD_KEYS, reader);
  if (fields === undefined) return undefined;
  const { values } = fields;
  requireFields(fields, path, ['from'], add);
  const untilPath = childPointer(path, 'until');
  if (!values.has('until') && !fields.failed.has('until')) {
    add(untilPath, `${citeName(untilPath)} is required: null has no end`);
  }
  requireFields(fields, path, ['value'], add);

  const from = values.get('from');
  const fromPath = childPointer(path, 'from');
  if (values.has('from') && !isCivilDate(from)) {
    add(fromPath, `${citeName(fromPath)} must be a civil date YYYY-MM-DD`);
  }
  const until = values.get('until');
  const untilValid = until === null || isCivilDate(until);
  if (values.has('until') && !untilValid) {
    add(untilPath, `${citeName(untilPath)} must be a civil date YYYY-MM-DD or null`);
  }
  const encoding = values.has('value')
    ? walkJson(values.get('value'), childPointer(path, 'value'), reader)
    : undefined;
  if (!isCivilDate(from) || !values.has('until') || !untilValid) return undefined;
  const end = isCivilDate(until) ? until : null;
  if (end !== null && end <= from) {
    add(untilPath, `${citeName(untilPath)} must be after from ${from}: the period is empty`);
    return undefined;
  }
  return { from, until: end, value: encoding };
}

/**
 * Reports each period that starts before the previous well-formed one, each period that starts
 * before the latest end seen so far (an open end never ends), and each period that continues the
 * previous one with the same value.
 */
function checkOrder(spans: readonly Span[], path: string, reader: Reader): void {
  let previous: Span | undefined;
  let end: CivilDate | null | undefined;
  for (const span of spans) {
    const at = `${path}/${span.index}`;
    if (previous !== undefined && span.from < previous.from) {
      reader.add(
        at,
        `${citeName(at)} must start after ${citeName(`${path}/${previous.index}`)}: periods are ` +
          'sorted by from',
      );
    } else if (end !== undefined && (end === null || span.from < end)) {
      reader.add(at, `overlap at ${citeName(at)}`);
    } else if (
      previous !== undefined &&
      previous.until === span.from &&
      previous.value !== undefined &&
      previous.value === span.value
    ) {
      reader.add(at, `merge adjacent periods with the same value at ${citeName(at)}`);
    }
    if (end === undefined || (end !== null && (span.until === null || span.until > end))) {
      end = span.until;
    }
    previous = span;
  }
}
