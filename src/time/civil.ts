import { citeName, isOwnError, newSpecError, quoteText, reasonOf } from '../errors.js';
import { isoOf, parseTime, startOfYear, utcTime } from '../intrinsics.js';
import { dateTimeOf, notADateMessage, typeName } from '../values.js';

/**
 * A civil date: a day of the calendar, `YYYY-MM-DD` (proleptic Gregorian, years 0000 to 9999),
 * with no time and no time zone. It names a different span of instants in each time zone.
 */
export type CivilDate = string;

/**
 * An instant: one point in time, written in its canonical form `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC,
 * always three decimals, years 0000 to 9999). Two equal instants have the same text, and the
 * text order is the time order.
 */
export type Instant = string;

/**
 * Turns civil dates and instants into each other in a time zone. `@run-iq/spec` holds no time
 * zone database: `core` passes one (its `TimeZoneResolver`), and a test passes its own.
 *
 * - `toCivilDate(at, zone)`: the civil date of the instant `at` in `zone`.
 * - `startOfDay(day, zone)`: the FIRST instant of the civil day `day` in `zone`. It is local
 *   midnight, except on a day where midnight does not exist (a change to summer time at 00:00,
 *   as in Chile): then it is the first local time that exists (01:00). For a day skipped as a
 *   whole (Samoa, 2011-12-30), it is the start of the next day that exists.
 *
 * Both are called with a valid, normalized time zone (`UTC`, `±HH:MM` or an IANA name). Near
 * the ends of the years 0000 to 9999, the answer can fall outside them (`0000-01-01T00:30Z` is
 * -0001-12-31 in `-01:00`): write it in the expanded ISO 8601 form `Date.prototype.toISOString`
 * uses (`-000001-12-31`, `-000001-12-31T23:00:00.000Z`, `+010000-01-01`). It is then before, or
 * after, every civil date and instant of the years 0000 to 9999.
 */
export interface CivilCalendar {
  toCivilDate(at: Instant, timeZone: string): CivilDate;
  startOfDay(day: CivilDate, timeZone: string): Instant;
}

const CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const CANONICAL_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/;
const OFFSET = /^([+-])(\d{2}):(\d{2})$/;
const IANA_NAME = /^[A-Z][A-Za-z0-9_+-]*(?:\/[A-Za-z][A-Za-z0-9_+-]*)+$/;

/** Time values of 0000-01-01T00:00:00.000Z and of 9999-12-31T23:59:59.999Z. */
const MIN_TIME = startOfYear(0, 0, 1);
const MAX_TIME = startOfYear(9999, 11, 31) + 86_400_000 - 1;

/** Internal: the number of days of `month` (1 to 12) in `year`, proleptic Gregorian calendar. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isRealDay(year: string, month: string, day: string): boolean {
  const m = Number(month);
  const d = Number(day);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(Number(year), m);
}

/** True when `value` is a civil date `YYYY-MM-DD` that exists. Never throws. */
export function isCivilDate(value: unknown): value is CivilDate {
  if (typeof value !== 'string') return false;
  const match = CIVIL.exec(value);
  return match !== null && isRealDay(match[1] ?? '', match[2] ?? '', match[3] ?? '');
}

/**
 * True when `value` is an instant in its canonical form `YYYY-MM-DDTHH:MM:SS.sssZ`, the form
 * `toReferenceDate` writes. `2026-01-01T00:00:00Z` is a valid date-time, but not canonical:
 * false. Never throws.
 */
export function isInstant(value: unknown): value is Instant {
  if (typeof value !== 'string') return false;
  const match = CANONICAL_INSTANT.exec(value);
  if (match === null) return false;
  const [, year = '', month = '', day = '', hour, minute, second] = match;
  return (
    isRealDay(year, month, day) &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59
  );
}

/**
 * The reference date of `value`, as a rule window compares it:
 * - a civil date `YYYY-MM-DD` stays a civil date;
 * - a date-time `YYYY-MM-DDTHH:MM:SS`, with 1 to 3 decimals or none, and `Z` or `±HH:MM`
 *   (uppercase `T` and `Z`, second 00 to 59, offset hour at most 23 and minute at most 59)
 *   becomes the canonical instant `YYYY-MM-DDTHH:MM:SS.sssZ`;
 * - a valid `Date`, from any realm, becomes the canonical instant.
 *
 * Throws `SpecError` (`INVALID_DATE`) for anything else: a date-time without a time zone (its
 * meaning would depend on the machine), a lowercase `t` or `z`, 4 decimals or more, a leap
 * second, a day that does not exist, a year outside 0000 to 9999 (before or after the offset
 * is applied), an invalid `Date`, a non-string. Nothing is truncated or rounded.
 */
export function toReferenceDate(value: Date | string): CivilDate | Instant {
  return readReferenceDate(value, 'a reference date');
}

