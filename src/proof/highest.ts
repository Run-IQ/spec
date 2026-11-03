import { citeName } from '../errors.js';
import { outranks, ruleKey, sameLevel } from './precedence.js';
import type { Standing, Standings } from './precedence.js';
import type { ProofStep } from './types.js';
import {
  NativeMap,
  NativeSet,
  arrayAt,
  arrayFilter,
  arrayPush,
  mapGet,
  mapSet,
  setAdd,
} from '../intrinsics.js';

// Internal to `@run-iq/spec`: who wins a `highestPriority` output (D-21, D-23, D-27).

/** The rules at the top of a `highestPriority` output, and the step each one contributes. */
export interface Top {
  /** The ids of the rules at the top precedence and priority. */
  ids: ReadonlySet<string>;
  /** The step of each of them, in contribution order; empty when one cannot be told. */
  winners: readonly ProofStep[];
  /** Why the winner of a rule cannot be told (`instances tied at rank 0`, …). */
  problems: readonly string[];
}

/**
 * The top of the steps `steps` (in the order of `applied`) feeding a `highestPriority` output
 * or item (`cite`): the rules of the best precedence, then priority (D-23), each contributing
 * one step. A rule without `forEach` has one step. The instances of a `forEach` rule feeding an
 * output without `per` (`competing`) are told apart by `rank` (D-21): the one of rank 0 wins;
 * two of rank 0 are a tie its rule should have been pending for (`AMBIGUOUS_ORDER`), none is
 * a rank that cannot be. Several instances of one rule on one item cannot be told apart.
 * `undefined` when the standing of a step is unknown (its rule not listed, reported elsewhere).
 */
export function topOf(
  steps: readonly ProofStep[],
  standings: Standings,
  competing: boolean,
  cite: () => string,
): Top | undefined {
  let best: Standing | undefined;
  const standing = new NativeMap<ProofStep, Standing>();
  for (const step of steps) {
    const found = mapGet(standings, ruleKey(step));
    if (found === undefined) return undefined;
    mapSet(standing, step, found);
    if (best === undefined || outranks(found, best)) best = found;
  }
  const ids = new NativeSet<string>();
  const winners: ProofStep[] = [];
  const problems: string[] = [];
  if (best === undefined) return { ids, winners, problems };
  // In the order of `applied`, the steps of one level are in identity order, by rule.
  const groups: ProofStep[][] = [];
  for (const step of steps) {
    const found = mapGet(standing, step);
    if (found === undefined || !sameLevel(found, best)) continue;
    setAdd(ids, step.ruleId);
    const last = arrayAt(groups, -1);
    if (last !== undefined && ruleKey(last[0] ?? step) === ruleKey(step)) arrayPush(last, step);
    else arrayPush(groups, [step]);
  }
  for (const group of groups) {
    const [first] = group;
    if (first === undefined) continue;
    if (group.length === 1 && (first.subject === undefined || !competing)) {
      arrayPush(winners, first);
      continue;
    }
    const cited = citeName(ruleKey(first));
    if (!competing) {
      arrayPush(problems, `instances of one rule compete for an item: ${cited}: ${cite()}`);
      continue;
    }
    const firsts = arrayFilter(group, (step) => step.rank === 0);
    if (firsts.length > 1) arrayPush(problems, `instances tied at rank 0: ${cited}`);
    else if (firsts[0] === undefined) arrayPush(problems, `no instance at rank 0: ${cited}`);
    else arrayPush(winners, firsts[0]);
  }
  return { ids, winners: problems.length > 0 ? [] : winners, problems };
}
