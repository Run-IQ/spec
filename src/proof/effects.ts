import { OUTPUT_STATUSES } from '../decision/status.js';
import type { OutputStatus } from '../decision/status.js';
import { citeName } from '../errors.js';
import { parsePointer } from '../path/pointer.js';
import { qualifyName } from '../rule/ruleSet.js';
import { instanceKey } from './output-values.js';
import type { ProofSkip, ProofStep, UnsignedProof } from './types.js';

// Internal to `@run-iq/spec`: what the decisions of a proof owe each other (D-7, D-8). Linear:
// each list is indexed once, and each subject walked once in a trie.

const rankOf = (status: OutputStatus): number => OUTPUT_STATUSES.indexOf(status);

/**
 * Internal: each listed rule that no entry decides (D-8: every rule ends applied, excluded or
 * pending), `rule not decided: id@version`, in the order of `rules`. A rule is decided by an
 * entry of `applied`, `skipped` or `pending`, or as the carrier of an exception.
 */
export function undecidedRules(p: UnsignedProof): string[] {
  const decided = new Set<string>();
  for (const entry of [...p.applied, ...p.skipped, ...p.pending, ...p.exceptions]) {
    decided.add(`${entry.ruleId}@${entry.version}`);
  }
  const issues: string[] = [];
  for (const rule of p.rules) {
    const key = `${qualifyName(rule.ruleSet, rule.id)}@${rule.version}`;
    if (!decided.has(key)) issues.push(`rule not decided: ${citeName(key)}`);
  }
  return issues;
}

/** A node of the subjects an exception affected, with the strongest status that reached it. */
interface Node {
  children: Map<string, Node>;
  rank: number;
}

const newNode = (): Node => ({ children: new Map(), rank: -1 });

/**
 * Internal: the statuses exceptions impose (D-7: a rule's decision is at least as strong as
 * that of the carrier that inhibited, substituted or short-circuited it), in this order:
 * - `exception status differs from its carrier's decision: id@version[ at subject]`: the
 *   carrier has an applied step at the exception's instance, of another status;
 * - `decision weaker than the exception that affected it: id@version[ at subject]`: an applied
 *   or skipped entry of an affected rule, at the affected subject or under it (D-21; an
 *   affected entry without subject covers every instance), is weaker than the exception.
 */
export function exceptionProblems(p: UnsignedProof): string[] {
  const issues: string[] = [];
  const steps = new Map<string, ProofStep>();
  for (const step of p.applied) steps.set(instanceKey(step), step);
  for (const exception of p.exceptions) {
    const carrier = steps.get(instanceKey(exception));
    if (carrier !== undefined && carrier.status !== exception.status) {
      const cited = citeName(instanceKey(exception));
      issues.push(`exception status differs from its carrier's decision: ${cited}`);
    }
  }
  const tries = new Map<string, Node>();
  for (const exception of p.exceptions) {
    const rank = rankOf(exception.status);
    for (const { ruleId, subject } of exception.affected) {
      let node: Node = tries.get(ruleId) ?? newNode();
      tries.set(ruleId, node);
      for (const segment of subject === undefined ? [] : parsePointer(subject)) {
        let child: Node | undefined = node.children.get(segment);
        if (child === undefined) {
          child = newNode();
          node.children.set(segment, child);
        }
        node = child;
      }
      node.rank = Math.max(node.rank, rank);
    }
  }
  const decisions: (ProofStep | ProofSkip)[] = [...p.applied, ...p.skipped];
  for (const decision of decisions) {
    let node = tries.get(decision.ruleId);
    let strongest = node?.rank ?? -1;
    for (const segment of decision.subject === undefined ? [] : parsePointer(decision.subject)) {
      node = node?.children.get(segment);
      if (node === undefined) break;
      strongest = Math.max(strongest, node.rank);
    }
    if (rankOf(decision.status) < strongest) {
      const cited = citeName(instanceKey(decision));
      issues.push(`decision weaker than the exception that affected it: ${cited}`);
    }
  }
  return issues;
}
