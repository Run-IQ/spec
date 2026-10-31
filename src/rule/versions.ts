import { escapeText, SpecError, unreadableMessage } from '../errors.js';
import {
  civilDateIn,
  isCivilDate,
  nextCivilDate,
  requireTimeZone,
  startOfDayIn,
} from '../time/civil.js';
import type { Beyond, CivilCalendar, CivilDate, Instant } from '../time/civil.js';
import { hasLoneSurrogate, loneSurrogateMessage, typeName } from '../values.js';
import { isRuleVersion } from './definition.js';
import { DEFAULT_EFFECTIVE_ON, readEffectiveOn, resolveWindow } from './window.js';
import type { ResolvedWindow, RuleWindow } from './window.js';

/** One rule version as `findOverlappingVersions` reads it. */
export interface VersionedRuleWindow extends RuleWindow {
  readonly id: string;
  readonly version: number;
  /** The rule set; absent or `null` is `'local'`. */
  readonly ruleSet?: string | null | undefined;
  readonly effectiveOn?: string | null | undefined;
}

/**
 * Two versions of one rule (same rule set, same `id`) that cannot coexist (D-31): their windows
 * overlap (`'overlap'`), or they read different reference dates (`'effectiveOn'`).
 */
export interface VersionOverlap {
  ruleSet: string;
  id: string;
  /** The two versions, smaller first. */
  versions: [number, number];
  kind: 'overlap' | 'effectiveOn';
}

interface Version {
  readonly version: number;
  readonly window: ResolvedWindow;
  readonly effectiveOn: string | undefined;
}

/**
 * The pairs of versions of a rule that cannot coexist (D-31), sorted by `ruleSet`, `id`, then
 * versions (UTF-16 code unit order for texts). Rules are grouped by (`ruleSet`, `id`), an
 * absent rule set being `'local'`: the same `id` in two rule sets is two rules. Within a group,
 * every pair is checked (the cost is quadratic in the versions of one `id` only):
 * - two different `effectiveOn` (absent and the default `/$dates/effective` are the same):
 *   `'effectiveOn'`, since the windows of versions that read different dates cannot be compared;
 * - else two windows that can both be true on some reference date: `'overlap'`. Each version
 *   keeps its own time zone (its `timeZone`, else `timeZone`). Windows of one form and one time
 *   zone compare directly (civil dates, or instants). Otherwise the pair overlaps when the
 *   windows share an instant (a civil bound being its `startOfDay` in its version's time zone,
 *   D-13) or a civil day on which each is wholly true in its own time zone (an instant window
 *   `[a, b)` covers the days from the day of `a`, or the next one when `a` does not start it,
 *   to the day of `b`, excluded). Days and instants outside the years 0000 to 9999 are decided.
 *
 * Throws `SpecError`: `INVALID_DATE` for an invalid `timeZone`, a bound `toReferenceDate`
 * refuses or a calendar that fails; `INVALID_RULE` for a list that is not an array or cannot be
 * read, a rule with an invalid `id`, `version`, `ruleSet`, `timeZone` or `effectiveOn`, bounds
 * of two forms, an empty window, or the same (`ruleSet`, `id`, `version`) twice
 * (`duplicate rule R1@1`). Messages about one rule start with `rule <id>@<version>: `.
 */
export function findOverlappingVersions(
  rules: ReadonlyArray<VersionedRuleWindow>,
  timeZone: string,
  calendar: CivilCalendar,
): VersionOverlap[] {
  const zone = requireTimeZone(timeZone, 'INVALID_DATE');
  const found: VersionOverlap[] = [];
  for (const [ruleSet, ids] of readGroups(rules, zone)) {
    for (const [id, versions] of ids) {
      for (const [i, a] of versions.entries()) {
        for (const b of versions.slice(i + 1)) {
          const kind =
            a.effectiveOn !== b.effectiveOn
              ? 'effectiveOn'
              : overlaps(a.window, b.window, calendar)
                ? 'overlap'
                : undefined;
          if (kind === undefined) continue;
          const pair: [number, number] =
            a.version < b.version ? [a.version, b.version] : [b.version, a.version];
          found.push({ ruleSet, id, versions: pair, kind });
        }
      }
    }
  }
  return found.sort(
    (x, y) =>
      compareText(x.ruleSet, y.ruleSet) ||
      compareText(x.id, y.id) ||
      x.versions[0] - y.versions[0] ||
      x.versions[1] - y.versions[1],
  );
}

/** The versions of `rules`, by rule set then `id`, each checked. */
function readGroups(
  rules: ReadonlyArray<VersionedRuleWindow>,
  zone: string,
): Map<string, Map<string, Version[]>> {
  const groups = new Map<string, Map<string, Version[]>>();
  const seen = new Set<string>();
  let items: unknown[];
  try {
    if (!Array.isArray(rules)) {
      throw new SpecError('INVALID_RULE', 'rules must be an array of rules');
    }
    const list: readonly unknown[] = rules;
    const length = list.length;
    items = [];
    for (let i = 0; i < length; i++) items.push(list[i]);
  } catch (error) {
    if (error instanceof SpecError) throw error;
    throw new SpecError('INVALID_RULE', unreadableMessage('rules', error));
  }

  for (const [index, item] of items.entries()) {
    const rule = readRule(item, index, zone);
    const key = JSON.stringify([rule.ruleSet, rule.id, rule.version.version]);
    if (seen.has(key)) {
      throw new SpecError('INVALID_RULE', `duplicate rule ${rule.name}`);
    }
    seen.add(key);
    let ids = groups.get(rule.ruleSet);
    if (ids === undefined) groups.set(rule.ruleSet, (ids = new Map()));
    const versions = ids.get(rule.id);
    if (versions === undefined) ids.set(rule.id, [rule.version]);
    else versions.push(rule.version);
  }
  return groups;
}

