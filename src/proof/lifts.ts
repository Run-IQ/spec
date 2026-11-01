import type { LiftedCheck, ProofSection, ProofStep } from './types.js';

// Internal to `@run-iq/spec`: the consistency checks a redacted entry can keep from being made
// (D-16). The preimage of a redacted entry is never checkable: its leaf hash is all the proof
// shows, and any content could be behind it. A problem that such an entry could explain is
// therefore not reported while one of the sections the check reads has a redacted entry: the
// check is lifted. Each site asks `isLifted` only once it has found such a problem, so the
// lifts recorded (`HiddenSections.lifted`) are the checks a redaction actually kept from
// failing, which `verifyProof` names. A redacted proof proves its visible part only
// (`authentic-redacted`, `consistent-redacted`), lifted check or not.

/** A check and the sections whose redacted entries lift it. */
export interface Lift {
  check: string;
  sections: readonly ProofSection[];
}

const lift = (check: string, ...sections: ProofSection[]): Lift => ({ check, sections });

/** Every check a redaction can lift, each with the sections that lift it. */
export const LIFTS = {
  ruleCitations: lift('cited rules listed', 'rules'),
  outputCitations: lift('cited outputs listed', 'outputs'),
  requestedOutputs: lift('requested outputs listed', 'outputs'),
  strataOutputs: lift('stratum outputs listed', 'outputs'),
  outputValue: lift('output value from its contributions', 'rules', 'applied', 'exceptions'),
  causes: lift(
    'output status no stronger than its causes',
    'rules',
    'applied',
    'skipped',
    'exceptions',
  ),
  undeterminedCause: lift('undetermined output has a cause', 'pending'),
  settledPending: lift('settled output without pending rules', 'rules', 'applied'),
  rankRange: lift('rank within the instances', 'applied'),
  outputPending: lift('pending rules of an output', 'pending'),
  itemsOfCollection: lift('items of their collection', 'items'),
  perOutputItems: lift('per output against its items', 'items'),
  countForm: lift('form of a count', 'exceptions'),
  everyRuleDecided: lift(
    'every listed rule decided',
    'applied',
    'skipped',
    'pending',
    'exceptions',
  ),
  decisionsAgainstExceptions: lift('decisions against the exceptions', 'exceptions'),
  firedExceptions: lift('decisions of a fired carrier', 'skipped', 'exceptions'),
  exclusionException: lift('exclusion with its exception', 'exceptions'),
  affectedFound: lift('rules an exception affected', 'applied', 'skipped', 'pending', 'exceptions'),
  shortCircuitCarrier: lift('short circuit with its carrier applied', 'applied'),
  tieLoser: lift('short circuit tie with its loser excluded', 'skipped'),
  pendingCarrierFired: lift('pending carrier fired with its exceptions', 'exceptions'),
  pendingCarrierChain: lift('pending carrier chain', 'pending'),
  provisionalSource: lift('provisional status has a source', 'factsRead', 'readsUndeclared'),
  conflictSource: lift('conflict status has a tie', 'skipped'),
  carrierRecords: lift('carrier exception records against definitions', 'skipped', 'exceptions'),
  givenRules: lift('rules given against the proof', 'rules'),
} as const satisfies Record<string, Lift>;

/**
 * The sections of a proof that have a redacted entry, and the checks they lifted so far
 * (`isLifted`), when they are recorded (`hiddenSections`).
 */
export interface HiddenSections extends ReadonlySet<ProofSection> {
  readonly lifted?: Set<Lift>;
}

/** `sections`, recording the checks they lift (`isLifted`). */
export function hiddenSections(sections: Iterable<ProofSection>): HiddenSections {
  return Object.assign(new Set(sections), { lifted: new Set<Lift>() });
}

/**
 * True when `hidden` lifts `check`: one of its sections has a redacted entry. Asked once the
 * check found a problem that a redacted entry could explain; recorded then (`HiddenSections`).
 */
export function isLifted(hidden: HiddenSections, check: Lift): boolean {
  const lifted = check.sections.some((section) => hidden.has(section));
  if (lifted) hidden.lifted?.add(check);
  return lifted;
}

/** The checks `hidden` lifted (`isLifted`), in the order of `LIFTS`. */
export function liftedChecks(hidden: HiddenSections): LiftedCheck[] {
  const lifted: LiftedCheck[] = [];
  for (const entry of Object.values(LIFTS)) {
    if (!hidden.lifted?.has(entry)) continue;
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
