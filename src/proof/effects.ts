import { OUTPUT_STATUSES } from '../decision/status.js';
import type { OutputStatus } from '../decision/status.js';
import { citeName } from '../errors.js';
import { parsePointer } from '../path/pointer.js';
import { qualifyName } from '../rule/ruleSet.js';
import { full } from './collect.js';
import { imposedKey, instanceKey } from './output-values.js';
import { ruleKey } from './precedence.js';
import type { Ties } from './ties.js';
import type {
  ProofException,
  ProofPending,
  ProofSection,
  ProofSkip,
  ProofStep,
  ProofView,
} from './types.js';
import { isLifted, liftedOnSteps, LIFTS } from './lifts.js';

// Internal to `@run-iq/spec`: what the decisions of a proof owe each other and the exceptions
// that produced some of them (D-7, D-8, D-21, R15-R18). Linear: each list is indexed once, and
// each subject walked once in a trie.

const rankOf = (status: OutputStatus): number => OUTPUT_STATUSES.indexOf(status);

/**
 * Internal: each listed rule that no entry decides (D-8: every rule ends applied, excluded or
 * pending), `rule not decided: id@version`, in the order of `rules`. A rule is decided by an
 * entry of `applied`, `skipped` or `pending`, or as the carrier of an exception. Not checked
 * while one of these sections has a redacted entry (`hidden`): it may be the decision.
 */
export function undecidedRules(
  p: ProofView,
  hidden: ReadonlySet<ProofSection> = new Set(),
): string[] {
  const decided = new Set<string>();
  for (const list of [p.applied, p.skipped, p.pending, p.exceptions]) {
    for (const entry of list) decided.add(ruleKey(entry));
  }
  const issues: string[] = [];
  for (const rule of p.rules) {
    if (full(issues)) break;
    const key = `${qualifyName(rule.ruleSet, rule.id)}@${rule.version}`;
    if (!decided.has(key)) issues.push(`rule not decided: ${citeName(key)}`);
  }
  // One entry decides one rule: the unit of the problems, bounded by the entries redacted.
  return issues.filter((message) => !isLifted(hidden, LIFTS.everyRuleDecided, { message }));
}

/**
 * Internal: what the decisions of each rule owe each other, in this order:
 * - `rule feeds two outputs: id@version`: its steps, exclusions and pending entries name more
 *   than one output (D-21: a rule has one output). The step its short circuit imposed on
 *   another output is the effect of its exception (`imposedSteps`), not one of its decisions;
 *   while `exceptions` has a redacted entry (`hidden`), any step may be one, and steps are not
 *   compared;
 * - `tie loser not in conflict: id@version[ at subject]`: an exclusion `RULE_CONFLICT` (a tie
 *   settled by `onConflict: 'first'`) is `conflict` (D-7).
 */
export function decisionProblems(
  p: ProofView,
  imposed: ReadonlySet<string>,
  hidden: ReadonlySet<ProofSection> = new Set(),
): string[] {
  return liftedOnSteps(hidden, (steps) => decisionsOf(p, imposed, steps), p.applied);
}

/** `decisionProblems`, the steps of `applied` being `steps`. */
function decisionsOf(
  p: ProofView,
  imposed: ReadonlySet<string>,
  steps: readonly ProofStep[],
): string[] {
  const issues: string[] = [];
  const outputs = new Map<string, string>();
  const reported = new Set<string>();
  const feeds = (entry: { ruleId: string; version: number }, output: string | undefined) => {
    if (output === undefined || full(issues)) return;
    const key = ruleKey(entry);
    const known = outputs.get(key);
    if (known === undefined) outputs.set(key, output);
    else if (known !== output && !reported.has(key)) {
      reported.add(key);
      issues.push(`rule feeds two outputs: ${citeName(key)}`);
    }
  };
  for (const step of steps) {
    if (!imposed.has(imposedKey(step, step.output))) feeds(step, step.output);
  }
  for (const skip of p.skipped) feeds(skip, skip.output);
  for (const entry of p.pending) feeds(entry, entry.output);
  for (const skip of p.skipped) {
    if (full(issues)) break;
    if (skip.reason === 'RULE_CONFLICT' && skip.status !== 'conflict') {
      issues.push(`tie loser not in conflict: ${citeName(instanceKey(skip))}`);
    }
  }
  return issues;
}

