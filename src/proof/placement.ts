import { isCanonicalDecimal } from '../decision/decimal.js';
import { citeName } from '../errors.js';
import { LOCAL_RULE_SET } from '../rule/ruleSet.js';
import { roundDecimal, roundNumber } from './arithmetic.js';
import { declarationOf, instanceKey } from './output-values.js';
import { ruleKey as key } from './precedence.js';
import type { ProofOutput, ProofSection, ProofStep, ProofView } from './types.js';
import { isLifted, LIFTS } from './lifts.js';

// Internal to `@run-iq/spec`: where the entries of a proof sit (their stratum, the rule set of
// the output they feed), what they name (models, undeclared reads) and their rounding. Linear in
// the size of the proof.

/** The rule set a qualified rule id or output name designates (D-37). */
function ruleSetOf(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? LOCAL_RULE_SET : name.slice(0, colon);
}

/**
 * Internal: where `p.strata` contradicts the rest of the proof, each problem reported once, in
 * this order:
 * - each name of `strata`, in order: `stratum output unknown: name` (not a listed output, unless
 *   `outputs` has a redacted entry, `hidden`: that may be it), `stratum output repeated: name`
 *   (in more than one place);
 * - each listed output, in no stratum: `output not in strata: name`;
 * - each entry of `applied`, `skipped`, `pending` and `exceptions`, in order:
 *   `stratum out of range: id@version` when its `stratum` is not an index of `strata`,
 *   otherwise, for an entry naming an output not in `strata[stratum]`,
 *   `step stratum mismatch: id@version`.
 *
 * Linear in the size of the proof: each stratum is turned into a set once.
 */
export function strataProblems(
  p: ProofView,
  listed: ReadonlyMap<string, ProofOutput>,
  hidden: ReadonlySet<ProofSection> = new Set(),
): string[] {
  const issues: string[] = [];
  const placed = new Set<string>();
  for (const name of p.strata.flat()) {
    if (!listed.has(name)) {
      const message = `stratum output unknown: ${citeName(name)}`;
      const output = { output: name };
      if (!isLifted(hidden, LIFTS.strataOutputs, { message, output })) issues.push(message);
    }
    if (placed.has(name)) issues.push(`stratum output repeated: ${citeName(name)}`);
    placed.add(name);
  }
  for (const name of listed.keys()) {
    if (!placed.has(name)) issues.push(`output not in strata: ${citeName(name)}`);
  }
  const members = p.strata.map((names) => new Set(names));
  const place = (entry: { ruleId: string; version: number; stratum: number }, output?: string) => {
    const names = members[entry.stratum];
    if (!names) issues.push(`stratum out of range: ${citeName(key(entry))}`);
    else if (output !== undefined && !names.has(output)) {
      issues.push(`step stratum mismatch: ${citeName(key(entry))}`);
    }
  };
  for (const entry of [...p.applied, ...p.skipped, ...p.pending]) place(entry, entry.output);
  for (const exception of p.exceptions) place(exception);
  return issues;
}

/**
 * Internal: each rule feeding (applied, excluded or pending) an output of another rule set than
 * its own, unless its own is a pack that imports it (D-23): local rules and outputs import
 * nothing and are imported by nothing. `rule feeds an output of a rule set it does not import:
 * id@version`.
 */
export function feedProblems(p: ProofView): string[] {
  const imports = new Map<string, Set<string>>();
  for (const set of p.ruleSets) {
    if (set.kind === 'pack') imports.set(set.id, new Set(set.imports ?? []));
  }
  const issues: string[] = [];
  for (const entry of [...p.applied, ...p.skipped, ...p.pending]) {
    if (entry.output === undefined) continue;
    const own = ruleSetOf(entry.ruleId);
    const target = ruleSetOf(entry.output);
    if (own === target || imports.get(own)?.has(target) === true) continue;
    issues.push(`rule feeds an output of a rule set it does not import: ${citeName(key(entry))}`);
  }
  return issues;
}

/** Internal: each model of an applied step that `versions.models` does not list. */
export function modelProblems(p: ProofView): string[] {
  return p.applied
    .filter((step) => !Object.hasOwn(p.versions.models, step.model))
    .map((step) => `model not in versions: ${citeName(step.model)}`);
}

/**
 * Internal: each applied step whose `unrounded` value contradicts its output's rounding: present
 * without `rounding.at: 'contribution'` (`unrounded value without rounding at contribution`), or
 * not rounding to its contribution, or equal to it (`unrounded value does not round to its
 * contribution`): it is kept only when rounding changed the contribution.
 */
export function unroundedProblems(
  p: ProofView,
  listed: ReadonlyMap<string, ProofOutput>,
): string[] {
  const issues: string[] = [];
  for (const step of p.applied) {
    const output = listed.get(step.output);
    if (step.unrounded === undefined || output === undefined) continue;
    const { rounding } = declarationOf(output);
    const cited = citeName(instanceKey(step));
    if (rounding?.at !== 'contribution') {
      issues.push(`unrounded value without rounding at contribution: ${cited}`);
    } else if (!roundsTo(step, rounding)) {
      issues.push(`unrounded value does not round to its contribution: ${cited}`);
    }
  }
  return issues;
}

/** True when the step's `unrounded` rounds to its contribution and differs from it. */
function roundsTo(step: ProofStep, rounding: Parameters<typeof roundDecimal>[1]): boolean {
  const { unrounded, contribution } = step;
  if (typeof unrounded === 'number' && typeof contribution === 'number') {
    return unrounded !== contribution && roundNumber(unrounded, rounding) === contribution;
  }
  const canonical = (value: unknown): value is string =>
    typeof value === 'string' && isCanonicalDecimal(value);
  if (canonical(unrounded) && canonical(contribution)) {
    return unrounded !== contribution && roundDecimal(unrounded, rounding) === contribution;
  }
  // Off its declaration: reported by `offDeclarationValues`.
  return true;
}

/**
 * Internal: each rule whose reads are not known (`readsUndeclared`, D-39) whose step, exclusion
 * or exception is `determined`: it is at best `provisional`.
 */
export function undeclaredReadProblems(p: ProofView): string[] {
  const undeclared = new Set(p.readsUndeclared.map(key));
  return [...p.applied, ...p.skipped, ...p.exceptions]
    .filter((entry) => entry.status === 'determined' && undeclared.has(key(entry)))
    .map((entry) => `rule with undeclared reads cannot be determined: ${citeName(key(entry))}`);
}
