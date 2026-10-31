import { citeName, isOwnError, newSpecError, unreadableMessage } from '../errors.js';
import {
  civilDateIn,
  isCivilDate,
  nextCivilDate,
  requireTimeZone,
  startOfDayIn,
} from '../time/civil.js';
import type { Beyond, CivilCalendar, CivilDate, Instant } from '../time/civil.js';
import { hasLoneSurrogate, loneSurrogateMessage, readList, typeName } from '../values.js';
import { isRuleVersion } from './definition.js';
import { isRuleSetId, LOCAL_RULE_SET, ruleSetIdMessage } from './ruleSet.js';
import { DEFAULT_EFFECTIVE_ON, readEffectiveOn, resolveWindow } from './window.js';
import type { ResolvedWindow, RuleWindow } from './window.js';

/** One rule version as `findOverlappingVersions` reads it. */
export interface VersionedRuleWindow extends RuleWindow {
  readonly id: string;
  readonly version: number;
  /**
   * The rule set, a rule set id (`isRuleSetId`); absent, `null` and `'local'` are the local rules,
   * one group: no pack can be named `local` (`isPackId`), so a pack never mixes with them.
   */
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

/** What `findOverlappingVersions` returns. */
export interface VersionOverlapReport {
  /** At most `MAX_OVERLAPS` pairs, sorted by `ruleSet`, `id`, then versions. */
  overlaps: VersionOverlap[];
  /** True when more pairs exist than `overlaps` lists: the scan stopped at the limit. */
  truncated: boolean;
}

/** The most pairs `findOverlappingVersions` lists; past it, the scan stops (`truncated`). */
export const MAX_OVERLAPS = 100;

/** Internal: one version of a rule, checked and resolved. */
export interface Version {
  readonly version: number;
  readonly window: ResolvedWindow;
  readonly effectiveOn: string | undefined;
}

/**
 * The pairs of versions of a rule that cannot coexist (D-31). Rules are grouped by (`ruleSet`,
 * `id`), an absent rule set being `'local'`: the same `id` in two rule sets is two rules. Two
 * versions of one group cannot coexist when:
 * - they read different reference dates (`effectiveOn`; absent and the default
 *   `/$dates/effective` are the same): `'effectiveOn'`, since their windows cannot be compared;
 * - else their windows can both be true on some reference date: `'overlap'`. Each version
 *   keeps its own time zone (its `timeZone`, else `timeZone`). Windows of one form and one time
 *   zone compare directly (civil dates, or instants). Otherwise the pair overlaps when the
 *   windows share an instant (a civil bound being its `startOfDay` in its version's time zone,
 *   D-13) or a civil day on which each is wholly true in its own time zone (an instant window
 *   `[a, b)` covers the days from the day of `a`, or the next one when `a` does not start it,
 *   to the day of `b`, excluded). Days and instants outside the years 0000 to 9999 are decided.
 *
 * Lists at most `MAX_OVERLAPS` (100) pairs, sorted by `ruleSet`, `id`, then versions (UTF-16
 * code unit order for texts); past it the scan stops and `truncated` is true. The groups are
 * scanned in that order, so a truncated list holds pairs of the first groups; within a group,
 * the pairs of different `effectiveOn` come first, then the overlaps in the order of their
 * start. Below the limit the list is every pair.
 *
 * The cost is O(n log n + k) for n versions and k pairs listed (k ≤ 100): each version's
 * intervals are computed once (the calendar is called a bounded number of times per version,
 * and only for a group that mixes forms or time zones), sorted, and swept.
 *
 * Throws `SpecError`: `INVALID_DATE` for an invalid `timeZone`, a bound `toReferenceDate`
 * refuses or a calendar that fails; `INVALID_RULE` for a list that is not an array or cannot be
 * read, a rule with an invalid `id`, `version`, `ruleSet` (not a rule set id), `timeZone` or
 * `effectiveOn`, bounds of two forms, an empty window, or the same (`ruleSet`, `id`,
 * `version`) twice (`duplicate rule R1@1`). Messages about one rule start with
 * `rule <id>@<version>: `.
 */
export function findOverlappingVersions(
  rules: ReadonlyArray<VersionedRuleWindow>,
  timeZone: string,
  calendar: CivilCalendar,
): VersionOverlapReport {
  return scan(rules, timeZone, calendar).report;
}

/**
 * Internal: the steps `findOverlappingVersions` makes (each comparison of a sort, each entry
 * read by a sweep, each pair listed), for tests that bound its work by a count.
 */
export function overlapScanSteps(
  rules: ReadonlyArray<VersionedRuleWindow>,
  timeZone: string,
  calendar: CivilCalendar,
): number {
  return scan(rules, timeZone, calendar).steps;
}

/** The state of one scan: the pairs listed, and the steps counted. */
interface Scan {
  readonly found: VersionOverlap[];
  truncated: boolean;
  steps: number;
}

function scan(
  rules: ReadonlyArray<VersionedRuleWindow>,
  timeZone: string,
  calendar: CivilCalendar,
): { report: VersionOverlapReport; steps: number } {
  const zone = requireTimeZone(timeZone, 'INVALID_DATE');
  const groups = readVersionGroups(rules, zone);
  const state: Scan = { found: [], truncated: false, steps: 0 };
  const byText = (a: string, b: string): number => {
    state.steps += 1;
    return compareText(a, b);
  };
  scanning: for (const ruleSet of [...groups.keys()].sort(byText)) {
    const ids = groups.get(ruleSet) ?? new Map<string, Version[]>();
    for (const id of [...ids.keys()].sort(byText)) {
      const listed = new Set<string>();
      const emit = (a: Version, b: Version, kind: VersionOverlap['kind']): boolean => {
        state.steps += 1;
        const versions: [number, number] =
          a.version < b.version ? [a.version, b.version] : [b.version, a.version];
        const key = `${versions[0]}:${versions[1]}`;
        if (listed.has(key)) return true;
        if (state.found.length >= MAX_OVERLAPS) {
          state.truncated = true;
          return false;
        }
        listed.add(key);
        state.found.push({ ruleSet, id, versions, kind });
        return true;
      };
      if (!scanGroup(ids.get(id) ?? [], calendar, state, emit)) break scanning;
    }
  }
  const overlaps = state.found.sort(
    (x, y) =>
      compareText(x.ruleSet, y.ruleSet) ||
      compareText(x.id, y.id) ||
      x.versions[0] - y.versions[0] ||
      x.versions[1] - y.versions[1],
  );
  return { report: { overlaps, truncated: state.truncated }, steps: state.steps };
}

type Emit = (a: Version, b: Version, kind: VersionOverlap['kind']) => boolean;

/**
 * Lists the pairs of one (`ruleSet`, `id`) group; false once the limit stopped the scan.
 * Versions are split by `effectiveOn`: every pair across two parts is `'effectiveOn'`; within a
 * part, the overlaps are swept.
 */
function scanGroup(
  versions: readonly Version[],
  calendar: CivilCalendar,
  state: Scan,
  emit: Emit,
): boolean {
  const parts = new Map<string | undefined, Version[]>();
  for (const version of versions) {
    const part = parts.get(version.effectiveOn);
    if (part === undefined) parts.set(version.effectiveOn, [version]);
    else part.push(version);
  }
  const list = [...parts.values()];
  for (const [i, part] of list.entries()) {
    for (const other of list.slice(i + 1)) {
      for (const a of part) {
        for (const b of other) if (!emit(a, b, 'effectiveOn')) return false;
      }
    }
  }
  for (const part of list) if (!sweepOverlaps(part, calendar, state, emit)) return false;
  return true;
}

/** One version's interval in one space (instants, or civil days), with its class. */
interface Entry {
  readonly version: Version;
  readonly from: string;
  readonly until: string | null;
  /** The form and time zone of the version (`c:UTC`, `i:Europe/Paris`). */
  readonly kind: string;
}

/**
 * Lists every pair of `versions` (one `effectiveOn`) whose windows overlap, exactly as
 * `versionsOverlap` decides each pair, in O(n log n + k). Two versions of one form and one time
 * zone (one class) compare directly: civil windows as civil days, instant windows as instants.
 * Two versions of different classes overlap when they share an instant or a civil day. So
 * instants are swept skipping pairs of one civil class, then civil days skipping pairs of one
 * instant class. A version's other space is computed (with the calendar) only when the part
 * mixes classes, as `versionsOverlap` needs it only for such pairs.
 */
function sweepOverlaps(
  versions: readonly Version[],
  calendar: CivilCalendar,
  state: Scan,
  emit: Emit,
): boolean {
  const kindOf = (v: Version): string =>
    `${isCivilDate(v.window.from) ? 'c' : 'i'}:${v.window.zone}`;
  const mixed = new Set(versions.map(kindOf)).size > 1;
  const instants: Entry[] = [];
  const days: Entry[] = [];
  for (const version of versions) {
    const { window } = version;
    const kind = kindOf(version);
    const civil = isCivilDate(window.from);
    if (!civil || mixed) {
      const [from, until] = instantSpan(window, calendar);
      instants.push({ version, from, until, kind });
    }
    if (civil || mixed) {
      const [from, until] = civilDays(window, calendar);
      days.push({ version, from, until, kind });
    }
  }
  return (
    sweep(instants, (kind) => kind.startsWith('c:'), state, emit) &&
    sweep(days, (kind) => kind.startsWith('i:'), state, emit)
  );
}

/**
 * Lists each pair of `entries` whose half-open intervals share a point, except two entries of
 * one class for which `skip` holds. Entries are sorted by start; each entry meets every active
 * one (started, not ended), and active entries are kept by class so that a skipped class costs
 * one step. Each entry is dropped once ended: O(n log n + pairs listed).
 */
function sweep(
  entries: readonly Entry[],
  skip: (kind: string) => boolean,
  state: Scan,
  emit: Emit,
): boolean {
  const sorted = entries
    .filter((entry) => entry.until === null || entry.from < entry.until)
    .sort((a, b) => {
      state.steps += 1;
      return compareText(a.from, b.from) || a.version.version - b.version.version;
    });
  const active = new Map<string, Entry[]>();
  for (const entry of sorted) {
    for (const [kind, bucket] of active) {
      state.steps += 1;
      if (kind === entry.kind && skip(kind)) continue;
      const kept: Entry[] = [];
      for (const other of bucket) {
        state.steps += 1;
        if (other.until !== null && other.until <= entry.from) continue;
        kept.push(other);
        if (!emit(other.version, entry.version, 'overlap')) return false;
      }
      if (kept.length === 0) active.delete(kind);
      else active.set(kind, kept);
    }
    const bucket = active.get(entry.kind);
    if (bucket === undefined) active.set(entry.kind, [entry]);
    else bucket.push(entry);
  }
  return true;
}

/** The window in instants: a civil bound is its `startOfDay` in the version's time zone. */
function instantSpan(window: ResolvedWindow, calendar: CivilCalendar): [string, string | null] {
  const start = (bound: CivilDate | Instant): Instant | Beyond =>
    isCivilDate(bound) ? startOfDayIn(calendar, bound, window.zone) : bound;
  return [start(window.from), window.until === null ? null : start(window.until)];
}

/** Internal: the versions of `rules`, by rule set then `id`, each checked. */
export function readVersionGroups(
  rules: ReadonlyArray<VersionedRuleWindow>,
  zone: string,
): Map<string, Map<string, Version[]>> {
  const groups = new Map<string, Map<string, Version[]>>();
  const seen = new Set<string>();
  let items: unknown[];
  try {
    if (!Array.isArray(rules)) {
      throw newSpecError('INVALID_RULE', 'rules must be an array of rules');
    }
    const read = readList(rules, 'rules');
    if (typeof read === 'string') throw newSpecError('INVALID_RULE', read);
    items = read;
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw newSpecError('INVALID_RULE', unreadableMessage('rules', error));
  }

  for (const [index, item] of items.entries()) {
    const rule = readRule(item, index, zone);
    const key = JSON.stringify([rule.ruleSet, rule.id, rule.version.version]);
    if (seen.has(key)) {
      throw newSpecError('INVALID_RULE', `duplicate rule ${rule.name}`);
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
    throw newSpecError('INVALID_RULE', `rules[${index}] must be a rule object`);
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
    throw newSpecError('INVALID_RULE', unreadableMessage(`rules[${index}]`, error));
  }
  const { id, version, ruleSet, effectiveOn } = fields;
  const name = `${typeof id === 'string' ? citeName(id) : typeName(id)}@${
    typeof version === 'number' ? String(version) : typeName(version)
  }`;
  const prefix = `rule ${name}: `;
  const requireText = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value === '') {
      throw newSpecError('INVALID_RULE', `${prefix}${field} must be a non-empty string`);
    }
    if (hasLoneSurrogate(value)) {
      throw newSpecError('INVALID_RULE', prefix + loneSurrogateMessage(field));
    }
    return value;
  };

