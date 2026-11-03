import { DEFAULT_OUTPUT } from '../decision/output.js';
import {
  NativeMap,
  NativeSet,
  arrayFind,
  arrayIncludes,
  arrayJoin,
  arrayMap,
  arrayPush,
  arraySlice,
  isoOf,
  mapGet,
  mapSet,
  objectKeys,
  parseTime,
  regExpTest,
  setAdd,
  setHas,
  setSize,
  stringSlice,
  stringStartsWith,
} from '../intrinsics.js';
import { citeName, isOwnError, isOwnOptionsError, newOptionsError, reasonOf } from '../errors.js';
import type { RuleDefinition } from '../rule/definition.js';
import { LOCAL_RULE_SET, qualifiedFrom } from '../rule/ruleSet.js';
import { windowContains } from '../rule/window.js';
import { fixedOffsetCalendar, isCivilDate } from '../time/civil.js';
import type { CivilCalendar } from '../time/civil.js';
import { BEFORE_EXCEPTIONS } from './effects.js';
import {
  intlCalendar,
  isKnownZone,
  RuntimeCannotReadOffsets,
  RuntimeHasNoZoneData,
  runtimeTzdata,
} from './intl-calendar.js';
import { instanceKey } from './output-values.js';
import { ruleKey } from './precedence.js';
import type { ProofView } from './types.js';

// Internal to `@run-iq/spec`: what the definitions given to `verifyProof` decide about the trace
// WITHOUT executing anything: the window of a rule against the reference date, its model and
// output, and the exclusions that need a condition or dimensions the rule does not have. Whatever
// a definition cannot decide here is said, never passed over: conditions and amounts are checked
// by replay only (Task 11).

/**
 * The exclusions this check decides from a definition (`NOT_REQUESTED` from the header's
 * `requested`), and those another check of `verifyProof` verifies (`INHIBITED`,
 * `SHORT_CIRCUITED`, `RULE_CONFLICT`: against the exceptions and the ties). Every other reason,
 * unknown ones included, is named in a notice: it was not checked against its definition.
 */
const CHECKED_REASONS: ReadonlySet<string> = new NativeSet([
  'INACTIVE_DATE',
  'CONDITION_FALSE',
  'DIMENSION_MISMATCH',
  'NOT_REQUESTED',
  'INHIBITED',
  'SHORT_CIRCUITED',
  'RULE_CONFLICT',
]);

/** Reasons named one by one in a notice; the rest are counted in one. */
const MAX_NAMED_REASONS = 20;
/** Rules named in an aggregated window notice; the rest are counted. */
const MAX_NAMED_RULES = 5;
/** Zones or releases named in an aggregated window notice. */
const MAX_NAMED_DETAILS = 3;

/** What the checks report: contradictions, and what they could not decide. */
export interface DefinitionFindings {
  /** Called with a contradiction, which makes the proof invalid. */
  invalid: (message: string) => void;
  /** Called with what could not be checked: a notice, never silence. */
  unchecked: (message: string) => void;
}

/**
 * The outputs a rule may feed, qualified: its own and the targets of its short circuits (a
 * carrier's step on the output it imposes).
 */
function outputsOf(definition: RuleDefinition): Set<string> {
  const own = definition.ruleSet ?? LOCAL_RULE_SET;
  const outputs = new NativeSet([qualifiedFrom(own, definition.output ?? DEFAULT_OUTPUT)]);
  for (const exception of definition.exceptions ?? []) {
    if (exception.kind === 'shortCircuit') setAdd(outputs, qualifiedFrom(own, exception.output));
  }
  return outputs;
}

/** The time zone the window of `definition` is read in: its own, its rule set's, the decision's. */
function zoneOf(proof: ProofView, definition: RuleDefinition): string {
  const ruleSet = definition.ruleSet ?? LOCAL_RULE_SET;
  for (const entry of proof.ruleSets) {
    if (entry.kind === 'referential') continue;
    const own = entry.kind === 'local' ? LOCAL_RULE_SET : entry.id;
    if (own === ruleSet) return entry.timeZone ?? proof.timeZone;
  }
  return proof.timeZone;
}

