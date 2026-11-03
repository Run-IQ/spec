import { citeName } from '../errors.js';
import { comparePointers } from '../path/pointer.js';
import { LOCAL_RULE_SET, qualifyName } from '../rule/ruleSet.js';
import {
  imposedKey,
  imposedSteps,
  instanceKey,
  nonCanonicalDecimals,
  offDeclarationValues,
} from './output-values.js';
import { append, full } from './collect.js';
import { decisionProblems, exceptionProblems, undecidedRules } from './effects.js';
import { exceptionOrderProblems, standingsOf } from './precedence.js';
import type { Standings } from './precedence.js';
import type { Context } from './combination.js';
import {
  feedProblems,
  modelProblems,
  strataProblems,
  undeclaredReadProblems,
  unroundedProblems,
} from './placement.js';
import { citeItem, outputProblems } from './statuses.js';
import { sourceProblems, tiesOf } from './ties.js';
import { PROOF_SECTIONS } from './types.js';
import type { ProofOutput, ProofSection, ProofStep, ProofView } from './types.js';
import { isLifted, liftedOnSteps, LIFTS, unexplained } from './lifts.js';
import type { RuleIdentity } from './lifts.js';
import {
  NativeMap,
  NativeNumber,
  NativeRegExp,
  NativeSet,
  arrayFilter,
  arrayFlatMap,
  arrayForEach,
  arrayIncludes,
  arrayJoin,
  arrayMap,
  arrayPush,
  arraySome,
  mapGet,
  mapHas,
  mapKeys,
  mapSet,
  mapSize,
  objectEntries,
  regExpExec,
  setAdd,
  setHas,
  stringIndexOf,
  stringSlice,
} from '../intrinsics.js';

// Internal to `@run-iq/spec`: the consistency of a proof `validateProof` accepts, as `sealProof`,
// `signProof` and `verifyProof` check it. Every check is linear in the size of the proof: each
// list is indexed once (a Set or a Map), and pointers are parsed once per comparison.

type Compare<T> = (a: T, b: T) => number;

const byText: Compare<string> = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `undefined` before any value, then `compare`. */
function optional<T>(compare: Compare<T>): Compare<T | undefined> {
  return (a, b) => {
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    return compare(a, b);
  };
}

const bySubject = optional(comparePointers);

/** The rule set a qualified rule id or output name designates (D-37). */
function ruleSetOf(name: string): string {
  const colon = stringIndexOf(name, ':');
  return colon < 0 ? LOCAL_RULE_SET : stringSlice(name, 0, colon);
}

/** The bare part of a qualified name. */
const bareOf = (name: string): string => stringSlice(name, stringIndexOf(name, ':') + 1);

/** Rule identities: rule set, bare id, version. */
const byRule: Compare<{ ruleId: string; version: number }> = (a, b) =>
  byText(ruleSetOf(a.ruleId), ruleSetOf(b.ruleId)) ||
  byText(bareOf(a.ruleId), bareOf(b.ruleId)) ||
  a.version - b.version;

/** Rule instances: rule, then subject (none first). */
const byInstance: Compare<{ ruleId: string; version: number; subject?: string }> = (a, b) =>
  byRule(a, b) || bySubject(a.subject, b.subject);

/**
 * Reports where `list` is not sorted by `compare`: `unsorted(i)` at an entry before its
 * predecessor, `repeated(i)` at one equal to it (when the order is strict).
 */
function sortProblems<T>(
  list: readonly T[],
  compare: Compare<T>,
  unsorted: (i: number) => string,
  repeated?: (i: number) => string,
): string[] {
  const issues: string[] = [];
  for (let i = 1; i < list.length && !full(issues); i++) {
    const order = compare(list[i - 1] as T, list[i] as T);
    if (order > 0) arrayPush(issues, unsorted(i));
    else if (order === 0 && repeated !== undefined) arrayPush(issues, repeated(i));
  }
  return issues;
}

const key = (entry: { ruleId: string; version: number }): string =>
  `${entry.ruleId}@${entry.version}`;

/** No section hidden: a proof without redacted entries. */
const NOTHING_HIDDEN: ReadonlySet<ProofSection> = new NativeSet();

/**
 * Internal: what the checks of `p` share, computed once: its imposed steps (`imposedSteps`),
 * standings (`standingsOf`), ties (`tiesOf`) and the sections that have redacted entries
 * (`hidden`). `p` must be the view of a plain-JSON snapshot that `validateProof` accepts
 * (`proofView`).
 */
