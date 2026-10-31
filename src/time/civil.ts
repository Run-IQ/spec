import { describeError, escapeText, quoteText, SpecError } from '../errors.js';
import { dateTimeOf, typeName } from '../values.js';

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
 * Both are called with a valid, normalized time zone (`UTC`, `±HH:MM` or an IANA name).
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
const MIN_TIME = new Date(0).setUTCFullYear(0, 0, 1);
const MAX_TIME = new Date(0).setUTCFullYear(9999, 11, 31) + 86_400_000 - 1;

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
    return new Date(time).toISOString();
  }
  if (typeof value !== 'string') invalidDate(field, `a value of type ${typeName(value)}`);
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
  const instant = new Date(0);
  instant.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  instant.setUTCHours(
    Number(hour),
    Number(minute) - offset,
    Number(second),
    Number((fraction ?? '').padEnd(3, '0')),
  );
  const result = instant.getTime();
  if (result < MIN_TIME || result > MAX_TIME) {
    invalidDate(field, `${quoteText(value)}, outside the years 0000 to 9999 in UTC`);
  }
  return instant.toISOString();
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
  throw new SpecError(
    'INVALID_DATE',
    `${field} must be a Date, a civil date YYYY-MM-DD or an instant ` +
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
    throw new SpecError(code, prefix + timeZoneMessage(zone));
  }
  return normalizeTimeZone(zone);
}

/**
 * Internal: `calendar.toCivilDate(at, zone)`, checked. Whatever goes wrong becomes `SpecError`
 * (`INVALID_DATE`): a missing method, a throw (a `SpecError` it throws is kept), a result that
 * is not a civil date.
 */
export function civilDateIn(calendar: CivilCalendar, at: Instant, zone: string): CivilDate {
  const day = callCalendar(calendar, 'toCivilDate', at, zone);
  if (!isCivilDate(day)) {
    throw new SpecError(
      'INVALID_DATE',
      `calendar.toCivilDate returned ${describeResult(day)} for ${at} in ${zone}: ` +
        'not a civil date YYYY-MM-DD',
    );
  }
  return day;
}

/** Internal: `calendar.startOfDay(day, zone)`, checked like `civilDateIn`. */
export function startOfDayIn(calendar: CivilCalendar, day: CivilDate, zone: string): Instant {
  const start = callCalendar(calendar, 'startOfDay', day, zone);
  if (!isInstant(start)) {
    throw new SpecError(
      'INVALID_DATE',
      `calendar.startOfDay returned ${describeResult(start)} for ${day} in ${zone}: ` +
        'not a canonical instant YYYY-MM-DDTHH:MM:SS.sssZ',
    );
  }
  return start;
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
      throw new SpecError('INVALID_DATE', `calendar.${method} must be a function`);
    }
    return (call as (v: string, z: string) => unknown).call(calendar, value, zone);
  } catch (error) {
    if (error instanceof SpecError) throw error;
    throw new SpecError(
      'INVALID_DATE',
      `calendar.${method} failed for ${value} in ${zone}: ${escapeText(describeError(error))}`,
    );
  }
}

function describeResult(value: unknown): string {
  return typeof value === 'string' ? quoteText(value) : `a value of type ${typeName(value)}`;
}

/**
 * Internal: a calendar for `UTC` and fixed offsets `±HH:MM` only, exact without any time zone
 * database. An IANA name throws `SpecError` (`INVALID_DATE`) naming `user`, which needs a real
 * calendar. A civil date outside the years 0000 to 9999 throws too.
 */
export function fixedOffsetCalendar(user: string): CivilCalendar {
  const offsetOf = (zone: string): number => {
    const offset = zone === 'UTC' ? 0 : offsetMinutes(zone);
    if (offset === undefined) {
      throw new SpecError(
        'INVALID_DATE',
        `${user} knows UTC and ±HH:MM offsets only: use windowContains with a calendar ` +
          `for ${quoteText(zone)}`,
      );
    }
    return offset * 60_000;
  };
  return {
    toCivilDate: (at, zone) => {
      const local = Date.parse(at) + offsetOf(zone);
      if (local < MIN_TIME || local > MAX_TIME) {
        throw new SpecError('INVALID_DATE', `${at} in ${zone} is outside the years 0000 to 9999`);
      }
      return new Date(local).toISOString().slice(0, 10);
    },
    startOfDay: (day, zone) => {
      const start = Date.parse(`${day}T00:00:00.000Z`) - offsetOf(zone);
      if (start < MIN_TIME || start > MAX_TIME) {
        throw new SpecError(
          'INVALID_DATE',
          `the start of ${day} in ${zone} is outside the years 0000 to 9999`,
        );
      }
      return new Date(start).toISOString();
    },
  };
}
