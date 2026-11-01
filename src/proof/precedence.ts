import { comparePointers } from '../path/pointer.js';
import { LOCAL_RULE_SET, qualifyName } from '../rule/ruleSet.js';
import type { ProofException, UnsignedProof } from './types.js';

// Internal to `@run-iq/spec`: the contribution order of D-5 and D-23 (precedence, priority
// descending, rule identity, subject), from the rule sets and the priorities a proof records.

/** Where a rule stands: the precedence of its rule set, its priority and its identity. */
export interface Standing {
  /** The place of its rule set in `ruleSets`; `local` without an entry comes last (D-23). */
  precedence: number;
  priority: number;
  ruleSet: string;
  id: string;
  version: number;
}

/** The standing of each listed rule, by qualified id and version. */
export type Standings = ReadonlyMap<string, Standing>;

/** The key of a rule: its qualified id and version (`id@version`). */
export const ruleKey = (entry: { ruleId: string; version: number }): string =>
  `${entry.ruleId}@${entry.version}`;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The standings of the rules of `p` (the first entry of a rule listed twice). */
export function standingsOf(p: UnsignedProof): Map<string, Standing> {
  const places = new Map<string, number>();
  p.ruleSets.forEach((set, i) => {
    const name = set.kind === 'pack' ? set.id : set.kind === 'local' ? LOCAL_RULE_SET : undefined;
    if (name !== undefined && !places.has(name)) places.set(name, i);
  });
  const standings = new Map<string, Standing>();
  for (const rule of p.rules) {
    const key = `${qualifyName(rule.ruleSet, rule.id)}@${rule.version}`;
    if (standings.has(key)) continue;
    standings.set(key, {
      // A pack not listed is reported by `citationProblems`; it is placed last too.
      precedence: places.get(rule.ruleSet) ?? p.ruleSets.length,
      priority: rule.priority,
      ruleSet: rule.ruleSet,
      id: rule.id,
      version: rule.version,
    });
  }
  return standings;
}

/** The order of D-5: precedence, priority descending, then identity (D-37: set, id, version). */
export function byStanding(a: Standing, b: Standing): number {
  return (
    a.precedence - b.precedence ||
    Math.sign(b.priority - a.priority) ||
    byText(a.ruleSet, b.ruleSet) ||
    byText(a.id, b.id) ||
    a.version - b.version
  );
}

/** True when `a` is strictly above `b` in precedence, then priority (identity aside). */
export function outranks(a: Standing, b: Standing): boolean {
  return a.precedence < b.precedence || (a.precedence === b.precedence && a.priority > b.priority);
}

/** True when `a` and `b` stand at the same precedence and priority. */
export function sameLevel(a: Standing, b: Standing): boolean {
  return a.precedence === b.precedence && a.priority === b.priority;
}

/**
 * True when the rule ids `ids` are in contribution order, each standing as `standingOf` gives
 * it. An id whose standing is unknown (a rule not listed, reported elsewhere) is not compared.
 */
export function inStandingOrder(
  ids: readonly string[],
  standingOf: (id: string) => Standing | undefined,
): boolean {
  let previous: Standing | undefined;
  for (const id of ids) {
    const standing = standingOf(id);
    if (standing === undefined) {
      previous = undefined;
      continue;
    }
    if (previous !== undefined && byStanding(previous, standing) >= 0) return false;
    previous = standing;
  }
  return true;
}

/**
 * Internal: where `exceptions` is not in the order their carriers were processed (R18, D-23):
 * stratum by stratum, then precedence, priority descending, identity, then subject (none
 * first); the exceptions of one carrier instance stay in the order of its definition
 * (`exceptions not sorted at i`).
 */
export function exceptionOrderProblems(p: UnsignedProof, standings: Standings): string[] {
  const issues: string[] = [];
  let previous: { standing: Standing; exception: ProofException } | undefined;
  p.exceptions.forEach((exception, i) => {
    const standing = standings.get(ruleKey(exception));
    if (standing === undefined) {
      previous = undefined;
      return;
    }
    if (previous !== undefined) {
      const order =
        previous.exception.stratum - exception.stratum ||
        byStanding(previous.standing, standing) ||
        bySubject(previous.exception.subject, exception.subject);
      if (order > 0) issues.push(`exceptions not sorted at ${i}`);
    }
    previous = { standing, exception };
  });
  return issues;
}

function bySubject(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
  return comparePointers(a, b);
}