export function contextOf(
  p: ProofView,
  hidden: ReadonlySet<ProofSection> = NOTHING_HIDDEN,
): Context {
  const standings = standingsOf(p);
  return { imposed: imposedSteps(p), standings, ties: tiesOf(p, standings, hidden), hidden };
}

/**
 * Internal: `message` with the place it cites of an entry of a section (`applied not sorted at
 * 2`, `pending[3].missing …`) turned from its place in the view (`proofView`) into its place in
 * the proof, where redacted entries count.
 */
export function placeInProof(
  message: string,
  positions: ReadonlyMap<ProofSection, readonly number[]>,
): string {
  if (mapSize(positions) === 0) return message;
  const found = regExpExec(PLACE, message);
  if (found === null) return message;
  const [whole, section = '', link = '', index = ''] = found;
  const place = mapGet(positions, section as ProofSection)?.[NativeNumber(index)];
  if (place === undefined) return message;
  return `${section}${link}${place}${stringSlice(message, whole.length)}`;
}

/** A message citing the place of an entry: `<section> not sorted at <i>`, `<section>[<i>]`. */
const PLACE = new NativeRegExp(`^(${arrayJoin(PROOF_SECTIONS, '|')})( not sorted at |\\[)(\\d+)`);

/**
 * Internal: every way `p` contradicts itself, each reported once, in this order: unlisted
 * citations and rule sets (`citationProblems`), the rule sets (`ruleSetProblems`), the orders
 * and identities (`orderProblems`), the strata (`strataProblems`), rules feeding outputs of a
 * rule set theirs does not import, models not in `versions`, decimals not canonical
 * (`nonCanonicalDecimals`), values off their declaration (`offDeclarationValues`), the outputs
 * and items (`outputProblems`), `unrounded` values (`unroundedProblems`), rules with
 * undeclared reads that are determined, rules not decided (`undecidedRules`) and the statuses
 * exceptions impose (`exceptionProblems`). `p` must be a plain-JSON snapshot that `validateProof`
 * accepts; `context` is its own (`contextOf`).
 */
export function inconsistencies(
  p: ProofView,
  context: Context = contextOf(p),
  positions: ReadonlyMap<ProofSection, readonly number[]> = new NativeMap(),
): string[] {
  const listed = listedOutputs(p);
  const { imposed, hidden } = context;
  const checks: (() => string[])[] = [
    () => citationProblems(p, listed, hidden),
    () => ruleSetProblems(p),
    () => orderProblems(p, listed, context.standings, imposed, hidden),
    () => strataProblems(p, listed, hidden),
    () => feedProblems(p),
    () => modelProblems(p),
    () => nonCanonicalDecimals(p),
    () => offDeclarationValues(p, hidden),
    () => outputProblems(p, listed, context),
    () => unroundedProblems(p, listed),
    () => undeclaredReadProblems(p),
    () => undecidedRules(p, hidden),
    () => decisionProblems(p, imposed, hidden),
    () => exceptionProblems(p, imposed, context.ties, hidden),
    () => sourceProblems(p, hidden),
    // Last: every problem lifted, when the redacted entries cannot explain them all.
    () => unexplained(hidden),
  ];
  // Each problem once, in the order found, up to what `verifyProof` lists.
  const issues: string[] = [];
  const seen = new NativeSet<string>();
  for (const check of checks) {
    if (full(issues)) break;
    for (const issue of check()) {
      if (full(issues)) break;
      const message = placeInProof(issue, positions);
      if (setHas(seen, message)) continue;
      setAdd(seen, message);
      arrayPush(issues, message);
    }
  }
  return issues;
}

/** Each output name of `p`, with its first entry. */
function listedOutputs(p: ProofView): Map<string, ProofOutput> {
  const listed = new NativeMap<string, ProofOutput>();
  for (const output of p.outputs)
    if (!mapHas(listed, output.name)) mapSet(listed, output.name, output);
  return listed;
}

/** What `forEachUnresolved` reports: a rule or an output cited and not listed (cited). */
interface Unresolved {
  rule: (cited: string, rule: RuleIdentity) => void;
  output: (cited: string, name: string) => void;
  stop: () => boolean;
}

/**
 * Each citation of `p` that it does not resolve, in this order: each rule of a section entry
 * (`id@version`, qualified, D-37), each rule named by id in contributors, pending rules,
 * selections and affected rules, each output named by an item or an entry. Stops when `stop`.
 */
