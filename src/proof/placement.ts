import { isCanonicalDecimal } from '../decision/decimal.js';
import { citeName } from '../errors.js';
import { LOCAL_RULE_SET } from '../rule/ruleSet.js';
import { roundDecimal, roundNumber } from './arithmetic.js';
import { declarationOf, instanceKey } from './output-values.js';
import { ruleKey as key } from './precedence.js';
import type { ProofOutput, ProofSection, ProofStep, ProofView } from './types.js';
import { isLifted, LIFTS } from './lifts.js';
import {
  NativeMap,
  NativeSet,
  arrayConcat,
  arrayFilter,
  arrayFlat,
  arrayMap,
  arrayPush,
  mapGet,
  mapHas,
  mapKeysArray,
  mapSet,
  objectHasOwn,
  setAdd,
  setHas,
  setOf,
  stringIndexOf,
  stringSlice,
} from '../intrinsics.js';

// Internal to `@run-iq/spec`: where the entries of a proof sit (their stratum, the rule set of
// the output they feed), what they name (models, undeclared reads) and their rounding. Linear in
// the size of the proof.

/** The rule set a qualified rule id or output name designates (D-37). */
function ruleSetOf(name: string): string {
  const colon = stringIndexOf(name, ':');
  return colon < 0 ? LOCAL_RULE_SET : stringSlice(name, 0, colon);
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
  hidden: ReadonlySet<ProofSection> = new NativeSet(),
): string[] {
  const issues: string[] = [];
  const placed = new NativeSet<string>();
  for (let idx140 = 0, list140 = arrayFlat(p.strata); idx140 < list140.length; idx140++) {
    const name = list140[idx140] as (typeof list140)[number];
    if (!mapHas(listed, name)) {
      const message = `stratum output unknown: ${citeName(name)}`;
      const output = { output: name };
      if (!isLifted(hidden, LIFTS.strataOutputs, { message, output })) arrayPush(issues, message);
    }
    if (setHas(placed, name)) arrayPush(issues, `stratum output repeated: ${citeName(name)}`);
    setAdd(placed, name);
  }
  for (let idx141 = 0, list141 = mapKeysArray(listed); idx141 < list141.length; idx141++) {
    const name = list141[idx141] as (typeof list141)[number];
    if (!setHas(placed, name)) arrayPush(issues, `output not in strata: ${citeName(name)}`);
  }
  const members = arrayMap(p.strata, (names) => setOf(names));
  const place = (entry: { ruleId: string; version: number; stratum: number }, output?: string) => {
    const names = members[entry.stratum];
    if (!names) arrayPush(issues, `stratum out of range: ${citeName(key(entry))}`);
    else if (output !== undefined && !setHas(names, output)) {
      arrayPush(issues, `step stratum mismatch: ${citeName(key(entry))}`);
    }
  };
  for (
    let idx1042 = 0, list1042 = arrayConcat(p.applied, p.skipped, p.pending);
    idx1042 < list1042.length;
    idx1042++
  ) {
    const entry = list1042[idx1042] as (typeof list1042)[number];
    place(entry, entry.output);
  }
  for (let idx1043 = 0, list1043 = p.exceptions; idx1043 < list1043.length; idx1043++) {
    const exception = list1043[idx1043] as (typeof list1043)[number];
    place(exception);
  }
  return issues;
}

/**
 * Internal: each rule feeding (applied, excluded or pending) an output of another rule set than
 * its own, unless its own is a pack that imports it (D-23): local rules and outputs import
 * nothing and are imported by nothing. `rule feeds an output of a rule set it does not import:
 * id@version`.
 */
export function feedProblems(p: ProofView): string[] {
  const imports = new NativeMap<string, Set<string>>();
  for (let idx142 = 0, list142 = p.ruleSets; idx142 < list142.length; idx142++) {
    const set = list142[idx142] as (typeof list142)[number];
    if (set.kind === 'pack') mapSet(imports, set.id, setOf(set.imports ?? []));
  }
  const issues: string[] = [];
  for (
    let idx1044 = 0, list1044 = arrayConcat(p.applied, p.skipped, p.pending);
    idx1044 < list1044.length;
    idx1044++
  ) {
    const entry = list1044[idx1044] as (typeof list1044)[number];
    if (entry.output === undefined) continue;
    const own = ruleSetOf(entry.ruleId);
    const target = ruleSetOf(entry.output);
    const imported = mapGet(imports, own);
    if (own === target || (imported !== undefined && setHas(imported, target))) continue;
    arrayPush(
      issues,
      `rule feeds an output of a rule set it does not import: ${citeName(key(entry))}`,
    );
  }
  return issues;
}

/** Internal: each model of an applied step that `versions.models` does not list. */
export function modelProblems(p: ProofView): string[] {
  return arrayMap(
    arrayFilter(p.applied, (step) => !objectHasOwn(p.versions.models, step.model)),
    (step) => `model not in versions: ${citeName(step.model)}`,
  );
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
  for (let idx144 = 0, list144 = p.applied; idx144 < list144.length; idx144++) {
    const step = list144[idx144] as (typeof list144)[number];
    const output = mapGet(listed, step.output);
    if (step.unrounded === undefined || output === undefined) continue;
    const { rounding } = declarationOf(output);
    const cited = citeName(instanceKey(step));
    if (rounding?.at !== 'contribution') {
      arrayPush(issues, `unrounded value without rounding at contribution: ${cited}`);
    } else if (!roundsTo(step, rounding)) {
      arrayPush(issues, `unrounded value does not round to its contribution: ${cited}`);
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
  const undeclared = setOf(arrayMap(p.readsUndeclared, key));
  return arrayMap(
    arrayFilter(
      arrayConcat(p.applied, p.skipped, p.exceptions),
      (entry) => entry.status === 'determined' && setHas(undeclared, key(entry)),
    ),
    (entry) => `rule with undeclared reads cannot be determined: ${citeName(key(entry))}`,
  );
}
