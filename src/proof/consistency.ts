import { isCanonicalDecimal } from '../decision/decimal.js';
import { citeName } from '../errors.js';
import { comparePointers } from '../path/pointer.js';
import { LOCAL_RULE_SET, qualifyName } from '../rule/ruleSet.js';
import { roundDecimal, roundNumber } from './arithmetic.js';
import {
  declarationOf,
  imposedSteps,
  instanceKey,
  nonCanonicalDecimals,
  offDeclarationValues,
} from './output-values.js';
import { citeItem, outputProblems } from './statuses.js';
import type { ProofOutput, ProofStep, UnsignedProof } from './types.js';

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
  const colon = name.indexOf(':');
  return colon < 0 ? LOCAL_RULE_SET : name.slice(0, colon);
}

/** The bare part of a qualified name. */
const bareOf = (name: string): string => name.slice(name.indexOf(':') + 1);

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
  for (let i = 1; i < list.length; i++) {
    const order = compare(list[i - 1] as T, list[i] as T);
    if (order > 0) issues.push(unsorted(i));
    else if (order === 0 && repeated !== undefined) issues.push(repeated(i));
  }
  return issues;
}

const key = (entry: { ruleId: string; version: number }): string =>
  `${entry.ruleId}@${entry.version}`;

/**
 * Internal: every way `p` contradicts itself, each reported once, in this order: unlisted
 * citations and rule sets (`citationProblems`), the rule sets (`ruleSetProblems`), the orders
 * and identities (`orderProblems`), the strata (`strataProblems`), rules feeding outputs of a
 * rule set theirs does not import, models not in `versions`, decimals not canonical
 * (`nonCanonicalDecimals`), values off their declaration (`offDeclarationValues`), the outputs
 * and items (`outputProblems`), `unrounded` values (`unroundedProblems`), and rules with
 * undeclared reads that are determined. `p` must be a plain-JSON snapshot that `validateProof`
 * accepts.
 */
export function inconsistencies(p: UnsignedProof): string[] {
  const listed = new Map<string, ProofOutput>();
  for (const output of p.outputs) if (!listed.has(output.name)) listed.set(output.name, output);
  return [
    ...new Set([
      ...citationProblems(p, listed),
      ...ruleSetProblems(p),
      ...orderProblems(p, listed),
      ...strataProblems(p, listed),
      ...feedProblems(p),
      ...modelProblems(p),
      ...nonCanonicalDecimals(p),
      ...offDeclarationValues(p),
      ...outputProblems(p, listed, imposedSteps(p)),
      ...unroundedProblems(p, listed),
      ...undeclaredReadProblems(p),
    ]),
  ];
}

/**
 * Internal: the citations `p` does not resolve, in this order: each rule of a section entry
 * (`cited rule not listed: id@version`, qualified, D-37), each rule named by id in contributors,
 * pending rules, selections and affected rules (`cited rule not listed: id`), each output
 * named by an item or an entry (`cited output not listed: name`), and each rule set of a rule or
 * an output that `ruleSets` does not list as a pack (`rule set not listed: id`).
 */
export function citationProblems(
  p: UnsignedProof,
  listed: ReadonlyMap<string, ProofOutput>,
): string[] {
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const rule of p.rules) {
    const id = qualifyName(rule.ruleSet, rule.id);
    ids.add(id);
    keys.add(`${id}@${rule.version}`);
  }
  const issues: string[] = [];
  const sections = [p.applied, p.skipped, p.pending, p.exceptions, p.readsUndeclared];
  for (const entry of sections.flat()) {
    if (!keys.has(key(entry))) issues.push(`cited rule not listed: ${citeName(key(entry))}`);
  }
  const named: string[] = [];
  for (const entry of [...p.outputs, ...p.items]) {
    named.push(...entry.contributors, ...entry.pending);
    if (entry.selected !== undefined) named.push(entry.selected.ruleId);
  }
  for (const exception of p.exceptions) named.push(...exception.affected.map((a) => a.ruleId));
  for (const id of named) if (!ids.has(id)) issues.push(`cited rule not listed: ${citeName(id)}`);
  const outputs = [
    ...p.items.map((item) => item.output),
    ...p.applied.map((step) => step.output),
    ...[...p.skipped, ...p.pending].flatMap((entry) => entry.output ?? []),
  ];
  for (const name of outputs) {
    if (!listed.has(name)) issues.push(`cited output not listed: ${citeName(name)}`);
  }
  const packs = new Set(p.ruleSets.flatMap((set) => (set.kind === 'pack' ? [set.id] : [])));
  const sets = [...p.rules.map((rule) => rule.ruleSet), ...[...listed.keys()].map(ruleSetOf)];
  for (const set of sets) {
    if (set !== LOCAL_RULE_SET && !packs.has(set)) {
      issues.push(`rule set not listed: ${citeName(set)}`);
    }
  }
  return issues;
}

/**
 * Internal: the problems of `ruleSets`, whose order is the precedence (kept as it is): an entry
 * listed twice (`rule set listed twice: id`, `local` for the local rules), a pack importing
 * itself or a pack not listed, imports not sorted or repeated.
 */
