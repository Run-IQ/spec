import { describeError, SpecError, unreadableMessage } from '../errors.js';
import { parsePointer } from '../path/pointer.js';
import { isReservedName, reservedDatePointerMessage } from '../reserved.js';
import {
  civilDateIn,
  isCivilDate,
  readReferenceDate,
  requireTimeZone,
  startOfDayIn,
} from '../time/civil.js';
import type { Beyond, CivilCalendar, CivilDate, Instant } from '../time/civil.js';
import { typeName } from '../values.js';
import type { ForEach } from './forEach.js';

/**
 * The validity window of a rule, as `windowContains` reads it: the bounds in any form
 * `toReferenceDate` accepts (a normalized rule holds civil dates or canonical instants), and the
 * rule's own time zone, if any.
 */
export interface RuleWindow {
  readonly effectiveFrom: Date | string;
  readonly effectiveUntil?: Date | string | null | undefined;
  readonly timeZone?: string | null | undefined;
}

/** A window read and checked: bounds as civil dates or canonical instants, zone normalized. */
export interface ResolvedWindow {
  readonly from: CivilDate | Instant;
  readonly until: CivilDate | Instant | null;
  readonly zone: string;
}

const MIXED_FORMS = 'effectiveFrom and effectiveUntil must both be civil dates or both instants';

/**
 * Whether the half-open window `[effectiveFrom, effectiveUntil)` of `rule` contains the
 * reference date `at`, in the rule's `timeZone` when it has one, else in `timeZone` (D-12):
 * - a civil date against civil bounds: compared as civil dates;
 * - an instant against civil bounds: the instant becomes its civil date in the time zone;
 * - an instant against instant bounds: compared as instants;
 * - a civil date against an instant bound: a day wholly before or wholly after the bound is
 *   decided; the day that holds the bound is decided only when the bound is its first instant
 *   (`calendar.startOfDay`), else the answer is `'unknown'`: part of the day is on each side.
 *
 * `effectiveUntil` is EXCLUDED, whatever the form. The calendar is called only to cross forms,
 * and knows the time zones: this function holds no time zone database.
 *
 * Throws `SpecError`: `INVALID_DATE` for an invalid `at`, bound or `timeZone`, or a calendar
 * that fails (see `CivilCalendar`); `INVALID_RULE` for an invalid rule `timeZone`, bounds of
 * two forms (`effectiveFrom and effectiveUntil must both be civil dates or both instants`), an
 * empty window, or a rule that cannot be read.
 */
export function windowContains(
  rule: RuleWindow,
  at: CivilDate | Instant,
  timeZone: string,
  calendar: CivilCalendar,
): boolean | 'unknown' {
  const zone = requireTimeZone(timeZone, 'INVALID_DATE');
  let fields: { from: unknown; until: unknown; timeZone: unknown };
  try {
    fields = { from: rule.effectiveFrom, until: rule.effectiveUntil, timeZone: rule.timeZone };
  } catch (error) {
    throw new SpecError('INVALID_RULE', unreadableMessage('rule', error));
  }
  const window = resolveWindow(fields, zone, '');
  const ref = readReferenceDate(at, 'at');
  let refDay: CivilDate | Beyond | undefined;
  const dayOfRef = (): CivilDate | Beyond => (refDay ??= civilDateIn(calendar, ref, window.zone));

  const from = position(window.from, ref, window.zone, calendar, dayOfRef);
  if (from === 'before') return false;
  const until =
    window.until === null ? 'before' : position(window.until, ref, window.zone, calendar, dayOfRef);
  if (until === 'notBefore') return false;
  return from === 'unknown' || until === 'unknown' ? 'unknown' : true;
}

/**
 * Where `ref` lies against `bound`: `'before'` it, `'notBefore'` (at or after it), or
 * `'unknown'` (a civil day that holds an instant bound which does not start it). A local day
 * outside the years 0000 to 9999 (`BEFORE_ALL`, `AFTER_ALL`) compares as text before, or after,
 * every civil date, so it is decided, never refused.
 */
function position(
  bound: CivilDate | Instant,
  ref: CivilDate | Instant,
  zone: string,
  calendar: CivilCalendar,
  dayOfRef: () => CivilDate | Beyond,
): 'before' | 'notBefore' | 'unknown' {
  const civilBound = isCivilDate(bound);
  if (civilBound === isCivilDate(ref)) return ref < bound ? 'before' : 'notBefore';
  if (civilBound) return dayOfRef() < bound ? 'before' : 'notBefore';
  const day = civilDateIn(calendar, bound, zone);
  if (ref < day) return 'before';
  if (ref > day) return 'notBefore';
  return startOfDayIn(calendar, day, zone) === bound ? 'notBefore' : 'unknown';
}

/**
 * Internal: the window of the fields read from a rule, checked, its zone being the rule's
 * (`null` and absence alike) or `defaultZone`. Messages start with `prefix`.
 */
export function resolveWindow(
  fields: { readonly from: unknown; readonly until: unknown; readonly timeZone: unknown },
  defaultZone: string,
  prefix: string,
): ResolvedWindow {
  return prefixed(prefix, () => {
    const zone =
      fields.timeZone == null ? defaultZone : requireTimeZone(fields.timeZone, 'INVALID_RULE');
    return { ...readRuleWindow(fields.from, fields.until), zone };
  });
}

