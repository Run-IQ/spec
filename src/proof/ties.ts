import { citeName } from '../errors.js';
import { parsePointer } from '../path/pointer.js';
import { instanceKey } from './output-values.js';
import { BEFORE_EXCEPTIONS } from './effects.js';
import { ruleKey, sameLevel } from './precedence.js';
import type { Standing, Standings } from './precedence.js';
import { firedProblems, pendingCarrierProblems } from './carriers.js';
import { full } from './collect.js';
import type { ProofPending, ProofSection, ProofSkip, ProofView } from './types.js';
import { isLifted, LIFTS } from './lifts.js';

// Internal to `@run-iq/spec`: the ties `onConflict: 'first'` settled among exceptions, as a
// proof shows them (D-7, R15): they put `conflict` on outputs, not on the winners' steps.

/** What the exceptions of a proof show of the ties settled among them. */
export interface Ties {
  /**
   * The exceptions (their index) that fired nothing: those of a carrier excluded before the
   * exceptions ran or `INHIBITED` (refused), and those of a carrier a tie discarded, excluded
   * `RULE_CONFLICT`, whose record shows what it would have done: an inhibition naming a
   * carrier whose exception came before (R15), or a short circuit of an output another short
   * circuit at its stratum, precedence and priority claimed before it.
   */
  discarded: ReadonlySet<number>;
  /** The carriers (their instance key) a tie discarded: their tie record is their only one. */
  losers: ReadonlySet<string>;
  /** The outputs a tie of short circuits puts in `conflict` (each item of a per output). */
  shortCircuits: ReadonlySet<string>;
  /**
   * True when a decision belongs to a rule a discarded inhibition would have reached: the
   * outputs those rules feed are `conflict` (D-7).
   */
  reaches(entry: { ruleId: string; subject?: string }): boolean;
  /**
   * First `fired contradicts its reason: id@version[ at subject]` (`firedProblems`). Then, in
   * the order of `exceptions`: `exception of an excluded carrier: id@version[ at subject]`
   * (its carrier excluded for a reason that stops it: it fired nothing), `exception of a pending
   * carrier` (its `fired` false), `pending carrier without fired`; for a
   * discarded carrier, `exception status differs from its carrier's decision`, and
   * `discarded short circuit affected rules`; `short circuits tied without a loser excluded:
   * id@version` (a second short circuit of an output at the same stratum, precedence and
   * priority, its carrier not excluded `RULE_CONFLICT`); then, in the order of the losers,
   * `tie loser recorded other exceptions: id@version[ at subject]` (a carrier a tie discarded
   * records its tie record only: it fired nothing else); then, in the order of `pending`,
   * `pending carrier fired without its exceptions: id@version[ at subject]` (its `fired` is
   * true, and no exception of its instance is recorded: a carrier that fired records each of
   * its exceptions, `affected` possibly empty); then, in the order of `pending`, `pending
   * carrier without a pending carrier`, `pending carrier without a root`, `pending carrier
   * after its target` and `pending carrier out of scope` (`pendingCarrierProblems`).
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
export class Scope {
  private readonly roots = new Map<string, Node>();
  private created = 0;

  /** The nodes this trie holds: what its marks cost in memory. */
  get nodes(): number {
    return this.created;
  }