function forEachUnresolved(
  p: ProofView,
  listed: ReadonlyMap<string, ProofOutput>,
  report: Unresolved,
): void {
  const keys = new NativeSet<string>();
  const ids = new NativeSet<string>();
  for (const rule of p.rules) {
    const id = qualifyName(rule.ruleSet, rule.id);
    setAdd(ids, id);
    setAdd(keys, `${id}@${rule.version}`);
  }
  const sections = [p.applied, p.skipped, p.pending, p.exceptions, p.readsUndeclared];
  for (const section of sections) {
    for (const entry of section) {
      if (report.stop()) return;
      if (!setHas(keys, key(entry))) {
        report.rule(citeName(key(entry)), { id: entry.ruleId, version: entry.version });
      }
    }
  }
  const cite = (id: string): void => {
    if (!setHas(ids, id) && !report.stop()) report.rule(citeName(id), { id });
  };
  for (const entry of [...p.outputs, ...p.items]) {
    for (const id of entry.contributors) cite(id);
    for (const id of entry.pending) cite(id);
    if (entry.selected !== undefined) cite(entry.selected.ruleId);
  }
  for (const exception of p.exceptions) for (const { ruleId } of exception.affected) cite(ruleId);
  const output = (name: string | undefined): void => {
    if (name !== undefined && !mapHas(listed, name) && !report.stop()) {
      report.output(citeName(name), name);
    }
  };
  for (const item of p.items) output(item.output);
  for (const step of p.applied) output(step.output);
  for (const entry of p.skipped) output(entry.output);
  for (const entry of p.pending) output(entry.output);
  for (const exception of p.exceptions) output(exception.output);
}

/**
 * Internal: the citations `p` does not resolve, in this order: each rule of a section entry
 * (`cited rule not listed: id@version`, qualified, D-37), each rule named by id in contributors,
 * pending rules, selections and affected rules (`cited rule not listed: id`), each output
 * named by an item or an entry (`cited output not listed: name`), and each rule set of a rule or
 * an output that `ruleSets` does not list as a pack (`rule set not listed: id`). A rule is not
 * reported while `rules` has a redacted entry (`hidden`), an output while `outputs` has one: the
 * redacted entry may be the one cited: the check is lifted (`isLifted`).
 */
export function citationProblems(
  p: ProofView,
  listed: ReadonlyMap<string, ProofOutput>,
  hidden: ReadonlySet<ProofSection> = NOTHING_HIDDEN,
): string[] {
  const issues: string[] = [];
  forEachUnresolved(p, listed, {
    rule: (cited, rule) => {
      // A rules entry of that rule: `id@version`, or any version when cited by id.
      const message = `cited rule not listed: ${cited}`;
      if (!isLifted(hidden, LIFTS.ruleCitations, { message, rule })) arrayPush(issues, message);
    },
    output: (cited, name) => {
      const message = `cited output not listed: ${cited}`;
      if (!isLifted(hidden, LIFTS.outputCitations, { message, output: { output: name } })) {
        arrayPush(issues, message);
      }
    },
    stop: () => full(issues),
  });
  const packs = new NativeSet(
    arrayFlatMap(p.ruleSets, (set) => (set.kind === 'pack' ? [set.id] : [])),
  );
  const sets = [
    ...arrayMap(p.rules, (rule) => rule.ruleSet),
    ...arrayMap([...mapKeys(listed)], ruleSetOf),
  ];
  for (const set of sets) {
    if (full(issues)) break;
    if (set !== LOCAL_RULE_SET && !setHas(packs, set)) {
      arrayPush(issues, `rule set not listed: ${citeName(set)}`);
    }
  }
  return issues;
}

/**
 * Internal: the problems of `ruleSets`, whose order is the precedence (kept as it is): an entry
 * listed twice (`rule set listed twice: id`, `local` for the local rules), a pack importing
 * itself or a pack not listed, imports not sorted or repeated.
 */
