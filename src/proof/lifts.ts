import { PROOF_SECTIONS } from './types.js';
import type { LiftedCheck, ProofSection, ProofStep } from './types.js';

// Internal to `@run-iq/spec`: the consistency checks a redacted entry can keep from being made
// (D-16), and what the redacted entries of a proof can explain at most.
//
// The preimage of a redacted entry is never checkable: its leaf hash is all the proof shows, and
// any content could be behind it. A problem that such an entry could explain is therefore not
// reported while one of the sections the check reads has a redacted entry: the check is lifted.
// Each site asks `isLifted` only once it has found such a problem, and says what entry would
// explain it: the identity that entry would carry (`Problem`), in the sections its row allows
// (`LIFTS`). The lifts recorded are the checks a redaction actually kept from failing, which
// `verifyProof` names (`liftedChecks`).
//
// One accounting for the whole proof (`unexplained`): the problems lifted must be explained by
// distinct redacted entries, an entry explaining several only when one entry could carry what
// each needs. An entry of a section has a rule (`RuleIdentity`: the rule, version and subject of
// its decision, or the rule of a `rules` entry) and an output (`OutputIdentity`: the output it
// feeds, names or holds, and the item, for a step or an item). A problem needs, per its row, the
// rule of an entry, its output, both, or nothing it can tell (`free`: one entry may explain any
// number of such problems). The requirements are matched to the redacted entries of their
// sections by Hall's condition, rules and outputs each: for every set of sections, the
// requirements allowed only there are no more than its redacted entries. When it fails, no
// check is lifted: every problem lifted is reported and the proof is invalid.
//
// What makes it exact, and where it counts less than the truth (never more, so an honest
// redaction is never refused):
// - two requirements with the same identity in one section are one entry; two different
//   identities (`Z@1` and `Z@2`, two outputs, two items) never are;
// - of one identity in overlapping sections, only the one in the fewest is counted (exact when
//   they nest, as the rows make them);
// - a less specific requirement (a rule without its version or subject, an output without its
//   item) is not counted when it agrees with one counted and shares a section with it: an entry
//   of that one may meet it (exact when it may only be met there; otherwise one less);
// - an entry's rule and its output are counted apart: one step may be both the decision of a
//   rule and the contribution a target lacks (one entry for a rule and an output requirement).
//
// A redacted proof proves its visible part only (`authentic-redacted`, `consistent-redacted`),
// lifted check or not.

/** What a redacted entry of a section must carry to explain a problem of a check. */
type Need = 'rule' | 'output' | 'both' | 'free';

/** A check and, for each section whose redacted entries lift it, what such an entry needs. */
export interface Lift<N extends Need = Need> {
  check: string;
  sections: readonly ProofSection[];
  needs: Readonly<Partial<Record<ProofSection, N>>>;
}

const lift = <N extends Need>(check: string, needs: Partial<Record<ProofSection, N>>): Lift<N> => ({
  check,
  sections: PROOF_SECTIONS.filter((section) => needs[section] !== undefined),
  needs,
});

/**
 * Every check a redaction can lift, with what a redacted entry of each section that lifts it
 * must carry to explain one of its problems, and why where it is `free`.
 */