export function ruleSetProblems(p: UnsignedProof): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const packs = new Set<string>();
  for (const set of p.ruleSets) {
    const name = set.kind === 'local' ? LOCAL_RULE_SET : set.id;
    const id = `${set.kind === 'referential' ? 'referential' : 'rule set'}:${name}`;
    if (seen.has(id)) issues.push(`rule set listed twice: ${citeName(name)}`);
    seen.add(id);
    if (set.kind === 'pack') packs.add(set.id);
  }
  p.ruleSets.forEach((set, i) => {
    if (set.kind !== 'pack' || set.imports === undefined) return;
    const { id, imports } = set;
    if (imports.includes(id)) issues.push(`rule set imports itself: ${citeName(id)}`);
    if (imports.some((pack) => !packs.has(pack))) {
      issues.push(`rule set imports a pack not listed: ${citeName(id)}`);
    }
    const at = `ruleSets[${i}].imports`;
    issues.push(
      ...sortProblems(
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
  p: UnsignedProof,
  listed: ReadonlyMap<string, ProofOutput>,
): string[] {
  const issues: string[] = [];
  const push = (list: string[]): void => {
    issues.push(...list);
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
      p.outputs.map((output) => output.name),
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
  push(decidedTwice(p));
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
      p.factsRead.map((fact) => fact.path),
      comparePointers,
      (i) => `factsRead not sorted at ${i}`,
      (i) => `duplicate fact read: ${citeName(p.factsRead[i]?.path ?? '')}`,
    ),
  );
  push(
    sortProblems(
      p.missingFacts.map((fact) => fact.path),
      comparePointers,
      (i) => `missingFacts not sorted at ${i}`,
      (i) => `duplicate missing fact: ${citeName(p.missingFacts[i]?.path ?? '')}`,
    ),
  );
  push(requestedProblems(p, listed));
  push(innerOrderProblems(p));
  return issues;
}

/** One rule instance decided twice across `applied`, `skipped` and `pending`. */
function decidedTwice(p: UnsignedProof): string[] {
  const issues: string[] = [];
  const decided = new Map<string, { whole: boolean; subjects: Set<string> }>();
  for (const entry of [...p.applied, ...p.skipped, ...p.pending]) {
    const rule = key(entry);
    const grouped = 'instances' in entry && entry.instances !== undefined;
    let state = decided.get(rule);
    const twice =
      state !== undefined &&
      (state.whole || (entry.subject === undefined ? !grouped : state.subjects.has(entry.subject)));
    if (twice) issues.push(`rule decided twice: ${citeName(instanceKey(entry))}`);
    if (state === undefined) {
      state = { whole: false, subjects: new Set() };
      decided.set(rule, state);
    }
    if (entry.subject !== undefined) state.subjects.add(entry.subject);
    else if (!grouped) state.whole = true;
  }
  return issues;
}

function requestedProblems(p: UnsignedProof, listed: ReadonlyMap<string, ProofOutput>): string[] {
  const requested = p.requested ?? [];
  return [
    ...sortProblems(
      requested,
      byText,
      (i) => `requested not sorted at ${i}`,
      (i) => `requested repeats ${citeName(requested[i] ?? '')}`,
    ),
    ...requested
      .filter((name) => !listed.has(name))
      .map((name) => `requested output absent: ${citeName(name)}`),
  ];
}

function innerOrderProblems(p: UnsignedProof): string[] {
  const issues: string[] = [];
  const components = p.versions.components;
  issues.push(
    ...sortProblems(
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
  p.strata.forEach((names, i) => {
    issues.push(...sortProblems(names, byText, (j) => `strata[${i}] not sorted at ${j}`));
  });
  p.pending.forEach((entry, i) => {
    const at = `pending[${i}].missing`;
    issues.push(
      ...sortProblems(
        entry.missing,
        comparePointers,
        (j) => `${at} not sorted at ${j}`,
        (j) => `${at} repeats ${citeName(entry.missing[j] ?? '')}`,
      ),
    );
  });
  p.applied.forEach((step, i) => {
    for (const [name, match] of Object.entries(step.matches ?? {})) {
      for (const member of ['values', 'via'] as const) {
        const list = match[member];
        const at = `applied[${i}].matches.${name}.${member}`;
        issues.push(
          ...sortProblems(
            list,
            byText,
            (j) => `${citeName(at)} not sorted at ${j}`,
            (j) => `${citeName(at)} repeats ${citeName(list[j] ?? '')}`,
          ),
        );
      }
    }
  });
  p.exceptions.forEach((exception, i) => {
    const { affected } = exception;
    const at = `exceptions[${i}].affected`;
    issues.push(
      ...sortProblems(
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

/**
 * Internal: where `p.strata` contradicts the rest of the proof, each problem reported once, in
 * this order:
 * - each name of `strata`, in order: `stratum output unknown: name` (not a listed output),
 *   `stratum output repeated: name` (in more than one place);
 * - each listed output, in no stratum: `output not in strata: name`;
 * - each entry of `applied`, `skipped`, `pending` and `exceptions`, in order:
 *   `stratum out of range: id@version` when its `stratum` is not an index of `strata`,
 *   otherwise, for an entry naming an output not in `strata[stratum]`,
 *   `step stratum mismatch: id@version`.
 *
 * Linear in the size of the proof: each stratum is turned into a set once.
 */
export function strataProblems(
  p: UnsignedProof,
  listed: ReadonlyMap<string, ProofOutput>,
): string[] {
  const issues: string[] = [];
  const placed = new Set<string>();
  for (const name of p.strata.flat()) {
    if (!listed.has(name)) issues.push(`stratum output unknown: ${citeName(name)}`);
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
export function feedProblems(p: UnsignedProof): string[] {
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
export function modelProblems(p: UnsignedProof): string[] {
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
  p: UnsignedProof,
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
export function undeclaredReadProblems(p: UnsignedProof): string[] {
  const undeclared = new Set(p.readsUndeclared.map(key));
  return [...p.applied, ...p.skipped, ...p.exceptions]
    .filter((entry) => entry.status === 'determined' && undeclared.has(key(entry)))
    .map((entry) => `rule with undeclared reads cannot be determined: ${citeName(key(entry))}`);
}