export function ruleSetProblems(p: ProofView): string[] {
  const issues: string[] = [];
  const seen = new NativeSet<string>();
  const packs = new NativeSet<string>();
  for (const set of p.ruleSets) {
    const name = set.kind === 'local' ? LOCAL_RULE_SET : set.id;
    const id = `${set.kind === 'referential' ? 'referential' : 'rule set'}:${name}`;
    if (setHas(seen, id)) arrayPush(issues, `rule set listed twice: ${citeName(name)}`);
    setAdd(seen, id);
    if (set.kind === 'pack') setAdd(packs, set.id);
  }
  arrayForEach(p.ruleSets, (set, i) => {
    if (set.kind !== 'pack' || set.imports === undefined) return;
    const { id, imports } = set;
    if (arrayIncludes(imports, id)) arrayPush(issues, `rule set imports itself: ${citeName(id)}`);
    if (arraySome(imports, (pack) => !setHas(packs, pack))) {
      arrayPush(issues, `rule set imports a pack not listed: ${citeName(id)}`);
    }
    const at = `ruleSets[${i}].imports`;
    append(
      issues,
      sortProblems(
        imports,
        byText,
        (j) => `${at} not sorted at ${j}`,
        (j) => `${at} repeats ${citeName(imports[j] ?? '')}`,
      ),
    );
  });
  return issues;
}

/**
 * Internal: the lists of `p` out of their order (D-16), and the identities they repeat:
 * `<section> not sorted at i`, `duplicate output: name`, `duplicate item: name at subject`,
 * `rule decided twice: id@version[ at subject]` (an instance in `applied`, `skipped` or
 * `pending` twice; a rule decided without subject is decided once, beside grouped exclusions
 * only), `duplicate undeclared read`, `duplicate fact read`, `duplicate missing fact`,
 * `requested repeats name`, `requested output absent: name`, `component repeated at i`, and
 * the inner lists: strata, pending `missing`, `matches` values and groups, `affected`.
 */
export function orderProblems(
  p: ProofView,
  listed: ReadonlyMap<string, ProofOutput>,
  standings: Standings = standingsOf(p),
  imposed: ReadonlySet<string> = imposedSteps(p),
  hidden: ReadonlySet<ProofSection> = NOTHING_HIDDEN,
): string[] {
  const issues: string[] = [];
  const push = (list: string[]): void => {
    append(issues, list);
  };
  push(
    sortProblems(
      p.rules,
      (a, b) => byText(a.ruleSet, b.ruleSet) || byText(a.id, b.id) || a.version - b.version,
      (i) => `rules not sorted at ${i}`,
    ),
  );
  push(
    sortProblems(
      arrayMap(p.outputs, (output) => output.name),
      byText,
      (i) => `outputs not sorted at ${i}`,
      (i) => `duplicate output: ${citeName(p.outputs[i]?.name ?? '')}`,
    ),
  );
  push(
    sortProblems(
      p.items,
      (a, b) => byText(a.output, b.output) || comparePointers(a.subject, b.subject),
      (i) => `items not sorted at ${i}`,
      (i) => `duplicate item: ${citeItem(p.items[i]?.output ?? '', p.items[i]?.subject ?? '')}`,
    ),
  );
  for (const [section, list] of [
    ['applied', p.applied],
    ['skipped', p.skipped],
    ['pending', p.pending],
  ] as const) {
    push(
      sortProblems<(typeof list)[number]>(list, byInstance, (i) => `${section} not sorted at ${i}`),
    );
  }
  push(liftedOnSteps(hidden, (steps) => decidedTwice(p, imposed, steps), p.applied));
  push(exceptionOrderProblems(p, standings));
  push(
    sortProblems(
      p.readsUndeclared,
      byRule,
      (i) => `readsUndeclared not sorted at ${i}`,
      (i) => {
        const entry = p.readsUndeclared[i] ?? { ruleId: '', version: 0 };
        return `duplicate undeclared read: ${citeName(key(entry))}`;
      },
    ),
  );
  push(
    sortProblems(
      arrayMap(p.factsRead, (fact) => fact.path),
      comparePointers,
      (i) => `factsRead not sorted at ${i}`,
      (i) => `duplicate fact read: ${citeName(p.factsRead[i]?.path ?? '')}`,
    ),
  );
  push(
    sortProblems(
      arrayMap(p.missingFacts, (fact) => fact.path),
      comparePointers,
      (i) => `missingFacts not sorted at ${i}`,
      (i) => `duplicate missing fact: ${citeName(p.missingFacts[i]?.path ?? '')}`,
    ),
  );
  push(
    requestedProblems(p, listed, (message, name) =>
      isLifted(hidden, LIFTS.requestedOutputs, { message, output: { output: name } }),
    ),
  );
  push(innerOrderProblems(p));
  return issues;
}

/**
 * One rule instance decided twice across `steps` (those of `applied`), `skipped` and `pending`.
 */
