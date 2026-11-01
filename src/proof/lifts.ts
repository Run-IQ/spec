import type { LiftedCheck, ProofSection, ProofStep } from './types.js';

// Internal to `@run-iq/spec`: the consistency checks a redacted entry can keep from being made
// (D-16). The preimage of a redacted entry is never checkable: its leaf hash is all the proof
// shows, and any content could be behind it. A problem that such an entry could explain is
// therefore not reported while one of the sections the check reads has a redacted entry: the
// check is lifted. Each site asks `isLifted` only once it has found such a problem, so the
// lifts recorded (`HiddenSections.lifted`) are the checks a redaction actually kept from
// failing, which `verifyProof` names. A redacted proof proves its visible part only
// (`authentic-redacted`, `consistent-redacted`), lifted check or not.
//
// Some checks are bounded (`PER_ENTRY`): each redacted entry of some of their sections explains
// at most one of their problems (one rule decided, one output named, one target fed). While
// only such sections lift one, it is lifted only when its problems are no more than those
// redacted entries; past them, every problem it found is reported (`overrunProblems`). The
// others cannot be bounded: one redacted entry of a section that lifts them may explain any
// number of their problems (a rule's standing reaches every item of its output, an exception
// every rule it affects, a grouped exclusion or pending entry every instance it holds).

/** A check and the sections whose redacted entries lift it. */
export interface Lift {
  check: string;
  sections: readonly ProofSection[];
}

const lift = (check: string, ...sections: ProofSection[]): Lift => ({ check, sections });

/**
 * Every check a redaction can lift, each with the sections that lift it, and whether it is
 * bounded (`PER_ENTRY`, its unit of problem in brackets) or why it is not.
 */
export const LIFTS = {
  // Bounded by rules: one rule entry is one rule [the bare id cited].
  ruleCitations: lift('cited rules listed', 'rules'),
  // Bounded by outputs: one output entry is one name [the name]; so are the next two.
  outputCitations: lift('cited outputs listed', 'outputs'),
  requestedOutputs: lift('requested outputs listed', 'outputs'),
  strataOutputs: lift('stratum outputs listed', 'outputs'),
  // Bounded by applied: one step feeds one target [the target]. Not by rules (a rule's
  // standing reaches every item of its output) nor exceptions (one reaches many decisions).
  outputValue: lift('output value from its contributions', 'rules', 'applied', 'exceptions'),
  causes: lift(
    'output status no stronger than its causes',
    'rules',
    'applied',
    'skipped',
    'exceptions',
  ),
  // causes: bounded by applied [the target], as the output value; a skipped entry may be a
  // grouped exclusion of many instances, a rule or an exception reaches many targets.
  // Not bounded: a grouped pending entry feeds every item of its instances.
  undeterminedCause: lift('undetermined output has a cause', 'pending'),
  // Bounded by applied [the target]: one step may be the winner of one target; not by rules.
  settledPending: lift('settled output without pending rules', 'rules', 'applied'),
  // Not bounded: one hidden instance makes the rank of every visible one of its rule valid.
  rankRange: lift('rank within the instances', 'applied'),
  // Not bounded: a grouped pending entry is a pending rule of every item of its instances.
  outputPending: lift('pending rules of an output', 'pending'),
  // Not bounded: one item is fed by any number of steps and exclusions.
  itemsOfCollection: lift('items of their collection', 'items'),
  // Bounded by items: one item is of one output [the output].
  perOutputItems: lift('per output against its items', 'items'),
  // Bounded by exceptions: one exception imposes on one output [the output].
  countForm: lift('form of a count', 'exceptions'),
  // Bounded by all four: one entry decides one rule [the rule].
  everyRuleDecided: lift(
    'every listed rule decided',
    'applied',
    'skipped',
    'pending',
    'exceptions',
  ),
  // Not bounded: one short circuit imposes the steps of every item of its output.
  decisionsAgainstExceptions: lift('decisions against the exceptions', 'exceptions'),
  // Not bounded, nor the next two: one exception affects any number of decisions.
  firedExceptions: lift('decisions of a fired carrier', 'skipped', 'exceptions'),
  exclusionException: lift('exclusion with its exception', 'exceptions'),
  affectedFound: lift('rules an exception affected', 'applied', 'skipped', 'pending', 'exceptions'),
  // Bounded by applied: one carrier step imposes one short circuit [the exception].
  shortCircuitCarrier: lift('short circuit with its carrier applied', 'applied'),
  // Not bounded: one loser excluded settles every tied claim of its output.
  tieLoser: lift('short circuit tie with its loser excluded', 'skipped'),
  // Bounded by exceptions: one record is of one carrier instance [the carrier].
  pendingCarrierFired: lift('pending carrier fired with its exceptions', 'exceptions'),
  // Not bounded: one pending carrier holds any number of targets.
  pendingCarrierChain: lift('pending carrier chain', 'pending'),
  // One problem at most, and the next: nothing to bound.
  provisionalSource: lift('provisional status has a source', 'factsRead', 'readsUndeclared'),
  conflictSource: lift('conflict status has a tie', 'skipped'),
  // Bounded by both: one record or exclusion is of one carrier instance [the carrier].
  carrierRecords: lift('carrier exception records against definitions', 'skipped', 'exceptions'),
  // Compared by number already (`verifyProof`): `rules missing`, `unexpected rules`.
  givenRules: lift('rules given against the proof', 'rules'),
} as const satisfies Record<string, Lift>;