export const LIFTS = {
  // A rules entry of the rule cited: `id@version`, or `id` when cited by id.
  ruleCitations: lift('cited rules listed', { rules: 'rule' }),
  // An outputs entry of the output cited, requested or in a stratum.
  outputCitations: lift('cited outputs listed', { outputs: 'output' }),
  requestedOutputs: lift('requested outputs listed', { outputs: 'output' }),
  strataOutputs: lift('stratum outputs listed', { outputs: 'output' }),
  // A step feeding the target (output, item). Free by rules (the standing of one rule reaches
  // every target of its output) and by exceptions (one short circuit imposes on every item).
  outputValue: lift('output value from its contributions', {
    rules: 'free',
    applied: 'output',
    exceptions: 'free',
  }),
  // A step feeding the target; free by rules and exceptions (as the value) and by skipped (one
  // grouped exclusion is a candidate of every item of its instances).
  causes: lift('output status no stronger than its causes', {
    rules: 'free',
    applied: 'output',
    skipped: 'free',
    exceptions: 'free',
  }),
  // A pending entry of the target's output (a grouped one feeds every item of its instances).
  undeterminedCause: lift('undetermined output has a cause', { pending: 'output' }),
  // A step feeding the target, its winner; free by rules (as the value).
  settledPending: lift('settled output without pending rules', {
    rules: 'free',
    applied: 'output',
  }),
  // A step of the rule (`id@version`): one hidden instance more for every visible rank of it.
  rankRange: lift('rank within the instances', { applied: 'rule' }),
  // A pending entry of the rule missing (by id) on the target's output.
  outputPending: lift('pending rules of an output', { pending: 'both' }),
  // An item of the output, the element of its collection the step or pending rule is under.
  itemsOfCollection: lift('items of their collection', { items: 'output' }),
  // An item of the per output.
  perOutputItems: lift('per output against its items', { items: 'output' }),
  // A short circuit of the output.
  countForm: lift('form of a count', { exceptions: 'output' }),
  // A decision of the rule (`id@version`): a step, an exclusion, a pending entry, a record.
  everyRuleDecided: lift('every listed rule decided', {
    applied: 'rule',
    skipped: 'rule',
    pending: 'rule',
    exceptions: 'rule',
  }),
  // Free: one short circuit imposes the steps of every item of its output.
  decisionsAgainstExceptions: lift('decisions against the exceptions', { exceptions: 'free' }),
  // Free, and the next two: one exception affects any number of decisions, one exclusion
  // `RULE_CONFLICT` may discard any number of exceptions (R15).
  firedExceptions: lift('decisions of a fired carrier', { skipped: 'free', exceptions: 'free' }),
  exclusionException: lift('exclusion with its exception', { exceptions: 'free' }),
  affectedFound: lift('rules an exception affected', {
    applied: 'free',
    skipped: 'free',
    pending: 'free',
    exceptions: 'free',
  }),
  // A step of the carrier instance (`id@version at subject`).
  shortCircuitCarrier: lift('short circuit with its carrier applied', { applied: 'rule' }),
  // Free: a carrier may carry short circuits on several outputs, so one loser excluded may
  // settle a tie on each.
  tieLoser: lift('short circuit tie with its loser excluded', { skipped: 'free' }),
  // A record of the carrier instance.
  pendingCarrierFired: lift('pending carrier fired with its exceptions', { exceptions: 'rule' }),
  // Free: one pending carrier holds any number of targets, at any depth of a chain.
  pendingCarrierChain: lift('pending carrier chain', { pending: 'free' }),
  // Free, and the next: one problem at most, of the whole proof.
  provisionalSource: lift('provisional status has a source', {
    factsRead: 'free',
    readsUndeclared: 'free',
  }),
  conflictSource: lift('conflict status has a tie', { skipped: 'free' }),
  // A record or the exclusion of the carrier instance.
  carrierRecords: lift('carrier exception records against definitions', {
    skipped: 'rule',
    exceptions: 'rule',
  }),
  // A rules entry of the rule given (`id@version`).
  givenRules: lift('rules given against the proof', { rules: 'rule' }),
} as const satisfies Record<string, Lift>;

/** The rule an entry carries: a rules entry's, or a decision's, with its subject. */
export interface RuleIdentity {
  /** Qualified (D-37). */
  id: string;
  version?: number;
  subject?: string;
}

/** The output an entry carries, and the item a step feeds or an item is. */
export interface OutputIdentity {
  output: string;
  item?: string;
}

type Needs<N extends Need> = ([Extract<N, 'rule' | 'both'>] extends [never]
  ? { rule?: undefined }
  : { rule: RuleIdentity }) &
  ([Extract<N, 'output' | 'both'>] extends [never]
    ? { output?: undefined }
    : { output: OutputIdentity });

/** A problem a check found: its message, and what a redacted entry must carry to explain it. */
export type Problem<N extends Need = Need> = { message: string } & Needs<N>;