function decidedTwice(
  p: ProofView,
  imposed: ReadonlySet<string>,
  steps: readonly ProofStep[],
): string[] {
  const issues: string[] = [];
  const decided = new NativeMap<string, { whole: boolean; subjects: Set<string> }>();
  for (const entry of [...steps, ...p.skipped, ...p.pending]) {
    if (full(issues)) break;
    // The step a short circuit imposed is the effect of an exception, not a decision.
    if ('model' in entry && setHas(imposed, imposedKey(entry, entry.output))) continue;
    const rule = key(entry);
    const grouped = 'instances' in entry && entry.instances !== undefined;
    let state = mapGet(decided, rule);
    const twice =
      state !== undefined &&
      (state.whole ||
        (entry.subject === undefined ? !grouped : setHas(state.subjects, entry.subject)));
    if (twice) arrayPush(issues, `rule decided twice: ${citeName(instanceKey(entry))}`);
    if (state === undefined) {
      state = { whole: false, subjects: new NativeSet() };
      mapSet(decided, rule, state);
    }
    if (entry.subject !== undefined) setAdd(state.subjects, entry.subject);
    else if (!grouped) state.whole = true;
  }
  return issues;
}

/**
 * `requested` sorted, without repeat, each output it names listed: while `outputs` has a
 * redacted entry (`outputsHidden`), an output not listed may be that one.
 */
function requestedProblems(
  p: ProofView,
  listed: ReadonlyMap<string, ProofOutput>,
  outputsHidden: (message: string, name: string) => boolean,
): string[] {
  const requested = p.requested ?? [];
  const absent = arrayFilter(
    requested,
    (name) =>
      !mapHas(listed, name) && !outputsHidden(`requested output absent: ${citeName(name)}`, name),
  );
  return [
    ...sortProblems(
      requested,
      byText,
      (i) => `requested not sorted at ${i}`,
      (i) => `requested repeats ${citeName(requested[i] ?? '')}`,
    ),
    ...arrayMap(absent, (name) => `requested output absent: ${citeName(name)}`),
  ];
}

function innerOrderProblems(p: ProofView): string[] {
  const issues: string[] = [];
  const components = p.versions.components;
  append(
    issues,
    sortProblems(
      components,
      (a, b) =>
        byText(a.name, b.name) ||
        byText(a.version, b.version) ||
        optional(byText)(a.digest, b.digest) ||
        byText(a.declaredBy, b.declaredBy),
      (i) => `components not sorted at ${i}`,
      (i) => `component repeated at ${i}`,
    ),
  );
  // One release of the time zone database, recorded by the engine: with two, the proof does not
  // say which one decided its windows.
  const releases = arrayFilter(
    components,
    (entry) => entry.name === 'tzdata' && entry.declaredBy === 'engine',
  );
  if (releases.length > 1) {
    arrayPush(
      issues,
      `tzdata recorded ${releases.length} times by the engine: one release is allowed`,
    );
  }
  arrayForEach(p.strata, (names, i) => {
    append(
      issues,
      sortProblems(names, byText, (j) => `strata[${i}] not sorted at ${j}`),
    );
  });
  arrayForEach(p.pending, (entry, i) => {
    const at = `pending[${i}].missing`;
    append(
      issues,
      sortProblems(
        entry.missing,
        comparePointers,
        (j) => `${at} not sorted at ${j}`,
        (j) => `${at} repeats ${citeName(entry.missing[j] ?? '')}`,
      ),
    );
  });
  arrayForEach(p.applied, (step, i) => {
    for (const [name, match] of objectEntries(step.matches ?? {})) {
      for (const member of ['values', 'via'] as const) {
        const list = match[member];
        const at = `applied[${i}].matches.${name}.${member}`;
        append(
          issues,
          sortProblems(
            list,
            byText,
            (j) => `${citeName(at)} not sorted at ${j}`,
            (j) => `${citeName(at)} repeats ${citeName(list[j] ?? '')}`,
          ),
        );
      }
    }
  });
  arrayForEach(p.exceptions, (exception, i) => {
    const { affected } = exception;
    const at = `exceptions[${i}].affected`;
    append(
      issues,
      sortProblems(
        affected,
        (a, b) => byText(a.ruleId, b.ruleId) || bySubject(a.subject, b.subject),
        (j) => `${at} not sorted at ${j}`,
        (j) => {
          const entry = affected[j];
          const subject = entry?.subject === undefined ? '' : ` at ${entry.subject}`;
          return `${at} repeats ${citeName(`${entry?.ruleId ?? ''}${subject}`)}`;
        },
      ),
    );
  });
  return issues;
}
