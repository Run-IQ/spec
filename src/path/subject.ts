import { quoteText, SpecError } from '../errors.js';
import { daysInMonth } from '../rule/date.js';
import { hasLoneSurrogate } from '../values.js';
import { parsePointer, typeName } from './pointer.js';
import type { JsonPointer } from './pointer.js';

/**
 * The subject of a rule instance: a JSON pointer to the collection element (or nested elements)
 * the instance is about, `/foyers/@f1/personnes/@a7`. An element is written `@<key>` (its key,
 * `elementSegment`), never by its index, so a subject is stable when the list is reordered.
 * Two segments starting with `!` are reserved: `!segment=<from>..<until>` (a time segment,
 * civil dates, `from` before `until`) and `!group=<value>` (`groupSegment`). A rule without
 * `forEach` has no subject. What each segment means is given by the rule's `forEach`.
 */
export type Subject = JsonPointer;

/**
 * The segment of a collection element: `@` and its key. A key is a string, or a safe integer
 * written in decimal (`7` and `'7'` are the same key, so the same element): `elementSegment(7)`
 * is `'@7'`. Throws `SpecError` (`INVALID_PATH`) for any other value, and for a string that
 * holds a lone UTF-16 surrogate. `formatPointer` escapes the segment like any other.
 */
export function elementSegment(key: string | number): string {
  return `@${keyText(key, 'an element key')}`;
}

/**
 * The segment of a group (`forEach.groupBy`): `!group=` and the group value, which follows the
 * rule of keys: a string, or a safe integer written in decimal (`42` and `'42'` are the same
 * group). Throws `SpecError` (`INVALID_PATH`) for any other value (a boolean, `null`, a number
 * that is not a safe integer, a list, an object) and for a lone UTF-16 surrogate.
 */
export function groupSegment(value: string | number): string {
  return `!group=${keyText(value, 'a group value')}`;
}

const SEGMENT = /^!segment=(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;
const GROUP_PREFIX = '!group=';

/**
 * True when `value` is a subject, by its syntax only: a non-empty valid JSON pointer whose
 * segments starting with `!` are well-formed reserved segments (`!group=<value>`, or
 * `!segment=<from>..<until>` with two real civil dates, `from` before `until`). Never throws.
 */
export function isSubject(value: unknown): value is Subject {
  if (typeof value !== 'string' || value === '') return false;
  let segments: string[];
  try {
    segments = parsePointer(value);
  } catch {
    return false;
  }
  return segments.every(isSubjectSegment);
}

/**
 * True when `scope` contains `subject`: the segments of `scope` are the first segments of
 * `subject` (`/foyers/@f1` contains `/foyers/@f1/personnes/@a7`, not `/foyers/@f10`). A subject
 * contains itself. Throws `SpecError` (`INVALID_PATH`) when either is not a subject.
 */
export function subjectContains(scope: Subject, subject: Subject): boolean {
  const outer = subjectSegments(scope);
  const inner = subjectSegments(subject);
  return outer.length <= inner.length && outer.every((segment, i) => segment === inner[i]);
}

function subjectSegments(subject: Subject): string[] {
  if (!isSubject(subject)) {
    const text = typeof subject === 'string' ? quoteText(subject) : typeName(subject);
    throw new SpecError('INVALID_PATH', `invalid subject ${text}: not a subject`);
  }
  return parsePointer(subject);
}

function isSubjectSegment(segment: string): boolean {
  if (!segment.startsWith('!')) return true;
  if (segment.startsWith(GROUP_PREFIX)) return true;
  const period = SEGMENT.exec(segment);
  if (!period) return false;
  const [, from, until] = period;
  return (
    from !== undefined &&
    until !== undefined &&
    isRealDate(from) &&
    isRealDate(until) &&
    from < until
  );
}

/** A `YYYY-MM-DD` text (already matched) that names a real day. */
function isRealDate(text: string): boolean {
  const [year, month, day] = text.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** The text of a key or group value, or `SpecError` (`INVALID_PATH`) naming `what`. */
function keyText(value: unknown, what: string): string {
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) {
      throw new SpecError('INVALID_PATH', `${what} contains a lone UTF-16 surrogate`);
    }
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  const got = typeof value === 'number' ? String(value) : typeName(value);
  throw new SpecError('INVALID_PATH', `${what} must be a string or a safe integer, got ${got}`);
}
