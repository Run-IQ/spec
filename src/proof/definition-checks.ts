import { DEFAULT_OUTPUT } from '../decision/output.js';
import { citeName, reasonOf } from '../errors.js';
import type { RuleDefinition } from '../rule/definition.js';
import { LOCAL_RULE_SET, qualifiedFrom } from '../rule/ruleSet.js';
import { windowContains } from '../rule/window.js';
import { fixedOffsetCalendar } from '../time/civil.js';
import type { CivilCalendar } from '../time/civil.js';
import { BEFORE_EXCEPTIONS } from './effects.js';
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
const CHECKED_REASONS: ReadonlySet<string> = new Set([
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
  const outputs = new Set([qualifiedFrom(own, definition.output ?? DEFAULT_OUTPUT)]);
  for (const exception of definition.exceptions ?? []) {
    if (exception.kind === 'shortCircuit') outputs.add(qualifiedFrom(own, exception.output));
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

/** The offsets, in minutes, no time zone of the world goes beyond: -12:00 and +14:00. */
const EXTREME_OFFSETS = ['-12:00', '+14:00'] as const;

const FIXED_ZONE = /^(UTC|[+-]\d{2}:\d{2})$/;

/**
 * Whether the window of `definition` holds the reference date of the decision: `true`, `false`,
 * or why it cannot be said. Given a `calendar`, it is the one that crosses civil dates and
 * instants. Without one, `UTC` and fixed offsets are exact; for an IANA zone the window is
 * decided when the two extreme offsets agree (the civil date of an instant is monotone in the
 * offset, so every zone in between agrees too), and said to be undecidable only for an instant
 * within a day of a bound.
 */
function windowHolds(
  proof: ProofView,
  definition: RuleDefinition,
  calendar: CivilCalendar | undefined,
): boolean | string {
  if (definition.effectiveOn !== undefined)
    return `effectiveOn is ${citeName(definition.effectiveOn)}`;
  if (proof.evaluatedAt === null) return 'no evaluatedAt';
  const zone = zoneOf(proof, definition);
  const effective = definition.timeZone ?? zone;
  const at = proof.evaluatedAt;
  if (calendar !== undefined) return decided(windowContains(definition, at, zone, calendar));
  const offsets = fixedOffsetCalendar('verifyProof');
  if (FIXED_ZONE.test(effective)) return decided(windowContains(definition, at, zone, offsets));
  const [low, high] = EXTREME_OFFSETS.map((offset): CivilCalendar => ({
    toCivilDate: (instant) => offsets.toCivilDate(instant, offset),
    startOfDay: (day) => offsets.startOfDay(day, offset),
  })) as [CivilCalendar, CivilCalendar];
  const atLow = windowContains(definition, at, zone, low);
  const atHigh = windowContains(definition, at, zone, high);
  if (atLow === atHigh && atLow !== 'unknown') return atLow;
  return `civil bound in ${citeName(effective)}`;
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
 * a day cut by an instant bound) is named in a notice, the rules grouped by cause (`window not
 * checked: id@version (<why>)`, or the number of rules and the first ones); a reason this check
 * does not decide, unknown ones included, once per reason (`reason not checked: <reason>`). An
 * unexpected failure of a check (a calendar that throws) is a contradiction, never a notice:
 * `window check failed: <message>`.
 */
export function definitionFindings(
  proof: ProofView,
  matched: ReadonlyMap<string, RuleDefinition>,
  report: DefinitionFindings,
  calendar?: CivilCalendar,
): void {
  const windows = new Map<string, boolean | string>();
  const undecided = new Map<string, string[]>();
  const unnamed: string[] = [];
  const holds = (key: string, definition: RuleDefinition): boolean | undefined => {
    let held = windows.get(key);
    if (held === undefined) {
      try {
        held = windowHolds(proof, definition, calendar);
      } catch (error) {
        report.invalid(`window check failed: ${reasonOf(error)} (${citeName(key)})`);
        held = 'the check failed';
      }
      windows.set(key, held);
      if (typeof held === 'string' && held !== 'the check failed') {
        const keys = undecided.get(held) ?? [];
        keys.push(key);
        undecided.set(held, keys);
      }
    }
    return typeof held === 'boolean' ? held : undefined;
  };

  for (const step of proof.applied) {
    const key = ruleKey(step);
    const definition = matched.get(key);
    if (definition === undefined) continue;
    const at = citeName(instanceKey(step));
    if (holds(key, definition) === false) report.invalid(`rule applied outside its window: ${at}`);
    if (step.model !== definition.model)
      report.invalid(`applied model differs from its rule: ${at}`);
    if (!outputsOf(definition).has(step.output)) {
      report.invalid(`applied output differs from its rule: ${at}`);
    }
  }
  for (const entry of proof.pending) {
    const key = ruleKey(entry);
    const definition = matched.get(key);
    if (definition === undefined) continue;
    if (holds(key, definition) === false) {
      report.invalid(`rule pending outside its window: ${citeName(instanceKey(entry))}`);
    }
  }
  for (const skip of proof.skipped) {
    const key = ruleKey(skip);
    const definition = matched.get(key);
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
      if (Object.keys(definition.dimensions).length === 0) {
        report.invalid(`DIMENSION_MISMATCH on a rule without dimensions: ${at}`);
      }
    } else if (skip.reason === 'NOT_REQUESTED') {
      if (proof.requested === undefined) {
        report.invalid(`NOT_REQUESTED while every output was requested: ${at}`);
      } else if (skip.output !== undefined && proof.requested.includes(skip.output)) {
        report.invalid(`NOT_REQUESTED on a requested output: ${at}`);
      }
    }
    if (!CHECKED_REASONS.has(skip.reason) && !unnamed.includes(skip.reason)) {
      unnamed.push(skip.reason);
    }
    const output = skip.output;
    if (
      output !== undefined &&
      BEFORE_EXCEPTIONS.has(skip.reason) &&
      !outputsOf(definition).has(output)
    ) {
      report.invalid(`skipped output differs from its rule: ${at}`);
    }
  }

  for (const [why, keys] of undecided) {
    if (keys.length === 1) {
      report.unchecked(`window not checked: ${citeName(keys[0]!)} (${why})`);
      continue;
    }
    const named = keys.slice(0, MAX_NAMED_RULES).map(citeName).join(', ');
    const more = keys.length > MAX_NAMED_RULES ? `, and ${keys.length - MAX_NAMED_RULES} more` : '';
    report.unchecked(`window not checked: ${keys.length} rules (${why}): ${named}${more}`);
  }
  for (const reason of unnamed.slice(0, MAX_NAMED_REASONS)) {
    report.unchecked(`reason not checked: ${citeName(reason)}`);
  }
  if (unnamed.length > MAX_NAMED_REASONS) {
    report.unchecked(`reason not checked: ${unnamed.length - MAX_NAMED_REASONS} more reasons`);
  }
}