/**
 * The exclusions decided before the exceptions ran: no exception produced them, and a carrier
 * excluded for one fired nothing. They are those of core's filter (`RuleFilter`: dates, tags,
 * dimensions, the condition: `CONDITION_FALSE`, and its failures `DSL_NOT_FOUND`,
 * `CONDITION_TIMEOUT`, `DSL_ERROR`), and `NOT_REQUESTED`. Any other reason, known or not (D-6),
 * is decided by the rule's own evaluation after the exceptions (D-8: a plugin may still give
 * `INVALID_PARAMS`, `OUTPUT_MISMATCH`, …).
 */
export const BEFORE_EXCEPTIONS: ReadonlySet<string> = new Set([
  'INACTIVE_DATE',
  'TAG_MISMATCH',
  'DIMENSION_MISMATCH',
  'DSL_NOT_FOUND',
  'CONDITION_FALSE',
  'CONDITION_TIMEOUT',
  'DSL_ERROR',
  'NOT_REQUESTED',
]);

/** What each kind of exception does to the decisions it affects. */
const VERB: Readonly<Record<ProofException['kind'], string>> = {
  inhibit: 'inhibited',
  substitute: 'substituted',
  shortCircuit: 'short-circuited',
};

/** The exclusions only an exception explains, and the problem of one that none reached. */
const UNEXPLAINED: ReadonlyMap<string, string> = new Map([
  ['INHIBITED', 'inhibited without an exception'],
  ['SHORT_CIRCUITED', 'short-circuited without an exception'],
]);

/** The affected entries of one kind (and short-circuited output) that end at a node. */
interface Group {
  /** The strongest status of these exceptions. */
  rank: number;
  /** True once a decision they produced is found under the node. */
  produced: boolean;
  /** Each exception (its index) and affected entry. */
  entries: [number, { ruleId: string; subject?: string }][];
}

/** A node of the subjects one rule is affected at; the root, the rule without subject. */
interface Node {
  children: Map<string, Node>;
  groups: Map<string, Group>;
  /** The latest stratum of the exceptions whose affected entries end here (-1: none). */
  latest: number;
}

const newNode = (): Node => ({ children: new Map(), groups: new Map(), latest: -1 });

type Decision = ProofStep | ProofSkip | ProofPending;

/**
 * The kinds of exception that may have produced a decision. A substitution produced every
 * later decision of the rules it affected: a step, a pending entry (`UNDETERMINED`, or `ERROR`
 * with `INVALID_PARAMS` refused by its model, D-8), an exclusion after the exceptions (D-22:
 * `DOMINATED`, `RULE_CONFLICT`, …); not an exclusion decided before them (`INACTIVE_DATE`, …),
 * nor one another kind produced.
 */
function groupOf(decision: Decision, imposed: ReadonlySet<string>): string[] {
  if ('model' in decision) {
    // An applied step: substituted, or (refused below) applied though inhibited.
    return imposed.has(imposedKey(decision, decision.output)) ? [] : ['substitute'];
  }
  if (!('status' in decision)) return ['substitute'];
  if (decision.reason === 'INHIBITED') return ['inhibit'];
  if (decision.reason === 'SHORT_CIRCUITED') {
    return decision.output === undefined ? [] : [`shortCircuit\u0000${decision.output}`];
  }
  return BEFORE_EXCEPTIONS.has(decision.reason) ? [] : ['substitute'];
}