/** What a lifted problem needs of one half of an entry, in the sections allowed (bits). */
interface Part {
  /** The identity, most significant first (`id`, `version`, `subject`; `output`, `item`). */
  fields: readonly (string | undefined)[];
  mask: number;
}

/** What the redacted entries of a proof are asked to explain (`isLifted`). */
interface Ledger {
  /** The redacted entries of each section. */
  counts: ReadonlyMap<ProofSection, number>;
  lifted: Set<Lift>;
  /** The messages of the problems lifted, in the order found. */
  problems: string[];
  rules: Part[];
  outputs: Part[];
  /** True once the redacted entries could not explain the problems (`unexplained`). */
  failed: boolean;
}

/**
 * The sections of a proof that have a redacted entry and, when they are recorded
 * (`hiddenSections`), what the checks asked of them (`isLifted`).
 */
export interface HiddenSections extends ReadonlySet<ProofSection> {
  readonly ledger?: Ledger;
}

/** The sections of `counts` (redacted entries by section), recording what they are asked. */
export function hiddenSections(counts: ReadonlyMap<ProofSection, number>): HiddenSections {
  const ledger: Ledger = {
    counts,
    lifted: new Set(),
    problems: [],
    rules: [],
    outputs: [],
    failed: false,
  };
  return Object.assign(new Set(counts.keys()), { ledger });
}

const bit = (section: ProofSection): number => 1 << PROOF_SECTIONS.indexOf(section);

/**
 * True when `hidden` lifts `check` for `problem`: one of its sections has a redacted entry, and
 * the redacted entries have not already failed to explain what they were asked. Asked once the
 * check found `problem`; recorded then, with what a redacted entry needs to explain it.
 */
export function isLifted<N extends Need>(
  hidden: HiddenSections,
  check: Lift<N>,
  problem: Problem<N>,
): boolean {
  const present = check.sections.filter((section) => hidden.has(section));
  if (present.length === 0) return false;
  const { ledger } = hidden;
  if (ledger === undefined) return true;
  if (ledger.failed) return false;
  ledger.lifted.add(check);
  ledger.problems.push(problem.message);
  if (present.some((section) => check.needs[section] === 'free')) return true;
  let rules = 0;
  let outputs = 0;
  for (const section of present) {
    const need = check.needs[section];
    if (need === 'rule' || need === 'both') rules |= bit(section);
    if (need === 'output' || need === 'both') outputs |= bit(section);
  }
  const { rule, output } = problem as Problem;
  if (rules !== 0 && rule !== undefined) {
    const version = rule.version === undefined ? undefined : String(rule.version);
    ledger.rules.push({ fields: [rule.id, version, rule.subject], mask: rules });
  }
  if (outputs !== 0 && output !== undefined) {
    ledger.outputs.push({ fields: [output.output, output.item], mask: outputs });
  }
  return true;
}

/**
 * The problems lifted, each said once in the order found, when the redacted entries of
 * `hidden` cannot explain them all (Hall's condition, rules and outputs each); no check is
 * lifted then, and later ones are not. Empty when they can, or when already reported.
 */
export function unexplained(hidden: HiddenSections): string[] {
  const { ledger } = hidden;
  if (ledger === undefined || ledger.failed) return [];
  const capacity = new Array<number>(PROOF_SECTIONS.length).fill(0);
  for (const [section, count] of ledger.counts) capacity[PROOF_SECTIONS.indexOf(section)] = count;
  if (matched(ledger.rules, capacity) && matched(ledger.outputs, capacity)) return [];
  ledger.failed = true;
  ledger.lifted.clear();
  return [...new Set(ledger.problems)];
}

