import { unreadableMessage } from '../errors.js';
import type { RuleValidationIssue } from '../rule/validate.js';
import { isCivilDate } from '../time/civil.js';
import type { CivilDate } from '../time/civil.js';
import {
  announce,
  cite,
  createReader,
  expectPlainObject,
  InputTooLarge,
  readFields,
  readMember,
  requireFields,
  walkJson,
} from './read.js';
import type { Reader } from './read.js';

const PERIOD_KEYS: readonly string[] = ['from', 'until', 'value'];
const SHAPE = 'a period { from, until, value }';

/** A field of the period at `path`: `/salaire[0].from`. */
const fieldPath = (path: string, key: string): string => `${path}.${key}`;

/** One period read and found well formed, with its index in the fact. */
interface Span {
  index: number;
  from: CivilDate;
  until: CivilDate | null;
}

/**
 * Checks a temporal fact (`TemporalValue[]`) without throwing, and returns every problem found.
 * `path` names the fact as the caller writes it (`/salaire`); a period is `<path>[i]`, its fields
 * `<path>[i].from`, and a value inside it `<path>[i].value/<pointer>`.
 *
 * Each period is `{ from, until, value }`, all three present: `from` a civil date, `until` a
 * civil date after `from` or `null` (no end), `value` plain JSON as in `data` (no number of
 * absolute value 2^53 or more, no lone surrogate, at most 1000 levels deep). Periods are sorted
 * by `from` (`<path>[1] must start after <path>[0]: periods are sorted by from`): one meaning,
 * one written form. A period that starts before an earlier one ends is refused
 * (`overlap at <path>[i]`); a gap between periods is allowed (no value then). An empty list is
 * a fact with no value at any date.
 *
 * Never throws; each property is read once; the work is bounded as in `validateProofInput`.
 */
export function validateTemporalFact(value: unknown, path: string): RuleValidationIssue[] {
  const issues: RuleValidationIssue[] = [];
  const reader = createReader((at, message) => {
    issues.push({ path: at, message });
  });
  try {
    readFact(value, path, reader);
  } catch (error) {
    if (error instanceof InputTooLarge) issues.push({ path: error.path, message: error.message });
    else issues.push({ path, message: unreadableMessage(cite(path), error) });
  }
  return issues;
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
    add(path, unreadableMessage(cite(path), error));
    return;
  }
  // Not a list, or a Proxy announcing an impossible length.
  if (
    list === undefined ||
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    add(path, `${cite(path)} must be a list of periods { from, until, value }`);
    return;
  }
  announce(reader, length, path);
  const spans: Span[] = [];
  for (let index = 0; index < length; index++) {
    const at = `${path}[${index}]`;
    const read = readMember(list, index, at, add);
    if (read === 'failed') continue;
    const from = readPeriod(read.value, at, reader);
    if (from !== undefined) spans.push({ index, ...from });
  }
  checkOrder(spans, path, reader);
}

/** The bounds of the period at `path`, when they are well formed; every problem is reported. */
function readPeriod(
  value: unknown,
  path: string,
  reader: Reader,
): { from: CivilDate; until: CivilDate | null } | undefined {
  const { add } = reader;
  if (!expectPlainObject(value, path, SHAPE, add)) return undefined;
  const fields = readFields(value, path, path, PERIOD_KEYS, reader, { join: fieldPath });
  if (fields === undefined) return undefined;
  const { values } = fields;
  requireFields(fields, path, ['from'], add, fieldPath);
  const untilPath = fieldPath(path, 'until');
  if (!values.has('until') && !fields.failed.has('until')) {
    add(untilPath, `${cite(untilPath)} is required: null has no end`);
  }
  requireFields(fields, path, ['value'], add, fieldPath);

  const from = values.get('from');
  const fromPath = fieldPath(path, 'from');
  if (values.has('from') && !isCivilDate(from)) {
    add(fromPath, `${cite(fromPath)} must be a civil date YYYY-MM-DD`);
  }
  const until = values.get('until');
  const untilValid = until === null || isCivilDate(until);
  if (values.has('until') && !untilValid) {
    add(untilPath, `${cite(untilPath)} must be a civil date YYYY-MM-DD or null`);
  }
  if (values.has('value')) walkJson(values.get('value'), fieldPath(path, 'value'), reader);
  if (!isCivilDate(from) || !values.has('until') || !untilValid) return undefined;
  const end = isCivilDate(until) ? until : null;
  if (end !== null && end <= from) {
    add(untilPath, `${cite(untilPath)} must be after from ${from}: the period is empty`);
    return undefined;
  }
  return { from, until: end };
}

/**
 * Reports each period that starts before the previous well-formed one, and each period that
 * starts before the latest end seen so far (an open end never ends).
 */
function checkOrder(spans: readonly Span[], path: string, reader: Reader): void {
  let previous: Span | undefined;
  let end: CivilDate | null | undefined;
  for (const span of spans) {
    const at = `${path}[${span.index}]`;
    if (previous !== undefined && span.from < previous.from) {
      reader.add(
        at,
        `${cite(at)} must start after ${cite(`${path}[${previous.index}]`)}: periods are ` +
          'sorted by from',
      );
    } else if (end !== undefined && (end === null || span.from < end)) {
      reader.add(at, `overlap at ${cite(at)}`);
    }
    if (end === undefined || (end !== null && (span.until === null || span.until > end))) {
      end = span.until;
    }
    previous = span;
  }
}
