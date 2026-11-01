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
// feeds, names or holds, and the item, for a step or an item; a rule feeds one output, an
// exception and an exclusion are of one). A problem needs, per section of its row (`LIFTS`), the
// rule of an entry, its output, its output and item (`place`), the rule and output of one entry
// (`both`), or nothing it can tell (`free`: one entry may explain any number of such problems).
//
// A check computes from more than the entry it names: a problem's alternatives are every section
// whose hidden entry could change the computation behind it, with an identity only where that
// computation fixes it. The ties among exceptions (`tiesOf`) derive from the exclusions
// `RULE_CONFLICT`, the exceptions before and the standings of their carriers: while a hidden
// entry of `rules`, `skipped` or `exceptions` may change them (`Ties.uncertain`), each problem
// computed from them is free in those sections (`tie`: no alternative otherwise). A problem
// may narrow its row where its own computation reads less (`as`: a sum reads no standing).
//
// The requirements are matched to the redacted entries of their sections by Hall's condition,
// rules, outputs and the pairs of `both` each: for every set of sections, the requirements
// allowed only there are no more than its redacted entries. When it fails, no check is lifted:
// every problem lifted is reported and the proof is invalid. Requirements one entry could meet
// together (equal wherever both give a field, in a section both allow) are counted once: those
// counted pairwise need distinct entries, so a failure is never an honest redaction's. The most
// specific are counted first (`Z@1` and `Z@2` before `Z`), the closest count to the truth.
//
// A redacted proof proves its visible part only (`authentic-redacted`, `consistent-redacted`),
// lifted check or not.

/**
 * What a redacted entry of a section must carry to explain a problem of a check: its rule, its
 * output, its output and item (`place`), the rule and the output of one entry (`both`), nothing
 * it can tell (`free`), or nothing unless the ties may be hidden (`tie`, free then).
 */
type Need = 'rule' | 'output' | 'place' | 'both' | 'free' | 'tie';

/** A check and, for each section whose redacted entries may lift it, what such an entry needs. */
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
 * must carry to explain one of its problems, and why where it is `free`. The derivation inputs
 * of each check are listed in the report of Task 9K1 (round 5).
 */