  const ruleId = requireText(id, 'id');
  if (!isRuleVersion(version)) {
    throw newSpecError('INVALID_RULE', `${prefix}version must be a positive integer`);
  }
  const set = ruleSet == null ? LOCAL_RULE_SET : requireText(ruleSet, 'ruleSet');
  if (!isRuleSetId(set)) {
    throw newSpecError('INVALID_RULE', prefix + ruleSetIdMessage('ruleSet', set));
  }
  const window = resolveWindow(fields, zone, prefix);
  const read = effectiveOn == null ? undefined : readEffectiveOn(effectiveOn, prefix);
  // The default reference date is the absent one, as normalization writes it.
  const pointer = read === DEFAULT_EFFECTIVE_ON ? undefined : read;
  return { ruleSet: set, id: ruleId, name, version: { version, window, effectiveOn: pointer } };
}

/**
 * Internal: whether some reference date makes both windows true (D-13, extended): a common
 * instant, or a common civil day on which each window is wholly true in its own time zone. Two
 * windows of one form and one time zone compare directly; otherwise both checks are made. The
 * pairwise rule `sweepOverlaps` implements (tests compare them).
 */
export function versionsOverlap(
  a: ResolvedWindow,
  b: ResolvedWindow,
  calendar: CivilCalendar,
): boolean {
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