function readRule(
  item: unknown,
  index: number,
  zone: string,
): { ruleSet: string; id: string; name: string; version: Version } {
  if (typeof item !== 'object' || item === null) {
    throw new SpecError('INVALID_RULE', `rules[${index}] must be a rule object`);
  }
  let fields: Record<
    'id' | 'version' | 'ruleSet' | 'effectiveOn' | 'from' | 'until' | 'timeZone',
    unknown
  >;
  try {
    fields = {
      id: 'id' in item ? item.id : undefined,
      version: 'version' in item ? item.version : undefined,
      ruleSet: 'ruleSet' in item ? item.ruleSet : undefined,
      effectiveOn: 'effectiveOn' in item ? item.effectiveOn : undefined,
      from: 'effectiveFrom' in item ? item.effectiveFrom : undefined,
      until: 'effectiveUntil' in item ? item.effectiveUntil : undefined,
      timeZone: 'timeZone' in item ? item.timeZone : undefined,
    };
  } catch (error) {
    throw new SpecError('INVALID_RULE', unreadableMessage(`rules[${index}]`, error));
  }
  const { id, version, ruleSet, effectiveOn } = fields;
  const name = `${typeof id === 'string' ? escapeText(id) : typeName(id)}@${
    typeof version === 'number' ? String(version) : typeName(version)
  }`;
  const prefix = `rule ${name}: `;
  const requireText = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value === '') {
      throw new SpecError('INVALID_RULE', `${prefix}${field} must be a non-empty string`);
    }
    if (hasLoneSurrogate(value)) {
      throw new SpecError('INVALID_RULE', prefix + loneSurrogateMessage(field));
    }
    return value;
  };

  const ruleId = requireText(id, 'id');
  if (!isRuleVersion(version)) {
    throw new SpecError('INVALID_RULE', `${prefix}version must be a positive integer`);
  }
  const set = ruleSet == null ? 'local' : requireText(ruleSet, 'ruleSet');
  const window = resolveWindow(fields, zone, prefix);
  const read = effectiveOn == null ? undefined : readEffectiveOn(effectiveOn, prefix);
  // The default reference date is the absent one, as normalization writes it.
  const pointer = read === DEFAULT_EFFECTIVE_ON ? undefined : read;
  return { ruleSet: set, id: ruleId, name, version: { version, window, effectiveOn: pointer } };
}

/**
 * Whether some reference date makes both windows true (D-13, extended): a common instant, or a
 * common civil day on which each window is wholly true in its own time zone. Two windows of one
 * form and one time zone compare directly; otherwise both checks are made.
 */
function overlaps(a: ResolvedWindow, b: ResolvedWindow, calendar: CivilCalendar): boolean {
  const civilA = isCivilDate(a.from);
  if (a.zone === b.zone && civilA === isCivilDate(b.from)) {
    return intervalsMeet(a.from, a.until, b.from, b.until);
  }
  const start = (bound: CivilDate | Instant, zone: string): Instant | Beyond =>
    isCivilDate(bound) ? startOfDayIn(calendar, bound, zone) : bound;
  const end = (bound: CivilDate | Instant | null, zone: string): Instant | Beyond | null =>
    bound === null ? null : start(bound, zone);
  return (
    intervalsMeet(
      start(a.from, a.zone),
      end(a.until, a.zone),
      start(b.from, b.zone),
      end(b.until, b.zone),
    ) || intervalsMeet(...civilDays(a, calendar), ...civilDays(b, calendar))
  );
}

/**
 * The civil days `[first, end)` on which `window` is true for a civil reference date, in its own
 * time zone, as `windowContains` decides it: civil bounds as they are; for an instant window
 * `[a, b)`, from the day of `a` (the next day when `a` does not start it) to the day of `b`.
 */
function civilDays(window: ResolvedWindow, calendar: CivilCalendar): [string, string | null] {
  if (isCivilDate(window.from)) return [window.from, window.until];
  const day = civilDateIn(calendar, window.from, window.zone);
  const first =
    !isCivilDate(day) || startOfDayIn(calendar, day, window.zone) === window.from
      ? day
      : nextCivilDate(day);
  const end = window.until === null ? null : civilDateIn(calendar, window.until, window.zone);
  return [first, end];
}

/**
 * Two half-open intervals `[f1, u1)` and `[f2, u2)` of same-form texts (`null`: no end) are
 * both non-empty and share a point.
 */
function intervalsMeet(f1: string, u1: string | null, f2: string, u2: string | null): boolean {
  const nonEmpty = (u1 === null || f1 < u1) && (u2 === null || f2 < u2);
  return nonEmpty && (u2 === null || f1 < u2) && (u1 === null || f2 < u1);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