/** Internal: runs `read`, putting `prefix` before the message of the `SpecError` it throws. */
function prefixed<T>(prefix: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (prefix === '' || !(error instanceof SpecError)) throw error;
    throw new SpecError(error.code, prefix + error.message);
  }
}

/**
 * Internal: the bounds of a rule window, as civil dates or canonical instants (D-13). Throws
 * `SpecError`: `INVALID_DATE` for a bound `toReferenceDate` refuses, `INVALID_RULE` for
 * `windowShapeProblem`.
 */
export function readRuleWindow(
  from: unknown,
  until: unknown,
): { from: CivilDate | Instant; until: CivilDate | Instant | null } {
  const start = readReferenceDate(from, 'effectiveFrom');
  const end = until == null ? null : readReferenceDate(until, 'effectiveUntil');
  const problem = windowShapeProblem(start, end);
  if (problem !== undefined) throw new SpecError('INVALID_RULE', problem);
  return { from: start, until: end };
}

/**
 * Internal: what is wrong with two valid bounds, or `undefined`: bounds of two forms (D-13,
 * pre-flight I7b), or an empty window (`until <= from`). Same-form bounds compare as text.
 */
export function windowShapeProblem(
  from: CivilDate | Instant,
  until: CivilDate | Instant | null,
): string | undefined {
  if (until === null) return undefined;
  if (isCivilDate(from) !== isCivilDate(until)) return MIXED_FORMS;
  if (until > from) return undefined;
  return (
    `effectiveUntil (${until}) must be after effectiveFrom (${from}): ` +
    'the window [effectiveFrom, effectiveUntil) would be empty'
  );
}

/**
 * Internal: the default `effectiveOn`, the decision's reference date. Normalization drops it, so
 * an absent `effectiveOn` and this one are the same rule, with the same checksum.
 */
export const DEFAULT_EFFECTIVE_ON = '/$dates/effective';

const EFFECTIVE_ON_START = 'effectiveOn must start with /$dates/, /$item/ or /$segment/';

/**
 * Internal: `value` as an `effectiveOn`, or `SpecError` (`INVALID_RULE`, the message after
 * `prefix`) naming what is wrong with it (see `effectiveOnIssue`).
 */
export function readEffectiveOn(value: unknown, prefix = ''): string {
  const problem = effectiveOnIssue(value);
  if (problem === undefined && typeof value === 'string') return value;
  throw new SpecError('INVALID_RULE', prefix + (problem ?? ''));
}

/** Internal: `effectiveOnProblem` for any value; a non-string is not a pointer. */
export function effectiveOnIssue(value: unknown): string | undefined {
  return typeof value === 'string'
    ? effectiveOnProblem(value)
    : `effectiveOn must be a JSON pointer: got a value of type ${typeName(value)}`;
}

/**
 * Internal: what is wrong with `value` as an `effectiveOn`, or `undefined`. It must be a JSON
 * pointer (RFC 6901) to a reference date: one named date `/$dates/<name>`, a field of the
 * current item `/$item/<path>`, or the start of the current segment `/$segment/from`. A `-`
 * segment is refused, as in every read (D-1).
 */
export function effectiveOnProblem(value: string): string | undefined {
  let segments: string[];
  try {
    segments = parsePointer(value);
  } catch (error) {
    return `effectiveOn must be a JSON pointer: ${describeError(error)}`;
  }
  const [head, ...rest] = segments;
  if (head !== '$dates' && head !== '$item' && head !== '$segment') return EFFECTIVE_ON_START;
  if (rest.includes('-')) return "effectiveOn must not hold a '-' segment: '-' is not an index";
  if (head === '$dates') {
    if (rest.length === 1 && isReservedName(rest[0] ?? '')) {
      return reservedDatePointerMessage('effectiveOn');
    }
    return rest.length === 1 && rest[0] !== ''
      ? undefined
      : 'effectiveOn must name one date: /$dates/<name>';
  }
  if (head === '$item') {
    return rest.length > 0 ? undefined : 'effectiveOn must name a field of the item: /$item/<path>';
  }
  return rest.length === 1 && rest[0] === 'from'
    ? undefined
    : 'effectiveOn must be /$segment/from to read a segment';
}

/**
 * Internal: what is wrong with a valid `effectiveOn` given the rule's valid `forEach` (absent:
 * `undefined`), or `undefined`: `$item` needs a collection that gives one item per instance (a
 * `forEach` with `path` and without `groupBy`), `$segment` needs `forEach.segments`.
 */
export function effectiveOnContextProblem(
  pointer: string,
  forEach: ForEach | undefined,
): string | undefined {
  if (pointer.startsWith('/$item/')) {
    if (forEach === undefined) return 'effectiveOn reads $item without forEach';
    if ('segments' in forEach) {
      return 'effectiveOn reads $item without forEach.path: a segment has no item';
    }
    return forEach.groupBy === undefined
      ? undefined
      : 'effectiveOn reads $item with forEach.groupBy: a group has no single item';
  }
  if (pointer.startsWith('/$segment/')) {
    return forEach !== undefined && 'segments' in forEach
      ? undefined
      : 'effectiveOn reads $segment without segments';
  }
  return undefined;
}