/**
 * The bounded checks, each with the sections each of whose redacted entries explains at most
 * one of its problems (the table above says which unit).
 */
const PER_ENTRY: ReadonlyMap<Lift, readonly ProofSection[]> = new Map([
  [LIFTS.ruleCitations, ['rules']],
  [LIFTS.outputCitations, ['outputs']],
  [LIFTS.requestedOutputs, ['outputs']],
  [LIFTS.strataOutputs, ['outputs']],
  [LIFTS.outputValue, ['applied']],
  [LIFTS.causes, ['applied']],
  [LIFTS.settledPending, ['applied']],
  [LIFTS.perOutputItems, ['items']],
  [LIFTS.countForm, ['exceptions']],
  [LIFTS.everyRuleDecided, ['applied', 'skipped', 'pending', 'exceptions']],
  [LIFTS.shortCircuitCarrier, ['applied']],
  [LIFTS.pendingCarrierFired, ['exceptions']],
  [LIFTS.carrierRecords, ['skipped', 'exceptions']],
]);

/** What a check lifted: the problems it did not report, by unit, and whether they were taken. */
interface LiftRecord {
  units: Set<string>;
  problems: Set<string>;
  taken: boolean;
}

/**
 * The sections of a proof that have a redacted entry, and, when they are recorded
 * (`hiddenSections`), the number of redacted entries of each and the checks they lifted so far
 * (`isLifted`).
 */
export interface HiddenSections extends ReadonlySet<ProofSection> {
  readonly counts?: ReadonlyMap<ProofSection, number>;
  readonly lifted?: Map<Lift, LiftRecord>;
}

/** The sections of `counts` (redacted entries by section), recording what they lift. */
export function hiddenSections(counts: ReadonlyMap<ProofSection, number>): HiddenSections {
  return Object.assign(new Set(counts.keys()), { counts, lifted: new Map<Lift, LiftRecord>() });
}

/**
 * True when `hidden` lifts `check`: one of its sections has a redacted entry. Asked once the
 * check found `problem` (its message, and the unit a redacted entry explains, by default the
 * message), which a redacted entry could explain; recorded then (`HiddenSections`). A bounded
 * check gives its problem: past the redacted entries that could explain them, its problems are
 * reported (`overrunProblems`).
 */
export function isLifted(
  hidden: HiddenSections,
  check: Lift,
  problem?: { message: string; unit?: string },
): boolean {
  const lifted = check.sections.some((section) => hidden.has(section));
  if (lifted && hidden.lifted !== undefined) {
    let record = hidden.lifted.get(check);
    if (record === undefined) {
      record = { units: new Set(), problems: new Set(), taken: false };
      hidden.lifted.set(check, record);
    }
    if (problem !== undefined) {
      record.units.add(problem.unit ?? problem.message);
      record.problems.add(problem.message);
    }
  }
  return lifted;
}

/**
 * The number of problems of `check` the redacted entries of `hidden` can explain, or
 * `undefined` when it is not bounded (`PER_ENTRY`): one of the sections lifting it is not one
 * whose entries explain one problem each.
 */
function boundOf(hidden: HiddenSections, check: Lift): number | undefined {
  const perEntry = PER_ENTRY.get(check);
  if (perEntry === undefined || hidden.counts === undefined) return undefined;
  let bound = 0;
  for (const section of check.sections) {
    if (!hidden.has(section)) continue;
    if (!perEntry.includes(section)) return undefined;
    bound += hidden.counts.get(section) ?? 0;
  }
  return bound;
}

/** True when `check` lifted more problems than the redacted entries of `hidden` can explain. */
function overran(hidden: HiddenSections, check: Lift, record: LiftRecord): boolean {
  const bound = boundOf(hidden, check);
  return bound !== undefined && record.units.size > bound;
}

/**
 * The problems of the bounded checks that lifted more of them than the redacted entries could
 * explain, each said once, in the order of `LIFTS` then as found; each check is taken once (a
 * later call gives the checks lifted since).
 */
export function overrunProblems(hidden: HiddenSections): string[] {
  const problems: string[] = [];
  for (const entry of Object.values(LIFTS)) {
    const record = hidden.lifted?.get(entry);
    if (record === undefined || record.taken || !overran(hidden, entry, record)) continue;
    record.taken = true;
    problems.push(...record.problems);
  }
  return problems;
}

/** The checks `hidden` lifted (`isLifted`), in the order of `LIFTS`, past ones left out. */
export function liftedChecks(hidden: HiddenSections): LiftedCheck[] {
  const lifted: LiftedCheck[] = [];
  for (const entry of Object.values(LIFTS)) {
    const record = hidden.lifted?.get(entry);
    if (record === undefined || overran(hidden, entry, record)) continue;
    lifted.push({
      check: entry.check,
      redacted: entry.sections.filter((section) => hidden.has(section)),
    });
  }
  return lifted;
}

/**
 * The problems `check` finds with the steps `applied`, or, when it finds any while `exceptions`
 * has a redacted entry, those it finds without them (`decisionsAgainstExceptions`): any step
 * may be one a hidden short circuit imposed, the effect of an exception, not a decision.
 */
export function liftedOnSteps(
  hidden: HiddenSections,
  check: (steps: readonly ProofStep[]) => string[],
  applied: readonly ProofStep[],
): string[] {
  const issues = check(applied);
  if (issues.length === 0 || !isLifted(hidden, LIFTS.decisionsAgainstExceptions)) return issues;
  return check([]);
}