/** The checks `hidden` lifted (`isLifted`), in the order of `LIFTS`; none once unexplained. */
export function liftedChecks(hidden: HiddenSections): LiftedCheck[] {
  const lifted: LiftedCheck[] = [];
  for (const entry of Object.values(LIFTS) as Lift[]) {
    if (!hidden.ledger?.lifted.has(entry)) continue;
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
  const without = check([]);
  const kept = new Set(without);
  const lifted = issues.filter((message) => !kept.has(message));
  for (const message of lifted) {
    if (!isLifted(hidden, LIFTS.decisionsAgainstExceptions, { message })) return issues;
  }
  return without;
}

/**
 * True when distinct entries, `capacity[i]` in the section of index `i`, can meet `parts`, one
 * each where one entry cannot meet two (see the head of this file): Hall's condition over the
 * sets of sections, linear in the parts plus 2^10 × 10.
 */
function matched(parts: readonly Part[], capacity: readonly number[]): boolean {
  const size = 1 << capacity.length;
  const need = new Array<number>(size).fill(0);
  for (const mask of counted(parts)) need[mask] = (need[mask] ?? 0) + 1;
  const room = new Array<number>(size).fill(0);
  for (let set = 1; set < size; set++) {
    const low = Math.log2(set & -set);
    room[set] = (room[set & (set - 1)] ?? 0) + (capacity[low] ?? 0);
  }
  // The requirements allowed only within each set of sections (sum over subsets).
  for (let b = 0; b < capacity.length; b++) {
    for (let set = 0; set < size; set++) {
      if ((set & (1 << b)) !== 0) need[set] = (need[set] ?? 0) + (need[set ^ (1 << b)] ?? 0);
    }
  }
  for (let set = 1; set < size; set++) if ((need[set] ?? 0) > (room[set] ?? 0)) return false;
  return true;
}

const keyOf = (fields: readonly (string | undefined)[]): string =>
  JSON.stringify(fields.map((field) => field ?? null));

/**
 * The sections of the requirements `parts` counted, each needing an entry of its own: the
 * others may share an entry with one counted, and are left out, which counts less than the
 * truth, never more (the head of this file). Those with the most fields given first, the
 * second given before not, then those in the fewest sections, then in the order asked: of one identity in overlapping
 * sections, the one in the fewest is counted; a less specific one is left out when it agrees
 * with one counted (equal wherever both give a field) and shares a section with it. Linear in
 * the parts times the sets of sections a row asks.
 */
function counted(parts: readonly Part[]): number[] {
  const given = (part: Part): number => part.fields.filter((field) => field !== undefined).length;
  const order = [...parts]
    .map((part, i) => ({ part, i }))
    .sort(
      (a, b) =>
        given(b.part) - given(a.part) ||
        Number(b.part.fields[1] !== undefined) - Number(a.part.fields[1] !== undefined) ||
        sections(a.part.mask) - sections(b.part.mask) ||
        a.i - b.i,
    );
  const byIdentity = new Map<string, number[]>();
  // The masks counted, by first field, then by the second given or not.
  const classes = new Map<string | undefined, Map<string, number[]>>();
  const shares = (masks: readonly number[] | undefined, mask: number): boolean =>
    (masks ?? []).some((other) => (other & mask) !== 0);
  const masks: number[] = [];
  for (const { part } of order) {
    const identity = keyOf(part.fields);
    if (shares(byIdentity.get(identity), part.mask)) continue;
    const [first, second] = part.fields;
    const bySecond = classes.get(first) ?? new Map<string, number[]>();
    if (given(part) < part.fields.length) {
      // Without its second field it agrees with every one of its first; with it, with those of
      // the same second field (it leaves out a field after the second). Those without it come
      // after it, and meet it then.
      const reached =
        second === undefined ? [...bySecond.values()] : [bySecond.get(keyOf([second]))];
      if (reached.some((list) => shares(list, part.mask))) continue;
    }
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), part.mask]);
    const secondKey = keyOf([second]);
    bySecond.set(secondKey, [...(bySecond.get(secondKey) ?? []), part.mask]);
    classes.set(first, bySecond);
    masks.push(part.mask);
  }
  return masks;
}

/** The number of sections in `mask`. */
function sections(mask: number): number {
  let count = 0;
  for (let rest = mask; rest !== 0; rest &= rest - 1) count++;
  return count;
}