/** Internal: `toReferenceDate`, whose message names `field`. */
export function readReferenceDate(value: unknown, field: string): CivilDate | Instant {
  let time: number | undefined;
  try {
    time = dateTimeOf(value);
  } catch {
    // A revoked Proxy throws even on `Object.prototype.toString`.
    invalidDate(field, 'an unreadable value');
  }
  if (time !== undefined) {
    if (Number.isNaN(time)) invalidDate(field, 'an invalid Date');
    if (time < MIN_TIME || time > MAX_TIME) {
      invalidDate(field, 'a Date outside the years 0000 to 9999');
    }
    return isoOf(time);
  }
  if (typeof value !== 'string') {
    invalidDate(field, notADateMessage(value) ?? `a value of type ${typeName(value)}`);
  }
  if (isCivilDate(value)) return value;

  const match = DATE_TIME.exec(value);
  if (match === null) invalidDate(field, quoteText(value));
  const [, year = '', month = '', day = '', hour, minute, second, fraction, zone = 'Z'] = match;
  const offset = zone === 'Z' ? 0 : offsetMinutes(zone);
  if (
    !isRealDay(year, month, day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    offset === undefined
  ) {
    invalidDate(field, quoteText(value));
  }
  const result = utcTime(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute) - offset,
    Number(second),
    Number((fraction ?? '').padEnd(3, '0')),
  );
  if (result < MIN_TIME || result > MAX_TIME) {
    invalidDate(field, `${quoteText(value)}, outside the years 0000 to 9999 in UTC`);
  }
  return isoOf(result);
}

