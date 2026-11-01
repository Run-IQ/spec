import { OUTPUT_STATUSES } from '../decision/status.js';
import type { OutputStatus } from '../decision/status.js';
import { citeName } from '../errors.js';
import { parsePointer } from '../path/pointer.js';
import type { Target } from './combination.js';
import { instanceKey } from './output-values.js';
import { inStandingOrder, outranks, ruleKey } from './precedence.js';
import type { Standing, Standings } from './precedence.js';
import type { ProofPending, ProofSection, ProofStep } from './types.js';

// Internal to `@run-iq/spec`: what an output or item owes its trace beyond its value: its
// completeness (D-7, the table of Task 9M2), the order of its pending rules (D-5), the ranks of
// competing instances (D-21), and a status that is the strongest of its causes (D-7).

const rankOf = (status: OutputStatus): number => OUTPUT_STATUSES.indexOf(status);
const CONFLICT = rankOf('conflict');

/** The sections whose entries are the causes of a status (`causeProblems`). */
const CAUSE_SECTIONS: readonly ProofSection[] = ['rules', 'applied', 'skipped', 'exceptions'];

/** What feeds one output or item: its steps, its pending rules, its strongest exclusion. */
export interface Feed {
  steps: ProofStep[];
  /** The ids of the pending rules, and their entries. */
  pending: string[];
  waiting: ProofPending[];
  /** The rank of the strongest exclusion that would have fed it, -1 when none. */
  candidates: number;
  /** True when a tie settled among exceptions puts it in `conflict` (D-7, `Ties`). */
  tie: boolean;
}

/**
 * True when `subject` is an element of the collection `per` (`/foyers/*\/personnes`): its
 * segments are those of `per`, each `*` an element segment (`@<key>`), then one element
 * segment (D-2). A subject deeper or shallower, an index, a group or a time segment is not.
 */
export function inCollection(per: string, subject: string): boolean {
  const pattern = parsePointer(per);
  const segments = parsePointer(subject);
  if (segments.length !== pattern.length + 1) return false;
  const element = (segment: string | undefined): boolean => segment?.startsWith('@') === true;
  return (
    pattern.every((part, i) => (part === '*' ? element(segments[i]) : part === segments[i])) &&
    element(segments[pattern.length])
  );
}

/**
 * True when the target is `undetermined` by its trace (D-7, the table of Task 9M2): a pending
 * rule feeds it, except an `any` with a `true` contribution, an `all` with a `false` one, and a
 * `highestPriority` whose winner (the step `selected` names) stands strictly above every pending
 * rule feeding it, by precedence then priority (D-23); or it is an `all` no rule reached,
 * without `empty`.
 */
function undeterminedByTrace(target: Target, feed: Feed, standings: Standings): boolean {
  const { combine, empty } = target.declaration;
  if (feed.pending.length === 0) {
    return combine === 'all' && feed.steps.length === 0 && empty !== true;
  }
  if (combine === 'highestPriority') return !outranksPending(target, feed, standings);
  const decisive = combine === 'any' ? true : combine === 'all' ? false : undefined;
  return decisive === undefined || !feed.steps.some((step) => step.contribution === decisive);
}

/** True when the winner of `target` stands strictly above every pending rule feeding it. */
function outranksPending(target: Target, feed: Feed, standings: Standings): boolean {
  const { selected } = target;
  if (selected === undefined) return false;
  const winner = feed.steps.find(
    (step) => step.ruleId === selected.ruleId && step.subject === selected.subject,
  );
  const top = winner === undefined ? undefined : standings.get(ruleKey(winner));
  if (top === undefined) return false;
  return feed.waiting.every((entry) => {
    const standing = standings.get(ruleKey(entry));
    return standing !== undefined && outranks(top, standing);
  });
}

/**
 * The completeness of an output or item: `undetermined output without a cause` (undetermined,
 * though no pending rule nor emptiness makes it so; not reported while `pending` has a redacted
 * entry, `hidden`, which may be its cause), `settled output with pending rules` (not reported
 * while `applied` or `rules` has one: a hidden decisive step, or the winner of a
 * `highestPriority` and the standings of its rules, may settle it).
 */
