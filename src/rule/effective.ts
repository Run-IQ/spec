import { newSpecError } from '../errors.js';
import { fixedOffsetCalendar, readReferenceDate } from '../time/civil.js';
import { dateTimeOf, notADateMessage } from '../values.js';
import { windowContains } from './window.js';
import type { RuleWindow } from './window.js';

const OFFSETS_ONLY = fixedOffsetCalendar('isEffectiveAt');

/**
 * Whether the half-open window `[effectiveFrom, effectiveUntil)` of `rule` contains the instant
 * `at`: `windowContains` with the default time zone `UTC` (D-12). A civil bound is compared with
 * the civil date of `at` in the rule's `timeZone`, else in `UTC`; `effectiveUntil` is EXCLUDED.
 *
 * Without a time zone database, it knows `UTC` and fixed offsets `±HH:MM` only: a rule with
 * civil bounds and an IANA `timeZone` throws `SpecError` (`INVALID_DATE`); use `windowContains`
 * with a calendar. Bounds accept the forms of `normalizeRuleDefinition`. Throws `SpecError`
 * (`INVALID_DATE`) for an invalid date and as `windowContains` does.
 */
export function isEffectiveAt(rule: RuleWindow, at: Date): boolean {
  let time: number | undefined;
  let named: string | undefined;
  try {
    time = dateTimeOf(at);
    // A Date under another prototype is named, with its pointer text, like everywhere else.
    if (time === undefined) named = notADateMessage(at);
  } catch {
    time = undefined;
  }
  if (time === undefined || Number.isNaN(time)) {
    throw newSpecError('INVALID_DATE', named ?? 'at must be a valid Date');
  }
  // An instant is never 'unknown': only a civil date can fall inside a day cut by a bound.
  return windowContains(rule, readReferenceDate(at, 'at'), 'UTC', OFFSETS_ONLY) === true;
}