/**
 * Internal: the exceptions against the decisions they produced (D-7, D-21, R15-R18). An
 * affected entry `{ ruleId, subject? }` reaches the instances of the rule at its subject or
 * under it, every instance without subject. An inhibition produces the exclusions `INHIBITED`
 * of the rules it affects, a short circuit their exclusions `SHORT_CIRCUITED` from its output,
 * a substitution their later decisions (`groupOf`). The exceptions of a discarded carrier
 * (`Ties`, R15) produced nothing. In this order:
 * - the problems of discarded and excluded carriers (`Ties.problems`);
 * - `exception status differs from its carrier's decision: id@version[ at subject]`: its
 *   carrier is applied at its instance, with another status;
 * - `short circuit without its carrier applied: id@version[ at subject]`: no step of its
 *   carrier on the output it targets, though it affected rules or no other short circuit of
 *   that output has its carrier's step there;
 * - `inhibited rule applied: id@version[ at subject]`: a step an inhibition reaches;
 * - `affected rule not <inhibited|substituted|short-circuited> by id@version[ at subject]:
 *   rule[ at subject]`: an affected entry under which the exception produced nothing;
 * - `inhibited without an exception`, `short-circuited without an exception: id@version[ at
 *   subject]`: an exclusion no exception of that kind reaches;
 * - `decision weaker than the exception that affected it: id@version[ at subject]`: a
 *   decision an exception produced is weaker than it (D-7);
 * - `decision before the exception that affected it: id@version[ at subject]`: a decision of
 *   a rule an exception affects, at its subject or under it, of a stratum before the
 *   exception's (a carrier never runs after its target: core `carrierAfterTarget`).
 *
 * With redacted entries (`hidden`), what a hidden entry could make true is not reported: a short
 * circuit's step (`applied`); the decisions an exception produced (`applied`, `skipped`,
 * `pending`); the exception behind an exclusion (`exceptions`); and whatever needs to know
 * which exceptions fired (`skipped`, `exceptions`: a hidden exclusion `RULE_CONFLICT`, or an
 * earlier hidden exception, may make a visible one a discarded tie record, R15):
 * `inhibited rule applied`, `decision weaker than …`, `decision before …`.
 */
