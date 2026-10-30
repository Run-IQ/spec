import { SpecError } from '../errors.js';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses a rule date. Accepted forms only:
 * - a valid `Date`;
 * - `YYYY-MM-DD`, read as UTC midnight;
 * - an ISO 8601 date-time WITH `Z` or a `±HH:MM` offset (seconds and fraction optional).
 *
 * Anything else throws `SpecError` (`INVALID_DATE`), including a date-time without a time
 * zone, whose meaning would depend on the machine's time zone.
 */
export function parseRuleDate(value: unknown, field: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) invalid(field, 'an invalid Date');
    return new Date(value.getTime());
  }
  if (typeof value !== 'string') invalid(field, `a value of type ${typeof value}`);

  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) return build(value, field, dateOnly.slice(1, 4), [], 'Z');

  const dateTime = DATE_TIME.exec(value);
  if (dateTime) {
    const [, y, mo, d, h, mi, s, frac, zone] = dateTime;
    return build(
      value,
      field,
      [y, mo, d],
      [h, mi, s ?? '0', (frac ?? '').padEnd(3, '0').slice(0, 3)],
      zone ?? 'Z',
    );
  }
  return invalid(field, JSON.stringify(value));
}

function build(
  raw: string,
  field: string,
  date: (string | undefined)[],
  time: (string | undefined)[],
  zone: string,
): Date {
  const [year, month, day] = date.map(Number) as [number, number, number];
  const [hour = 0, minute = 0, second = 0, ms = 0] = time.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    invalid(field, JSON.stringify(raw));
  }
  if (hour > 23 || minute > 59 || second > 59) invalid(field, JSON.stringify(raw));

  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) invalid(field, JSON.stringify(raw));
    offsetMinutes = sign * (oh * 60 + om);
  }

  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(hour, minute - offsetMinutes, second, ms);
  if (Number.isNaN(result.getTime())) invalid(field, JSON.stringify(raw));
  return result;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function invalid(field: string, what: string): never {
  throw new SpecError(
    'INVALID_DATE',
    `${field} must be a Date, YYYY-MM-DD, or an ISO date-time with Z or an offset; got ${what}`,
  );
}
