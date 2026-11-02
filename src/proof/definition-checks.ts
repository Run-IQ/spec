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

/** The exclusions this check decides from a definition. The other reasons are named, unchecked. */
const CHECKED_REASONS: ReadonlySet<string> = new Set([
  'INACTIVE_DATE',
  'CONDITION_FALSE',
  'DIMENSION_MISMATCH',
]);

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

/**
 * Whether the window of `definition` holds the reference date of the decision: `true`, `false`,
 * or why it cannot be said.
 */
function windowHolds(proof: ProofView, definition: RuleDefinition): boolean | string {
  if (definition.effectiveOn !== undefined)
    return `effectiveOn is ${citeName(definition.effectiveOn)}`;
  if (proof.evaluatedAt === null) return 'no evaluatedAt';
  let zoneNeeded: string | undefined;
  const offsets = fixedOffsetCalendar('verifyProof');
  const calendar: CivilCalendar = {
    toCivilDate: (at, zone) => {
      zoneNeeded = zone;
      return offsets.toCivilDate(at, zone);
    },
    startOfDay: (day, zone) => {
      zoneNeeded = zone;
      return offsets.startOfDay(day, zone);
    },
  };
  try {
    const held = windowContains(definition, proof.evaluatedAt, zoneOf(proof, definition), calendar);
    return held === 'unknown' ? 'the day holds the bound of the window' : held;
  } catch (error) {
    if (zoneNeeded !== undefined && zoneNeeded !== 'UTC' && !/^[+-]\d{2}:\d{2}$/.test(zoneNeeded)) {
      return `time zone ${citeName(zoneNeeded)} needs a calendar`;
    }
    return reasonOf(error);
  }
}

/**
 * The trace of `proof` against the definitions of the rules whose checksum matched (`matched`,
 * by qualified id and version):
 * - an applied step: its window holds `evaluatedAt`, its `model` is the definition's, its
 *   `output` one the definition feeds;
 * - `INACTIVE_DATE`: the window does not hold `evaluatedAt`;
 * - `CONDITION_FALSE` only for a rule with a condition, `DIMENSION_MISMATCH` only for a rule
 *   with dimensions;
 * - a skip's output, for the exclusions made before the exceptions, is one the definition feeds.
 *
 * The window is compared with `evaluatedAt` only when the rule has no `effectiveOn` (its
 * reference date is then the decision's). A window that cannot be decided (another reference
 * date, no `evaluatedAt`, a time zone that needs a calendar, a day cut by an instant bound) is
 * named once per rule in a notice (`window not checked: id@version (<why>)`); a reason this
 * check does not decide, unknown ones included, once per reason (`reason not checked: <reason>`).
 */
export function definitionFindings(
  proof: ProofView,
  matched: ReadonlyMap<string, RuleDefinition>,
  report: DefinitionFindings,
): void {
  const windows = new Map<string, boolean | string>();
  const unnamed = new Set<string>();
  const holds = (key: string, definition: RuleDefinition): boolean | undefined => {
    let held = windows.get(key);
    if (held === undefined) {
      held = windowHolds(proof, definition);
      windows.set(key, held);
      if (typeof held === 'string')
        report.unchecked(`window not checked: ${citeName(key)} (${held})`);
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
    }
    if (!CHECKED_REASONS.has(skip.reason) && !unnamed.has(skip.reason)) {
      unnamed.add(skip.reason);
      report.unchecked(`reason not checked: ${citeName(skip.reason)}`);
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
}