  mark(entry: { ruleId: string; subject?: string }): void {
    let root = this.roots.get(entry.ruleId);
    if (root === undefined) {
      root = newNode();
      this.created++;
      this.roots.set(entry.ruleId, root);
    }
    let node: Node = root;
    node.below = true;
    for (const segment of segmentsOf(entry.subject)) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = newNode();
        this.created++;
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

/** A short circuit that fired: its stratum and where its carrier stands. */
interface Claim {
  stratum: number;
  standing: Standing;
}

/**
 * The exclusions that stop a carrier from firing (core `ExceptionResult`): those decided before
 * the exceptions ran, and `INHIBITED` and `OUTPUT_MISMATCH` at the exception stage
 * (`RULE_CONFLICT` stops one too: a discarded carrier, `tiesOf`).
 */
export function stopsCarrier(reason: string): boolean {
  return reason === 'INHIBITED' || reason === 'OUTPUT_MISMATCH' || BEFORE_EXCEPTIONS.has(reason);
}

/**
 * The ties the exceptions of `p` show, and the problems of their carriers. A carrier excluded
 * for a reason that stops it (`stopsCarrier`) fired nothing. A pending one fired exactly when
 * its entry says so (`fired`, R18; fixed by its reason for some, `firedProblems`). One
 * excluded for its own computation afterwards (`SHORT_CIRCUITED`, `INVALID_PARAMS`,
 * `DOMINATED`, a tie on its own output, any other reason) fired its exceptions first (core
 * `ExceptionResult`).
 */
export function tiesOf(
  p: ProofView,
  standings: Standings,
  hidden: ReadonlySet<ProofSection> = new Set(),
): Ties {
  const excluded = new Map<string, ProofSkip>();
  for (const skip of p.skipped) excluded.set(instanceKey(skip), skip);
  const waiting = new Map<string, ProofPending>();
  for (const entry of p.pending) waiting.set(instanceKey(entry), entry);
  const discarded = new Set<number>();
  const losers = new Set<string>();
  const shortCircuits = new Set<string>();
  const problems: string[] = [];
  firedProblems(p, problems);
  const fired = new Scope();
  const tied = new Scope();
  const claims = new Map<string, Claim[]>();
  const tiedClaim = (output: string, claim: Claim | undefined): boolean =>
    claim !== undefined &&
    (claims.get(output) ?? []).some(
      (other) => other.stratum === claim.stratum && sameLevel(other.standing, claim.standing),
    );
  p.exceptions.forEach((exception, index) => {
    const cited = (): string => citeName(instanceKey(exception));
    const skip = excluded.get(instanceKey(exception));
    const standing = standings.get(ruleKey(exception));
    const claim = standing === undefined ? undefined : { stratum: exception.stratum, standing };
    const { output } = exception;
    if (skip !== undefined && stopsCarrier(skip.reason)) {
      problems.push(`exception of an excluded carrier: ${cited()}`);
      discarded.add(index);
      return;
    }
    const pending = waiting.get(instanceKey(exception));
    if (pending !== undefined && pending.fired !== true) {
      problems.push(
        pending.fired === undefined
          ? `pending carrier without fired: ${cited()}`
          : `exception of a pending carrier: ${cited()}`,
      );
      discarded.add(index);
      return;
    }
    const conflicted = skip?.reason === 'RULE_CONFLICT';
    const r15 = exception.kind === 'inhibit' && exception.affected.some((e) => fired.within(e));
    const lost =
      exception.kind === 'shortCircuit' && output !== undefined && tiedClaim(output, claim);
    if (conflicted && (r15 || lost)) {
      discarded.add(index);
      losers.add(instanceKey(exception));
      if (exception.status !== skip.status) {
        problems.push(`exception status differs from its carrier's decision: ${cited()}`);
      }
      if (r15) {
        for (const entry of exception.affected) tied.mark(entry);
      } else if (output !== undefined) {
        shortCircuits.add(output);
        if (exception.affected.length > 0) {
          problems.push(`discarded short circuit affected rules: ${cited()}`);
        }
      }
      return;
    }
    fired.mark(exception);
    if (exception.kind !== 'shortCircuit' || output === undefined || claim === undefined) return;
    // The loser's exclusion `RULE_CONFLICT` may be redacted.
    if (tiedClaim(output, claim) && !isLifted(hidden, LIFTS.tieLoser)) {
      problems.push(`short circuits tied without a loser excluded: ${cited()}`);
    }
    const list = claims.get(output);
    if (list === undefined) claims.set(output, [claim]);
    else list.push(claim);
  });
  const recorded = new Map<string, number>();
  for (const exception of p.exceptions) {
    const key = instanceKey(exception);
    recorded.set(key, (recorded.get(key) ?? 0) + 1);
  }
  // A tie loser fired nothing: its tie record is its only one (one decision, one proof).
  for (const key of losers) {
    if (full(problems)) break;
    if ((recorded.get(key) ?? 0) > 1) {
      problems.push(`tie loser recorded other exceptions: ${citeName(key)}`);
    }
  }
  // The exceptions of a carrier that fired may be redacted.
  for (const entry of p.pending) {
    if (full(problems)) break;
    if (entry.fired !== true || recorded.has(instanceKey(entry))) continue;
    const message = `pending carrier fired without its exceptions: ${citeName(instanceKey(entry))}`;
    if (!isLifted(hidden, LIFTS.pendingCarrierFired, { message })) problems.push(message);
  }
  pendingCarrierProblems(p, waiting, problems, () => isLifted(hidden, LIFTS.pendingCarrierChain));
  return {
    discarded,
    losers,
    shortCircuits,
    reaches: (entry) => tied.covers(entry),
    problems,
  };
}

/**
 * Internal: the statuses no source in the proof explains (D-7), each reported once:
 * - `provisional status without a source in the proof`: a step, exclusion, exception, output
 *   or item is `provisional`, though no fact read has a provisional assertion
 *   (`isProvisionalAssertion`: `proposed`, `contested` or `presumed`) and no rule has undeclared
 *   reads. Every other way to `provisional` (an output read, a carrier, a dominant rule, the
 *   bounds of an undetermined output) passes on a status that one of these started;
 * - `conflict status without a tie in the proof`: one is `conflict`, though no exclusion is
 *   `RULE_CONFLICT` (every tie `onConflict: 'first'` settles excludes its losers so).
 *
 * A redacted entry of a section that holds sources may be the source (`hidden`): the first is
 * not reported while `factsRead` or `readsUndeclared` has one, the second while `skipped` has.
 */
export function sourceProblems(
  p: ProofView,
  hidden: ReadonlySet<ProofSection> = new Set(),
): string[] {
  const statuses = [p.applied, p.skipped, p.exceptions, p.outputs, p.items];
  let provisional = false;
  let conflict = false;
  for (const list of statuses) {
    for (const entry of list) {
      provisional ||= entry.status === 'provisional';
      conflict ||= entry.status === 'conflict';
    }
  }
  const asserted = p.factsRead.some(
    (fact) =>
      fact.status === 'proposed' || fact.status === 'contested' || fact.method === 'presumed',
  );
  const issues: string[] = [];
  if (
    provisional &&
    !asserted &&
    p.readsUndeclared.length === 0 &&
    !isLifted(hidden, LIFTS.provisionalSource)
  ) {
    issues.push('provisional status without a source in the proof');
  }
  const tie = p.skipped.some((skip) => skip.reason === 'RULE_CONFLICT');
  if (conflict && !tie && !isLifted(hidden, LIFTS.conflictSource)) {
    issues.push('conflict status without a tie in the proof');
  }
  return issues;
}