export function exceptionProblems(
  p: ProofView,
  imposed: ReadonlySet<string>,
  ties: Ties,
  hidden: ReadonlySet<ProofSection> = new Set(),
): string[] {
  const issues: string[] = [];
  const push = (issue: string): void => {
    if (!full(issues)) issues.push(issue);
  };
  const firedUnknown = (): boolean => isLifted(hidden, LIFTS.firedExceptions);
  for (const problem of ties.problems) push(problem);
  carrierProblems(p, imposed, ties, push, (message) =>
    isLifted(hidden, LIFTS.shortCircuitCarrier, { message }),
  );
  const tries = new Map<string, Node>();
  p.exceptions.forEach((exception, index) => {
    if (ties.discarded.has(index)) return;
    const kind =
      exception.kind === 'shortCircuit'
        ? `shortCircuit\u0000${exception.output ?? ''}`
        : exception.kind;
    for (const affected of exception.affected) {
      let node: Node = tries.get(affected.ruleId) ?? newNode();
      tries.set(affected.ruleId, node);
      for (const segment of affected.subject === undefined ? [] : parsePointer(affected.subject)) {
        let child: Node | undefined = node.children.get(segment);
        if (child === undefined) {
          child = newNode();
          node.children.set(segment, child);
        }
        node = child;
      }
      const group = node.groups.get(kind) ?? { rank: -1, produced: false, entries: [] };
      group.rank = Math.max(group.rank, rankOf(exception.status));
      group.entries.push([index, affected]);
      node.groups.set(kind, group);
      node.latest = Math.max(node.latest, exception.stratum);
    }
  });
  const weaker: string[] = [];
  const uncovered: string[] = [];
  const early: string[] = [];
  const decisions: Decision[] = [...p.applied, ...p.skipped, ...p.pending];
  for (const decision of decisions) {
    if (full(issues)) break;
    const kinds = groupOf(decision, imposed);
    let strongest = -1;
    let reached = false;
    let inhibited = false;
    let latest = -1;
    const visit = (node: Node): void => {
      latest = Math.max(latest, node.latest);
      for (const kind of kinds) {
        const group = node.groups.get(kind);
        if (group === undefined) continue;
        group.produced = true;
        reached = true;
        strongest = Math.max(strongest, group.rank);
      }
      if ('model' in decision && node.groups.has('inhibit')) inhibited = true;
    };
    let node = tries.get(decision.ruleId);
    if (node !== undefined) visit(node);
    for (const segment of decision.subject === undefined ? [] : parsePointer(decision.subject)) {
      node = node?.children.get(segment);
      if (node === undefined) break;
      visit(node);
    }
    const cited = (): string => citeName(instanceKey(decision));
    if (inhibited && !firedUnknown()) push(`inhibited rule applied: ${cited()}`);
    // A carrier runs before its targets or with them (core `carrierAfterTarget`). The step a
    // short circuit imposed is its carrier's, not a target's.
    const own = 'model' in decision && imposed.has(imposedKey(decision, decision.output));
    if (!own && decision.stratum < latest && !firedUnknown()) {
      early.push(`decision before the exception that affected it: ${cited()}`);
    }
    const unexplained =
      !reached && 'status' in decision && !('model' in decision)
        ? UNEXPLAINED.get(decision.reason)
        : undefined;
    if (unexplained !== undefined && !isLifted(hidden, LIFTS.exclusionException)) {
      uncovered.push(`${unexplained}: ${cited()}`);
    }
    // A pending decision is undetermined: never weaker.
    if (reached && 'status' in decision && rankOf(decision.status) < strongest && !firedUnknown()) {
      weaker.push(`decision weaker than the exception that affected it: ${cited()}`);
    }
  }
  const unproduced: [number, string][] = [];
  const stack = [...tries.values()];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    for (const child of node.children.values()) stack.push(child);
    for (const group of node.groups.values()) {
      if (group.produced) continue;
      for (const [index, affected] of group.entries) {
        const exception = p.exceptions[index];
        if (exception === undefined) continue;
        const at = affected.subject === undefined ? '' : ` at ${affected.subject}`;
        const by = citeName(instanceKey(exception));
        const rule = citeName(affected.ruleId + at);
        unproduced.push([index, `affected rule not ${VERB[exception.kind]} by ${by}: ${rule}`]);
      }
    }
  }
  // In the order of the exceptions, then of their affected entries.
  unproduced.sort((a, b) => a[0] - b[0]);
  // The decision an exception produced may be redacted.
  if (unproduced.length === 0 || !isLifted(hidden, LIFTS.affectedFound)) {
    for (const [, message] of unproduced) push(message);
  }
  for (const message of uncovered) push(message);
  for (const message of weaker) push(message);
  for (const message of early) push(message);
  return issues;
}

/**
 * The status of each exception against its carrier's step, and the carriers of short circuits
 * (not reported missing while `applied` has a redacted entry, `stepsHidden`).
 */
function carrierProblems(
  p: ProofView,
  imposed: ReadonlySet<string>,
  ties: Ties,
  push: (issue: string) => void,
  stepsHidden: (message: string) => boolean,
): void {
  const steps = new Map<string, ProofStep>();
  for (const step of p.applied) {
    if (!imposed.has(imposedKey(step, step.output))) steps.set(instanceKey(step), step);
  }
  const won = new Set<string>();
  for (const step of p.applied) {
    if (imposed.has(imposedKey(step, step.output))) {
      steps.set(imposedKey(step, step.output), step);
      won.add(step.output);
    }
  }
  p.exceptions.forEach((exception, index) => {
    if (ties.discarded.has(index)) return;
    const cited = citeName(instanceKey(exception));
    const { output } = exception;
    const carrier =
      exception.kind === 'shortCircuit' && output !== undefined
        ? steps.get(imposedKey(exception, output))
        : steps.get(instanceKey(exception));
    if (carrier !== undefined && carrier.status !== exception.status) {
      push(`exception status differs from its carrier's decision: ${cited}`);
    }
    if (exception.kind !== 'shortCircuit' || output === undefined || carrier !== undefined) {
      return;
    }
    // A carrier whose claim on the output another won affected nothing (R18).
    const missing = `short circuit without its carrier applied: ${cited}`;
    if ((exception.affected.length > 0 || !won.has(output)) && !stepsHidden(missing)) {
      push(missing);
    }
  });
}
