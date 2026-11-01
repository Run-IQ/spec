import { citeName } from '../errors.js';
import { parsePointer } from '../path/pointer.js';
import { instanceKey } from './output-values.js';
import { outranks, ruleKey, sameLevel } from './precedence.js';
import type { Standing, Standings } from './precedence.js';
import type { ProofSkip, UnsignedProof } from './types.js';

// Internal to `@run-iq/spec`: the ties `onConflict: 'first'` settled among exceptions, as a
// proof shows them (D-7, R15): they put `conflict` on outputs, not on the winners' steps.

/** What the exceptions of a proof show of the ties settled among them. */
export interface Ties {
  /**
   * The exceptions (their index) of a carrier discarded by an exception precedence conflict
   * (R15): an inhibition whose carrier is excluded `RULE_CONFLICT`. They produced nothing.
   */
  discarded: ReadonlySet<number>;
  /** The outputs two or more short circuits claimed at the top: the output is `conflict`. */
  shortCircuits: ReadonlySet<string>;
  /**
   * True when a decision belongs to a rule a discarded carrier with a precedent would have
   * inhibited: the outputs those rules feed are `conflict`.
   */
  reaches(entry: { ruleId: string; subject?: string }): boolean;
  /**
   * In the order of `exceptions`: `exception of an excluded carrier: id@version[ at subject]`
   * (its carrier excluded, other than as a discarded carrier); for a discarded carrier,
   * `exception status differs from its carrier's decision` and `discarded carrier without a
   * precedent` (none of its affected rules is a carrier whose exception came before).
   */
  problems: readonly string[];
}

/** A node of the subjects of one rule; the root is the rule without subject. */
interface Node {
  children: Map<string, Node>;
  /** A marked entry ends here. */
  marked: boolean;
  /** A marked entry ends here or below. */
  below: boolean;
}

const newNode = (): Node => ({ children: new Map(), marked: false, below: false });

/** Marked rule instances, by rule id and subject; the queries are by subject prefix. */
class Scope {
  private readonly roots = new Map<string, Node>();

  mark(entry: { ruleId: string; subject?: string }): void {
    let node = this.roots.get(entry.ruleId) ?? newNode();
    this.roots.set(entry.ruleId, node);
    node.below = true;
    for (const segment of segmentsOf(entry.subject)) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = newNode();
        node.children.set(segment, child);
      }
      child.below = true;
      node = child;
    }
    node.marked = true;
  }

  /** True when a marked entry is at `entry`'s subject or above it (it covers `entry`). */
  covers(entry: { ruleId: string; subject?: string }): boolean {
    let node = this.roots.get(entry.ruleId);
    if (node?.marked === true) return true;
    for (const segment of segmentsOf(entry.subject)) {
      node = node?.children.get(segment);
      if (node === undefined) return false;
      if (node.marked) return true;
    }
    return false;
  }

  /** True when a marked entry is at `entry`'s subject or below it (`entry` covers it). */
  within(entry: { ruleId: string; subject?: string }): boolean {
    let node = this.roots.get(entry.ruleId);
    for (const segment of segmentsOf(entry.subject)) node = node?.children.get(segment);
    return node?.below === true;
  }
}

const segmentsOf = (subject: string | undefined): string[] =>
  subject === undefined ? [] : parsePointer(subject);

/** The ties the exceptions of `p` show, and the problems of its discarded carriers. */
export function tiesOf(p: UnsignedProof, standings: Standings): Ties {
  const excluded = new Map<string, ProofSkip>();
  for (const skip of p.skipped) excluded.set(instanceKey(skip), skip);
  const discarded = new Set<number>();
  const problems: string[] = [];
  const fired = new Scope();
  const tied = new Scope();
  p.exceptions.forEach((exception, index) => {
    const cited = (): string => citeName(instanceKey(exception));
    const skip = excluded.get(instanceKey(exception));
    if (skip === undefined) {
      fired.mark(exception);
      return;
    }
    if (skip.reason !== 'RULE_CONFLICT' || exception.kind !== 'inhibit') {
      problems.push(`exception of an excluded carrier: ${cited()}`);
      return;
    }
    discarded.add(index);
    if (exception.status !== skip.status) {
      problems.push(`exception status differs from its carrier's decision: ${cited()}`);
    }
    if (!exception.affected.some((entry) => fired.within(entry))) {
      problems.push(`discarded carrier without a precedent: ${cited()}`);
      return;
    }
    for (const entry of exception.affected) tied.mark(entry);
  });
  return {
    discarded,
    shortCircuits: shortCircuitTies(p, standings, discarded),
    reaches: (entry) => tied.covers(entry),
    problems,
  };
}

/** The outputs on which two or more short circuits stand at the top (stratum, standing). */
function shortCircuitTies(
  p: UnsignedProof,
  standings: Standings,
  discarded: ReadonlySet<number>,
): Set<string> {
  const tops = new Map<string, { stratum: number; standing: Standing; count: number }>();
  p.exceptions.forEach((exception, index) => {
    const { output } = exception;
    if (exception.kind !== 'shortCircuit' || output === undefined || discarded.has(index)) return;
    const standing = standings.get(ruleKey(exception));
    if (standing === undefined) return;
    const top = tops.get(output);
    const { stratum } = exception;
    if (
      top === undefined ||
      stratum < top.stratum ||
      (stratum === top.stratum && outranks(standing, top.standing))
    ) {
      tops.set(output, { stratum, standing, count: 1 });
    } else if (stratum === top.stratum && sameLevel(standing, top.standing)) {
      top.count++;
    }
  });
  const ties = new Set<string>();
  for (const [output, top] of tops) if (top.count > 1) ties.add(output);
  return ties;
}
