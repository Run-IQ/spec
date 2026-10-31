import { quoteText, SpecError } from '../errors.js';
import { daysInMonth } from '../time/civil.js';
import { dateTimeOf } from '../values.js';

export { daysInMonth };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses a date of a decision PROOF (`evaluatedAt`, `sealedAt`), in the grammar rule dates had
 * before civil time: Task 9J gives proofs the reference dates of rules. Rule windows read their
 * bounds with `toReferenceDate` (`time/civil.ts`), which keeps a civil date civil (D-13).
 * Accepted forms only:
 * - a valid `Date`, from any realm;
 * - `YYYY-MM-DD`, read as UTC midnight;
 * - an ISO 8601 date-time WITH `Z` or a `±HH:MM` offset (seconds and fraction optional).
 *   Fractional seconds take 1 to 9 digits; digits beyond the millisecond are TRUNCATED, not
 *   rounded (`.123456` → `.123`), because `Date` and the canonical ISO form stop at the
 *   millisecond and databases such as Postgres emit microseconds.
 *
 * Anything else throws `SpecError` (`INVALID_DATE`), including a date-time without a time
 * zone, whose meaning would depend on the machine's time zone.
 */
export function parseRuleDate(value: unknown, field: string): Date {
  const time = dateTimeOf(value);
  if (time !== undefined) {
    if (Number.isNaN(time)) invalid(field, 'an invalid Date');
    return new Date(time);
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
  return invalid(field, quoteText(value));
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
    invalid(field, quoteText(raw));
  }
  if (hour > 23 || minute > 59 || second > 59) invalid(field, quoteText(raw));

  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) invalid(field, quoteText(raw));
    offsetMinutes = sign * (oh * 60 + om);
  }

  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(hour, minute - offsetMinutes, second, ms);
  if (Number.isNaN(result.getTime())) invalid(field, quoteText(raw));
  return result;
}

function invalid(field: string, what: string): never {
  throw new SpecError(
    'INVALID_DATE',
    `${field} must be a Date, YYYY-MM-DD, or an ISO date-time with Z or an offset; got ${what}`,
  );
}