export function completenessProblems(
  target: Target,
  feed: Feed,
  standings: Standings,
  hidden: ReadonlySet<ProofSection> = new Set(),
): string[] {
  const byTrace = undeterminedByTrace(target, feed, standings);
  if (target.status === 'undetermined') {
    if (byTrace || hidden.has('pending')) return [];
    return [`undetermined output without a cause: ${target.cite()}`];
  }
  // An `all` no rule reached is reported by `combinationProblems`.
  const pending = feed.pending.length > 0;
  if (hidden.has('applied') || hidden.has('rules')) return [];
  return byTrace && pending ? [`settled output with pending rules: ${target.cite()}`] : [];
}

/** True when the rule ids `pending` are, as a set, the rules listed in `named`. */
export function samePending(named: readonly string[], pending: readonly string[]): boolean {
  const expected = new Set(pending);
  const given = new Set(named);
  return (
    given.size === named.length &&
    given.size === expected.size &&
    named.every((id) => expected.has(id))
  );
}

/** True when `pending` (rule ids) is in contribution order, each standing as its entries do. */
export function pendingInOrder(
  pending: readonly string[],
  feed: Feed,
  standings: Standings,
): boolean {
  const first = new Map<string, Standing | undefined>();
  for (const entry of feed.waiting) {
    if (!first.has(entry.ruleId)) first.set(entry.ruleId, standings.get(ruleKey(entry)));
  }
  return inStandingOrder(pending, (id) => first.get(id));
}

/**
 * The ranks of the steps of a target (D-21): each step with a subject feeding a
 * `highestPriority` output without `per` carries one (`rank missing: id@version at subject`),
 * below the number of instances of its rule there (`rank out of range`; not reported while
 * `applied` has a redacted entry, `hidden`: the other instances may be hidden); no other step
 * carries one (`rank on a step that does not compete`).
 */
export function rankProblems(
  target: Target,
  hidden: ReadonlySet<ProofSection> = new Set(),
): string[] {
  const competing = target.whole && target.declaration.combine === 'highestPriority';
  const issues: string[] = [];
  const instances = new Map<string, number>();
  if (competing) {
    for (const step of target.steps) {
      if (step.subject !== undefined) {
        instances.set(ruleKey(step), (instances.get(ruleKey(step)) ?? 0) + 1);
      }
    }
  }
  for (const step of target.steps) {
    const cited = (): string => citeName(instanceKey(step));
    if (!competing || step.subject === undefined) {
      if (step.rank !== undefined) issues.push(`rank on a step that does not compete: ${cited()}`);
    } else if (step.rank === undefined) {
      issues.push(`rank missing: ${cited()}`);
    } else if (step.rank >= (instances.get(ruleKey(step)) ?? 0) && !hidden.has('applied')) {
      issues.push(`rank out of range: ${cited()}`);
    }
  }
  return issues;
}

/**
 * The status of a target against its causes (D-7): no weaker than its steps, its candidate
 * exclusions and a tie settled among exceptions (`output status weaker than its
 * contributions`, `… than its candidates`, `… than its tie`); once settled, never stronger
 * than the strongest of them (`output status stronger than its causes`): a `conflict` comes
 * from the decisions a tie settled or from a tie among exceptions the proof shows (two short
 * circuits at the top, a discarded carrier), `provisional` from the decisions an assertion
 * made so. The causes seen are a part of them while `rules`, `applied`, `skipped` or
 * `exceptions` has a redacted entry (`hidden`): a status stronger than those seen is then not
 * reported, one weaker still is.
 */
export function causeProblems(
  target: Target,
  feed: Feed,
  hidden: ReadonlySet<ProofSection> = new Set(),
): string[] {
  const issues: string[] = [];
  const rank = rankOf(target.status);
  let steps = -1;
  for (const step of feed.steps) steps = Math.max(steps, rankOf(step.status));
  if (steps > rank) issues.push(`output status weaker than its contributions: ${target.cite()}`);
  if (feed.candidates > rank) {
    issues.push(`output status weaker than its candidates: ${target.cite()}`);
  }
  const tie = feed.tie ? CONFLICT : -1;
  if (tie > rank) issues.push(`output status weaker than its tie: ${target.cite()}`);
  const settled = target.status !== 'undetermined';
  const partial = CAUSE_SECTIONS.some((section) => hidden.has(section));
  if (settled && !partial && rank > Math.max(0, steps, feed.candidates, tie)) {
    issues.push(`output status stronger than its causes: ${target.cite()}`);
  }
  return issues;
}