export const LIFTS = {
  // A rules entry of the rule cited: `id@version`, or `id` when cited by id.
  ruleCitations: lift('cited rules listed', { rules: 'rule' }),
  // An outputs entry of the output cited, requested or in a stratum.
  outputCitations: lift('cited outputs listed', { outputs: 'output' }),
  requestedOutputs: lift('requested outputs listed', { outputs: 'output' }),
  strataOutputs: lift('stratum outputs listed', { outputs: 'output' }),
  // A step feeding the target (output, item); a short circuit of its output (it imposes on every
  // item); the standing of a rule of its output, where a standing is read (`highestPriority`;
  // `as` takes it out of a sum).
  outputValue: lift('output value from its contributions', {
    rules: 'output',
    applied: 'place',
    exceptions: 'output',
  }),
  // A step feeding the target; an exclusion of its output (a grouped one is a candidate of every
  // item); the ties (`tie`).
  causes: lift('output status no stronger than its causes', {
    rules: 'tie',
    applied: 'place',
    skipped: 'output',
    exceptions: 'tie',
  }),
  // The ties only: a tie the visible entries make may be a hidden one's undoing.
  tieStatus: lift('output status no weaker than its tie', {
    rules: 'tie',
    skipped: 'tie',
    exceptions: 'tie',
  }),
  // A pending entry of the target's output (a grouped one feeds every item of its instances).
  undeterminedCause: lift('undetermined output has a cause', { pending: 'output' }),
  // A step feeding the target, its winner; the standing of a rule of its output, where a
  // standing is read (`highestPriority`).
  settledPending: lift('settled output without pending rules', {
    rules: 'output',
    applied: 'place',
  }),
  // A step of the rule (`id@version`): one hidden instance more for every visible rank of it.
  rankRange: lift('rank within the instances', { applied: 'rule' }),
  // A pending entry of the rule missing (by id) on the target's output.
  outputPending: lift('pending rules of an output', { pending: 'both' }),
  // An item of the output, the element of its collection the step or pending rule is under.
  itemsOfCollection: lift('items of their collection', { items: 'place' }),
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
  // Free by exceptions (a hidden short circuit makes a step its effect, of any rule it imposes
  // on); the ties.
  firedExceptions: lift('decisions of a fired carrier', {
    rules: 'tie',
    skipped: 'tie',
    exceptions: 'free',
  }),
  // Free by exceptions: one exception produces any number of exclusions; the ties.
  exclusionException: lift('exclusion with its exception', {
    rules: 'tie',
    skipped: 'tie',
    exceptions: 'free',
  }),
  // Free: one decision a substitution produced may answer several exceptions; the ties.
  affectedFound: lift('rules an exception affected', {
    rules: 'tie',
    applied: 'free',
    skipped: 'free',
    pending: 'free',
    exceptions: 'free',
  }),
  // A step of the carrier instance on the output (`as`: when the exception affected nothing,
  // any step imposed on the output, or a short circuit of it, the winner's); the ties.
  shortCircuitCarrier: lift('short circuit with its carrier applied', {
    rules: 'tie',
    applied: 'both',
    skipped: 'tie',
    exceptions: 'output',
  }),
  // A short circuit of the carrier instance: it makes a step of the carrier the one it imposed.
  carrierStatus: lift('exception status as its carrier decided', { exceptions: 'rule' }),
  // The ties only: who tied with whom, who lost, what a loser recorded.
  tieLoser: lift('short circuit tie with its loser excluded', {
    rules: 'tie',
    skipped: 'tie',
    exceptions: 'tie',
  }),
  tieRecords: lift('tie records against their carriers', {
    rules: 'tie',
    skipped: 'tie',
    exceptions: 'tie',
  }),
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
  // A record or the exclusion of the carrier instance; the ties (who lost).
  carrierRecords: lift('carrier exception records against definitions', {
    rules: 'tie',
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
  ([Extract<N, 'output' | 'place' | 'both'>] extends [never]
    ? { output?: undefined }
    : { output: OutputIdentity });

/**
 * A problem a check found: its message, what a redacted entry must carry to explain it, the
 * sections where the ties it was computed from may be hidden (`ties`: free there), and where
 * its own computation reads less than its row (`as`: `none`, or a need its fields meet).
 */
export type Problem<N extends Need = Need> = {
  message: string;
  ties?: ReadonlySet<ProofSection>;
  as?: Readonly<Partial<Record<ProofSection, Exclude<N, 'tie'> | 'none'>>>;
} & Needs<N>;

/** One section a requirement allows (its bit), and the identity an entry of it must carry. */
interface Alternative {
  bit: number;
  /** The identity, most significant first; `undefined` where it says nothing. */
  fields: readonly (string | undefined)[];
}

/** What a lifted problem needs of one entry: one of its alternatives. */
interface Part {
  alternatives: readonly Alternative[];
  /** The sections of its alternatives. */
  mask: number;
}

/** What the redacted entries of a proof are asked to explain (`isLifted`). */
interface Ledger {
  /** The redacted entries of each section. */
  counts: ReadonlyMap<ProofSection, number>;
  /** The checks lifted, with the sections that lifted them. */
  lifted: Map<Lift, Set<ProofSection>>;
  /** The messages of the problems lifted, in the order found. */
  problems: string[];
  /** The rules, the outputs, and the rule and output of one entry, needed. */
  rules: Part[];
  outputs: Part[];
  pairs: Part[];
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
    lifted: new Map(),
    problems: [],
    rules: [],
    outputs: [],
    pairs: [],
    failed: false,
  };
  return Object.assign(new Set(counts.keys()), { ledger });
}

/**
 * The redacted entries of `section` in `hidden`: their count when recorded (`hiddenSections`),
 * any number when only the section is known to have one, none when it has none.
 */
export function redactedIn(hidden: ReadonlySet<ProofSection>, section: ProofSection): number {
  if (!hidden.has(section)) return 0;
  return (hidden as HiddenSections).ledger?.counts.get(section) ?? Number.POSITIVE_INFINITY;
}

const bit = (section: ProofSection): number => 1 << PROOF_SECTIONS.indexOf(section);

/** What `problem` needs of an entry of `section`, by its row `check` (`Problem`). */
function needOf(check: Lift, problem: Problem, section: ProofSection): Need | 'none' {
  if (problem.ties?.has(section) === true) return 'free';
  return problem.as?.[section] ?? check.needs[section] ?? 'none';
}

/**
 * True when `hidden` lifts `check` for `problem`: one of the sections it may be explained in
 * has a redacted entry, and the redacted entries have not already failed to explain what they
 * were asked. Asked once the check found `problem`; recorded then, with what a redacted entry
 * needs to explain it.
 */
export function isLifted<N extends Need>(
  hidden: HiddenSections,
  check: Lift<N>,
  problem: Problem<N>,
): boolean {
  const row = check as Lift;
  const asked = problem as Problem;
  const present = row.sections.filter((section) => {
    const need = needOf(row, asked, section);
    return hidden.has(section) && need !== 'none' && need !== 'tie';
  });
  if (present.length === 0) return false;
  const { ledger } = hidden;
  if (ledger === undefined) return true;
  if (ledger.failed) return false;
  const sections = ledger.lifted.get(row) ?? new Set<ProofSection>();
  for (const section of present) sections.add(section);
  ledger.lifted.set(row, sections);
  ledger.problems.push(asked.message);
  if (present.some((section) => needOf(row, asked, section) === 'free')) return true;
  const { rule, output } = asked;
  const ruleFields = rule && [
    rule.id,
    rule.version === undefined ? undefined : String(rule.version),
    rule.subject,
  ];
  const rules: Alternative[] = [];
  const outputs: Alternative[] = [];
  const pairs: Alternative[] = [];
  for (const section of present) {
    const need = needOf(row, asked, section);
    const at = bit(section);
    if (ruleFields !== undefined && (need === 'rule' || need === 'both')) {
      rules.push({ bit: at, fields: ruleFields });
    }
    if (output !== undefined && need !== 'rule') {
      const place = need === 'output' ? undefined : output.item;
      outputs.push({ bit: at, fields: [output.output, place] });
      if (ruleFields !== undefined && need === 'both') {
        pairs.push({ bit: at, fields: [...ruleFields, output.output, place] });
      }
    }
  }
  for (const [list, alternatives] of [
    [ledger.rules, rules],
    [ledger.outputs, outputs],
    [ledger.pairs, pairs],
  ] as const) {
    if (alternatives.length === 0) continue;
    const mask = alternatives.reduce((all, alternative) => all | alternative.bit, 0);
    list.push({ alternatives, mask });
  }
  return true;
}

/**
 * The problems lifted, each said once in the order found, when the redacted entries of
 * `hidden` cannot explain them all (Hall's condition, rules, outputs and pairs each); no check
 * is lifted then, and later ones are not. Empty when they can, or when already reported.
 */
export function unexplained(hidden: HiddenSections): string[] {
  const { ledger } = hidden;
  if (ledger === undefined || ledger.failed) return [];
  const capacity = new Array<number>(PROOF_SECTIONS.length).fill(0);
  for (const [section, count] of ledger.counts) capacity[PROOF_SECTIONS.indexOf(section)] = count;
  const explained = [ledger.rules, ledger.outputs, ledger.pairs].every((parts) =>
    matched(counted(parts), capacity),
  );
  if (explained) return [];
  ledger.failed = true;
  ledger.lifted.clear();
  return [...new Set(ledger.problems)];
}

/**
 * The checks `hidden` lifted (`isLifted`), in the order of `LIFTS`, each with the sections
 * that lifted it; none once unexplained.
 */
export function liftedChecks(hidden: HiddenSections): LiftedCheck[] {
  const lifted: LiftedCheck[] = [];
  for (const entry of Object.values(LIFTS) as Lift[]) {
    const sections = hidden.ledger?.lifted.get(entry);
    if (sections === undefined) continue;
    lifted.push({
      check: entry.check,
      redacted: PROOF_SECTIONS.filter((section) => sections.has(section)),
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
 * Internal (exported for its tests): true when distinct entries, `capacity[i]` in the section
 * of index `i`, can meet one requirement each of `masks` (each the sections it allows, bits):
 * Hall's condition over the sets of sections, linear in the masks plus 2^10 × 10.
 */
export function matched(masks: readonly number[], capacity: readonly number[]): boolean {
  const size = 1 << capacity.length;
  const need = new Array<number>(size).fill(0);
  for (const mask of masks) need[mask] = (need[mask] ?? 0) + 1;
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

/**
 * The specificity of an identity: each field given weighs more than all the fields after it,
 * so `Z@1` (id, version) comes before `Z at s` (id, subject), before `Z` (id).
 */
function weight(fields: readonly (string | undefined)[]): number {
  let total = 0;
  fields.forEach((field, i) => {
    if (field !== undefined) total += 1 << (fields.length - 1 - i);
  });
  return total;
}

/**
 * The keys an identity is found by (`counted`): for each set `scope` of field positions, the
 * positions it gives among them and their values. Another agrees with it (one entry may carry
 * both: equal wherever both give a field) exactly when, for `scope` the positions the other
 * gives, the keys meet (`agreeing`).
 */
function keysOf(at: number, fields: readonly (string | undefined)[]): string[] {
  const keys: string[] = [];
  for (let scope = 0; scope < 1 << fields.length; scope++) {
    keys.push(keyOf(at, scope, fields, givenIn(fields, scope)));
  }
  return keys;
}

/** The keys under which an identity agreeing with `fields` was filed (`keysOf`). */
function agreeing(at: number, fields: readonly (string | undefined)[]): string[] {
  const scope = givenIn(fields, (1 << fields.length) - 1);
  const keys: string[] = [];
  // Each subset `common` of the positions `fields` gives: those the other gives too.
  for (let common = scope; ; common = (common - 1) & scope) {
    keys.push(keyOf(at, scope, fields, common));
    if (common === 0) break;
  }
  return keys;
}

/** The positions of `scope` that `fields` gives. */
function givenIn(fields: readonly (string | undefined)[], scope: number): number {
  let given = 0;
  fields.forEach((field, i) => {
    if ((scope & (1 << i)) !== 0 && field !== undefined) given |= 1 << i;
  });
  return given;
}

function keyOf(
  at: number,
  scope: number,
  fields: readonly (string | undefined)[],
  given: number,
): string {
  const values = fields.map((field, i) => ((given & (1 << i)) !== 0 ? field : null));
  return JSON.stringify([at, scope, given, values]);
}

/**
 * The sections of the requirements `parts` counted, each needing an entry of its own. A
 * requirement is left out when one counted agrees with it in a section both allow (one entry
 * may meet both): those counted pairwise need distinct entries, which counts less than the
 * truth, never more. The most specific first (`weight`), then those in the fewest sections,
 * then in the order asked. Linear in the parts times their alternatives times 2^5.
 */
function counted(parts: readonly Part[]): number[] {
  const specificity = (part: Part): number =>
    Math.max(...part.alternatives.map((alternative) => weight(alternative.fields)));
  const order = parts
    .map((part, i) => ({ part, i, weight: specificity(part), sections: sections(part.mask) }))
    .sort((a, b) => b.weight - a.weight || a.sections - b.sections || a.i - b.i);
  const filed = new Set<string>();
  const masks: number[] = [];
  for (const { part } of order) {
    const met = part.alternatives.some(({ bit: at, fields }) =>
      agreeing(at, fields).some((key) => filed.has(key)),
    );
    if (met) continue;
    for (const { bit: at, fields } of part.alternatives) {
      for (const key of keysOf(at, fields)) filed.add(key);
    }
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