const FIXED_ZONE = /^(UTC|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86_400_000;

/** Where `ref` lies against one bound of a window, whatever the time zone. */
type Position = 'before' | 'notBefore' | 'undecided';

/**
 * Where the reference date `ref` lies against `bound`, knowing nothing of the zone but that its
 * offset stays within -24:00 and +24:00 (no zone of the database comes near: Sitka before 1867
 * is +14:58). Two bounds of one form compare as text. An instant against a civil bound: the
 * local midnight of that day lies within a day of its UTC midnight. A civil day against an
 * instant bound: the civil day of the bound lies within a day of its UTC day. Outside that band
 * the answer is the same in every zone; inside it, the zone decides.
 */
function position(ref: string, bound: string): Position {
  const refCivil = isCivilDate(ref);
  if (refCivil === isCivilDate(bound)) return ref < bound ? 'before' : 'notBefore';
  if (!refCivil) {
    const midnight = parseTime(`${bound}T00:00:00.000Z`);
    const at = parseTime(ref);
    if (at < midnight - DAY_MS) return 'before';
    return at >= midnight + DAY_MS ? 'notBefore' : 'undecided';
  }
  const at = parseTime(bound);
  const first = stringSlice(isoOf(at - DAY_MS), 0, 10);
  const last = stringSlice(isoOf(at + DAY_MS), 0, 10);
  if (ref < first) return 'before';
  return ref > last ? 'notBefore' : 'undecided';
}

/**
 * The window `[from, until)` against `ref`, bound by bound: `false` as soon as one bound puts
 * `ref` outside whatever the zone, `true` when both put it inside, `undefined` otherwise.
 */
function decidedByBounds(ref: string, from: string, until: string | null): boolean | undefined {
  const start = position(ref, from);
  const end = until === null ? 'before' : position(ref, until);
  if (start === 'before' || end === 'notBefore') return false;
  return start === 'notBefore' && end === 'before' ? true : undefined;
}

/**
 * Whether the window of `definition` holds the reference date of the decision: `true`, `false`,
 * or why it cannot be said. Given a `calendar`, it is the one that crosses civil dates and
 * instants. Without one, `UTC` and fixed offsets are exact; for an IANA zone each bound decides
 * on its own where the instant lies outside the band its zone could put it in
 * (`position`); inside a band the offset of the zone at that instant is read from the runtime
 * (`Intl`), and a window stays undecided when the runtime cannot say (a zone it does not know,
 * no database, an offset it cannot read) or its database is not the proof's.
 */
function windowHolds(
  proof: ProofView,
  definition: RuleDefinition,
  calendar: CivilCalendar | undefined,
  tzdata: string | undefined,
): boolean | string {
  if (definition.effectiveOn !== undefined)
    return `effectiveOn is ${citeName(definition.effectiveOn)}`;
  if (proof.evaluatedAt === null) return 'no evaluatedAt';
  const zone = zoneOf(proof, definition);
  const effective = definition.timeZone ?? zone;
  const at = proof.evaluatedAt;
  if (calendar !== undefined) return decided(withCallerCalendar(definition, at, zone, calendar));
  if (regExpTest(FIXED_ZONE, effective)) {
    return decided(windowContains(definition, at, zone, fixedOffsetCalendar('verifyProof')));
  }
  const byBounds = decidedByBounds(at, definition.effectiveFrom, definition.effectiveUntil);
  if (byBounds !== undefined) return byBounds;
  // Whatever the runtime cannot do (no database, an offset it cannot read, a formatter that
  // throws) is a notice naming what could not be checked, never a fault of the proof.
  let unreadable: string | undefined;
  const watched = (call: () => string): string => {
    try {
      return call();
    } catch (error) {
      unreadable = error instanceof RuntimeHasNoZoneData ? NO_ZONE_DATA : CANNOT_READ_OFFSETS;
      throw error;
    }
  };
  try {
    if (!isKnownZone(effective)) return `zone ${citeName(effective)} unknown to this verifier`;
    // The exact offset comes from the time zone database of this runtime: it decides only when
    // that database is the one the proof was made with. A bound far from the instant never
    // reaches here, and needs no database. Only the release the engine recorded counts: the
    // proof holds one (`consistency`), and a plugin or a model cannot name the database.
    const recorded = arrayFind(
      proof.versions.components,
      (entry) => entry.name === 'tzdata' && entry.declaredBy === 'engine',
    )?.version;
    if (recorded === undefined) return 'no tzdata recorded by the engine';
    if (tzdata === undefined) return 'this runtime does not name its tzdata';
    if (recorded !== tzdata)
      return `tzdata ${citeName(recorded)} of the proof, ${citeName(tzdata)} here`;
    const exact: CivilCalendar = {
      toCivilDate: (instant, name) => watched(() => intlCalendar.toCivilDate(instant, name)),
      startOfDay: (day, name) => watched(() => intlCalendar.startOfDay(day, name)),
    };
    return decided(windowContains(definition, at, zone, exact));
  } catch (error) {
    if (unreadable !== undefined) return unreadable;
    if (error instanceof RuntimeHasNoZoneData) return NO_ZONE_DATA;
    if (error instanceof RuntimeCannotReadOffsets) return CANNOT_READ_OFFSETS;
    throw error;
  }
}

/**
 * The window against the calendar the caller gave (`options.calendar`). The calendar is the
 * caller's: a calendar that throws, or answers with something that is not a date, is a mistake
 * of the caller (`VerifyOptionsError`), never a verdict on the proof.
 */
function withCallerCalendar(
  definition: RuleDefinition,
  at: string,
  zone: string,
  calendar: CivilCalendar,
): boolean | 'unknown' {
  let faulted: unknown;
  let threw = false;
  const guarded = (call: () => string): string => {
    try {
      return call();
    } catch (error) {
      threw = true;
      faulted = error;
      throw error;
    }
  };
  const watched: CivilCalendar = {
    toCivilDate: (instant, name) => guarded(() => calendar.toCivilDate(instant, name)),
    startOfDay: (day, name) => guarded(() => calendar.startOfDay(day, name)),
  };
  try {
    return windowContains(definition, at, zone, watched);
  } catch (error) {
    // `windowContains` names what the calendar answered `calendar.<method> ...`.
    const answered =
      isOwnError(error) && regExpTest(/^calendar\.(toCivilDate|startOfDay) /, error.message);
    if (threw || answered) {
      throw newOptionsError(
        'options.calendar',
        `options.calendar is not usable: ${reasonOf(threw ? faulted : error)}`,
      );
    }
    throw error;
  }
}

const CANNOT_READ_OFFSETS = 'this runtime cannot read time zone offsets';
const NO_ZONE_DATA = 'this runtime has no time zone data';

/**
 * Every kind of cause of an undecided window: a notice is made for a kind, whatever the number
 * of rules, so the notices of a verdict are as many as these at most.
 */
export const WINDOW_KINDS = [
  'effectiveOn is not the decision date',
  'no evaluatedAt',
  'zone unknown to this verifier',
  "tzdata of the proof differs from this runtime's",
  'no tzdata recorded by the engine',
  'this runtime does not name its tzdata',
  'the day holds the bound of the window',
  CANNOT_READ_OFFSETS,
  NO_ZONE_DATA,
] as const;

/**
 * The kind of a cause of an undecided window, and what tells its causes apart (a zone, two
 * releases): the pointer or the zone is not part of the kind.
 */
function windowKind(why: string): { kind: string; detail?: string } {
  if (stringStartsWith(why, 'effectiveOn is ')) return { kind: WINDOW_KINDS[0] };
  if (stringStartsWith(why, 'zone ')) {
    return {
      kind: WINDOW_KINDS[2],
      detail: stringSlice(why, 5, -' unknown to this verifier'.length),
    };
  }
  if (stringStartsWith(why, 'tzdata '))
    return { kind: WINDOW_KINDS[3], detail: stringSlice(why, 7) };
  return { kind: why };
}

/** The answer of `windowContains`, `'unknown'` being a day that holds an instant bound. */
function decided(held: boolean | 'unknown'): boolean | string {
  return held === 'unknown' ? 'the day holds the bound of the window' : held;
}

/**
 * The trace of `proof` against the definitions of the rules whose checksum matched (`matched`,
 * by qualified id and version):
 * - an applied step: its window holds `evaluatedAt`, its `model` is the definition's, its
 *   `output` one the definition feeds;
 * - a pending entry: its window holds `evaluatedAt` (a rule outside its window is excluded
 *   before it can be pending);
 * - `INACTIVE_DATE`: the window does not hold `evaluatedAt`;
 * - `CONDITION_FALSE` only for a rule with a condition, `DIMENSION_MISMATCH` only for a rule
 *   with dimensions;
 * - `NOT_REQUESTED` only when the header's `requested` leaves the output out;
 * - a skip's output, for the exclusions made before the exceptions, is one the definition feeds.
 *
 * `evaluatedAt` is `meta.dates.effective`, the reference date of a rule without `effectiveOn`:
 * the window is compared with it only for such a rule. A window that cannot be decided (another
 * reference date, no `evaluatedAt`, a day within reach of a bound whose time zone is not known,
 * a day cut by an instant bound, a release of the time zone database that is not the proof's or
 * that the proof or the runtime does not name, a runtime that cannot read offsets or has no time
 * zone data: `WINDOW_KINDS`) is named in a notice, the rules grouped by cause (`window not
 * checked: id@version (<why>)`, or the number of rules and the first ones); a reason this check
 * does not decide, unknown ones included, once per reason (`reason not checked: <reason>`). A
 * calendar the caller gave that throws is the caller's mistake (`VerifyOptionsError`); another
 * unexpected failure of a check is a contradiction, never a notice: `window check failed:
 * <message>`.
 */
export function definitionFindings(
  proof: ProofView,
  matched: ReadonlyMap<string, RuleDefinition>,
  report: DefinitionFindings,
  calendar?: CivilCalendar,
  runtime: { tzdata: string | undefined } = { tzdata: runtimeTzdata() },
): void {
  const windows = new NativeMap<string, boolean | string>();
  const undecided = new NativeMap<string, string[]>();
  const unnamed: string[] = [];
  const holds = (key: string, definition: RuleDefinition): boolean | undefined => {
    let held = mapGet(windows, key);
    if (held === undefined) {
      try {
        held = windowHolds(proof, definition, calendar, runtime.tzdata);
      } catch (error) {
        // A mistake of the caller in the options is not a finding about the proof.
        if (isOwnOptionsError(error)) throw error;
        report.invalid(`window check failed: ${reasonOf(error)} (${citeName(key)})`);
        held = 'the check failed';
      }
      mapSet(windows, key, held);
      if (typeof held === 'string' && held !== 'the check failed') {
        const keys = mapGet(undecided, held) ?? [];
        arrayPush(keys, key);
        mapSet(undecided, held, keys);
      }
    }
    return typeof held === 'boolean' ? held : undefined;
  };

  for (const step of proof.applied) {
    const key = ruleKey(step);
    const definition = mapGet(matched, key);
    if (definition === undefined) continue;
    const at = citeName(instanceKey(step));
    if (holds(key, definition) === false) report.invalid(`rule applied outside its window: ${at}`);
    if (step.model !== definition.model)
      report.invalid(`applied model differs from its rule: ${at}`);
    if (!setHas(outputsOf(definition), step.output)) {
      report.invalid(`applied output differs from its rule: ${at}`);
    }
  }
  for (const entry of proof.pending) {
    const key = ruleKey(entry);
    const definition = mapGet(matched, key);
    if (definition === undefined) continue;
    if (holds(key, definition) === false) {
      report.invalid(`rule pending outside its window: ${citeName(instanceKey(entry))}`);
    }
  }
  for (const skip of proof.skipped) {
    const key = ruleKey(skip);
    const definition = mapGet(matched, key);
    if (definition === undefined) continue;
    const at = citeName(instanceKey(skip));
    if (skip.reason === 'INACTIVE_DATE') {
      if (holds(key, definition) === true) {
        report.invalid(`rule skipped as INACTIVE_DATE but its window contains evaluatedAt: ${at}`);
      }
    } else if (skip.reason === 'CONDITION_FALSE') {
      if (definition.condition === undefined) {
        report.invalid(`CONDITION_FALSE on a rule without a condition: ${at}`);
      }
    } else if (skip.reason === 'DIMENSION_MISMATCH') {
      if (objectKeys(definition.dimensions).length === 0) {
        report.invalid(`DIMENSION_MISMATCH on a rule without dimensions: ${at}`);
      }
    } else if (skip.reason === 'NOT_REQUESTED') {
      if (proof.requested === undefined) {
        report.invalid(`NOT_REQUESTED while every output was requested: ${at}`);
      } else if (skip.output === undefined) {
        // An exclusion for an output not asked for names that output: without it, nothing can
        // be compared with `requested`.
        report.invalid(`NOT_REQUESTED without an output: ${at}`);
      } else if (arrayIncludes(proof.requested, skip.output)) {
        report.invalid(`NOT_REQUESTED on a requested output: ${at}`);
      }
    }
    if (!setHas(CHECKED_REASONS, skip.reason) && !arrayIncludes(unnamed, skip.reason)) {
      arrayPush(unnamed, skip.reason);
    }
    const output = skip.output;
    if (
      output !== undefined &&
      setHas(BEFORE_EXCEPTIONS, skip.reason) &&
      !setHas(outputsOf(definition), output)
    ) {
      report.invalid(`skipped output differs from its rule: ${at}`);
    }
  }

  // One notice per kind of cause, whatever the number of rules: the number of notices of a
  // verdict is fixed, and none is ever cut.
  const kinds = new NativeMap<
    string,
    { causes: Set<string>; details: Set<string>; keys: string[] }
  >();
  for (const [why, keys] of undecided) {
    const { kind, detail } = windowKind(why);
    const group = mapGet(kinds, kind) ?? {
      causes: new NativeSet<string>(),
      details: new NativeSet<string>(),
      keys: [],
    };
    setAdd(group.causes, why);
    if (detail !== undefined) setAdd(group.details, detail);
    arrayPush(group.keys, ...keys);
    mapSet(kinds, kind, group);
  }
  for (const [kind, { causes, details, keys }] of kinds) {
    if (keys.length === 1) {
      report.unchecked(`window not checked: ${citeName(keys[0]!)} (${[...causes][0]})`);
      continue;
    }
    const named = arrayJoin(arrayMap(arraySlice(keys, 0, MAX_NAMED_RULES), citeName), ', ');
    const more = keys.length > MAX_NAMED_RULES ? ` and ${keys.length - MAX_NAMED_RULES} more` : '';
    const shown = arraySlice([...details], 0, MAX_NAMED_DETAILS);
    const extra =
      setSize(details) > shown.length ? `, and ${setSize(details) - shown.length} more` : '';
    const what = shown.length > 0 ? `${kind}: ${arrayJoin(shown, ', ')}${extra}` : kind;
    report.unchecked(`window not checked for ${keys.length} rules (${what}): ${named}${more}`);
  }
  for (const reason of arraySlice(unnamed, 0, MAX_NAMED_REASONS)) {
    report.unchecked(`reason not checked: ${citeName(reason)}`);
  }
  if (unnamed.length > MAX_NAMED_REASONS) {
    report.unchecked(`reason not checked: ${unnamed.length - MAX_NAMED_REASONS} more reasons`);
  }
}