/** Minutes east of UTC of a `±HH:MM` offset (hour at most 23, minute at most 59), else none. */
function offsetMinutes(offset: string): number | undefined {
  const match = OFFSET.exec(offset);
  if (match === null) return undefined;
  const [, sign, hours, minutes] = match;
  if (Number(hours) > 23 || Number(minutes) > 59) return undefined;
  return (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
}

function invalidDate(field: string, got: string): never {
  throw newSpecError(
    'INVALID_DATE',
    `${citeName(field)} must be a Date, a civil date YYYY-MM-DD or an instant ` +
      'YYYY-MM-DDTHH:MM:SS[.sss] with Z or ±HH:MM, in the years 0000 to 9999; ' +
      `got ${got}`,
  );
}

/**
 * True for a time zone a rule may name: `UTC`; a fixed offset `±HH:MM` (hour at most 23, minute
 * at most 59); or an IANA name `Area/Location[/…]`, whose segments are `[A-Za-z][A-Za-z0-9_+-]*`
 * and whose first segment starts with an uppercase letter (`Europe/Paris`, `Etc/GMT+5`,
 * `America/Port-au-Prince`). Only the syntax is checked: whether an IANA name exists is the
 * calendar's business (`core`'s resolver). Never throws.
 */
export function isTimeZone(zone: unknown): boolean {
  if (typeof zone !== 'string') return false;
  return zone === 'UTC' || offsetMinutes(zone) !== undefined || IANA_NAME.test(zone);
}

/**
 * The one spelling of a time zone: `+00:00` and `-00:00` are written `UTC`; any other zone is
 * returned unchanged, valid or not (check it with `isTimeZone`). One spelling, one checksum.
 */
export function normalizeTimeZone(zone: string): string {
  return zone === '+00:00' || zone === '-00:00' ? 'UTC' : zone;
}

/** Internal: the message refusing the time zone `value`. */
export function timeZoneMessage(value: unknown): string {
  const got = typeof value === 'string' ? quoteText(value) : `a value of type ${typeName(value)}`;
  return `timeZone must be UTC, ±HH:MM or an IANA name Area/Location; got ${got}`;
}

/**
 * Internal: the normalized time zone `zone`, or `SpecError` (`code`) naming `timeZone`.
 */
export function requireTimeZone(
  zone: unknown,
  code: 'INVALID_DATE' | 'INVALID_RULE',
  prefix = '',
): string {
  if (typeof zone !== 'string' || !isTimeZone(zone)) {
    throw newSpecError(code, prefix + timeZoneMessage(zone));
  }
  return normalizeTimeZone(zone);
}

/**
 * Internal: a day or an instant outside the years 0000 to 9999, as the calendar functions below
 * give it: `''` is before every civil date and every canonical instant, `'~'` after every one,
 * so the text order of comparisons stays the time order.
 */
export const BEFORE_ALL = '';
export const AFTER_ALL = '~';
export type Beyond = typeof BEFORE_ALL | typeof AFTER_ALL;

const EXPANDED_DATE = /^([+-])(\d{6})-(\d{2})-(\d{2})$/;
const EXPANDED_INSTANT = /^([+-])(\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/;

/**
 * `''` or `'~'` for a well-formed expanded ISO text (a day that exists, a time of day with
 * hour at most 23, minute and second at most 59) whose year really is outside 0000 to 9999.
 */
function beyondOf(value: unknown, form: RegExp): Beyond | undefined {
  if (typeof value !== 'string') return undefined;
  const match = form.exec(value);
  if (match === null) return undefined;
  const [, sign = '', digits = '', month = '', day = '', hour, minute, second] = match;
  const year = `${sign}${digits}`;
  if (!isRealDay(year, month, day)) return undefined;
  if (Number(hour ?? 0) > 23 || Number(minute ?? 0) > 59 || Number(second ?? 0) > 59) {
    return undefined;
  }
  const yearNumber = Number(year);
  return yearNumber < 0 ? BEFORE_ALL : yearNumber > 9999 ? AFTER_ALL : undefined;
}

/**
 * Internal: `calendar.toCivilDate(at, zone)`, checked: a civil date, or `BEFORE_ALL` /
 * `AFTER_ALL` for an expanded date outside the years 0000 to 9999. Whatever goes wrong becomes
 * `SpecError` (`INVALID_DATE`): a missing method, a throw (an error of this package keeps its
 * message; any other, a `SpecError` the calendar built included, is cited), a result that is
 * neither.
 */
export function civilDateIn(
  calendar: CivilCalendar,
  at: Instant,
  zone: string,
): CivilDate | Beyond {
  const day = callCalendar(calendar, 'toCivilDate', at, zone);
  if (isCivilDate(day)) return day;
  const beyond = beyondOf(day, EXPANDED_DATE);
  if (beyond !== undefined) return beyond;
  throw newSpecError(
    'INVALID_DATE',
    `calendar.toCivilDate returned ${describeResult(day)} for ${citeName(at)} in ` +
      `${citeName(zone)}: ` +
      'not a civil date YYYY-MM-DD',
  );
}

/** Internal: `calendar.startOfDay(day, zone)`, checked like `civilDateIn`. */
export function startOfDayIn(
  calendar: CivilCalendar,
  day: CivilDate,
  zone: string,
): Instant | Beyond {
  const start = callCalendar(calendar, 'startOfDay', day, zone);
  if (isInstant(start)) return start;
  const beyond = beyondOf(start, EXPANDED_INSTANT);
  if (beyond !== undefined) return beyond;
  throw newSpecError(
    'INVALID_DATE',
    `calendar.startOfDay returned ${describeResult(start)} for ${citeName(day)} in ` +
      `${citeName(zone)}: ` +
      'not a canonical instant YYYY-MM-DDTHH:MM:SS.sssZ',
  );
}

/** Internal: the civil date after `day`, or `AFTER_ALL` after 9999-12-31. */
export function nextCivilDate(day: CivilDate): CivilDate | Beyond {
  if (day === '9999-12-31') return AFTER_ALL;
  return isoOf(parseTime(`${day}T00:00:00.000Z`) + 86_400_000).slice(0, 10);
}

function callCalendar(
  calendar: CivilCalendar,
  method: 'toCivilDate' | 'startOfDay',
  value: string,
  zone: string,
): unknown {
  try {
    const call: unknown = calendar[method];
    if (typeof call !== 'function') {
      throw newSpecError('INVALID_DATE', `calendar.${method} must be a function`);
    }
    return (call as (v: string, z: string) => unknown).call(calendar, value, zone);
  } catch (error) {
    // An error of this package keeps its message, under the calendar's code; a SpecError the
    // calendar built is cited like any other throw.
    if (isOwnError(error)) throw newSpecError('INVALID_DATE', error.message);
    throw newSpecError(
      'INVALID_DATE',
      `calendar.${method} failed for ${citeName(value)} in ${citeName(zone)}: ${reasonOf(error)}`,
    );
  }
}

function describeResult(value: unknown): string {
  return typeof value === 'string' ? quoteText(value) : `a value of type ${typeName(value)}`;
}

/**
 * Internal: a calendar for `UTC` and fixed offsets `±HH:MM` only, exact without any time zone
 * database. An IANA name throws `SpecError` (`INVALID_DATE`) naming `user`, which needs a real
 * calendar. Outside the years 0000 to 9999 it answers in the expanded ISO form.
 */
export function fixedOffsetCalendar(user: string): CivilCalendar {
  const offsetOf = (zone: string): number => {
    const offset = zone === 'UTC' ? 0 : offsetMinutes(zone);
    if (offset === undefined) {
      throw newSpecError(
        'INVALID_DATE',
        `${citeName(user)} knows UTC and ±HH:MM offsets only: use windowContains with a calendar ` +
          `for ${quoteText(zone)}`,
      );
    }
    return offset * 60_000;
  };
  return {
    toCivilDate: (at, zone) => isoOf(parseTime(at) + offsetOf(zone)).split('T')[0] ?? '',
    startOfDay: (day, zone) => isoOf(parseTime(`${day}T00:00:00.000Z`) - offsetOf(zone)),
  };
}
