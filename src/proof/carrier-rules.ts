import { DEFAULT_OUTPUT } from '../decision/output.js';
import { citeName } from '../errors.js';
import type { RuleDefinition } from '../rule/definition.js';
import { matchesSelector } from '../rule/exceptions.js';
import type { RuleSelector } from '../rule/exceptions.js';
import { LOCAL_RULE_SET, qualifiedFrom, qualifyName } from '../rule/ruleSet.js';
import type { Context } from './combination.js';
import { BEFORE_EXCEPTIONS } from './effects.js';
import { imposedKey, instanceKey } from './output-values.js';
import { ruleKey } from './precedence.js';
import { Scope, stopsCarrier } from './ties.js';
import type { ProofPending, ProofSkip, ProofStep, UnsignedProof } from './types.js';

// Internal to `@run-iq/spec`: the carriers of a proof against the rule definitions `verifyProof`
// was given (`rules`): which rules each targets (`matchesSelector`, as core resolves targets
// statically, D-21) and which exceptions each carries.

type Decision = ProofStep | ProofSkip | ProofPending;

/** What `matchesSelector` reads of `definition`. */
const selected = (definition: RuleDefinition) => ({
  id: definition.id,
  ruleSet: definition.ruleSet ?? LOCAL_RULE_SET,
  tags: definition.tags,
  dimensions: definition.dimensions,
  output: definition.output,
  model: definition.model,
});

/** The `inhibit` and `substitute` selectors of `carrier` (D-21): those that select rules. */
const selectorsOf = (carrier: RuleDefinition): RuleSelector[] =>
  (carrier.exceptions ?? []).flatMap((exception) =>
    exception.kind === 'shortCircuit' ? [] : [exception.targets],
  );

/** True when an `inhibit` or `substitute` of `carrier` selects `target` (D-21, D-37). */
function selects(carrier: RuleDefinition, target: RuleDefinition): boolean {
  const own = carrier.ruleSet ?? LOCAL_RULE_SET;
  const rule = selected(target);
  return selectorsOf(carrier).some((selector) => matchesSelector(rule, selector, own));
}

/**
 * The rule definitions by each field a selector names (`matchesSelector`): qualified id, tag,
 * qualified output, model, dimension and rule set. A selector constrains at least one of them,
 * so the rules it selects are among those of one lookup per name it lists.
 */
class Index {
  private readonly fields = new Map<string, Map<string, string[]>>();

  constructor(definitions: Iterable<[string, RuleDefinition]>) {
    for (const [key, definition] of definitions) {
      const ruleSet = definition.ruleSet ?? LOCAL_RULE_SET;
      this.add('ids', qualifyName(ruleSet, definition.id), key);
      for (const tag of definition.tags) this.add('tags', tag, key);
      this.add('outputs', qualifiedFrom(ruleSet, definition.output ?? DEFAULT_OUTPUT), key);
      this.add('models', definition.model, key);
      for (const dimension of Object.keys(definition.dimensions)) {
        this.add('dimensions', dimension, key);
      }
      this.add('ruleSets', ruleSet, key);
    }
  }

  private add(field: string, value: string, key: string): void {
    let byValue = this.fields.get(field);
    if (byValue === undefined) {
      byValue = new Map();
      this.fields.set(field, byValue);
    }
    const list = byValue.get(value);
    if (list === undefined) byValue.set(value, [key]);
    else if (list[list.length - 1] !== key) list.push(key);
  }

  /** The rules having one of `values` in `field`. */
  private lookup(field: string, values: readonly string[]): string[] {
    const byValue = this.fields.get(field);
    return values.flatMap((value) => byValue?.get(value) ?? []);
  }

  /**
   * The rules `selector`, carried by a rule of `own`, may select: those of its most selective
   * field (the fewest rules), each to be confirmed by `matchesSelector`.
   */
  candidates(selector: RuleSelector, own: string): string[] {
    const qualified = (names: readonly string[]) => names.map((name) => qualifiedFrom(own, name));
    const fields: [string, readonly string[] | undefined][] = [
      ['ids', selector.ids && qualified(selector.ids)],
      ['tags', selector.tags],
      ['outputs', selector.outputs && qualified(selector.outputs)],
      ['models', selector.models],
      ['dimensions', selector.dimensions && Object.keys(selector.dimensions)],
      ['ruleSets', selector.ruleSets?.length ? selector.ruleSets : [own]],
    ];
    let fewest: string[] | undefined;
    for (const [field, values] of fields) {
      if (values === undefined || values.length === 0) continue;
      const found = this.lookup(field, values);
      if (fewest === undefined || found.length < fewest.length) fewest = found;
    }
    return fewest ?? [];
  }
}

/** An exception by its kind, and its output for a short circuit. */
const signature = (kind: string, output: string | undefined): string =>
  kind === 'shortCircuit' ? `${kind}\u0000${output ?? ''}` : kind;

/** The signatures of `definition`'s exceptions, sorted. */
function definedSignatures(definition: RuleDefinition): string[] {
  const own = definition.ruleSet ?? LOCAL_RULE_SET;
  return (definition.exceptions ?? [])
    .map((exception) =>
      signature(
        exception.kind,
        exception.kind === 'shortCircuit' ? qualifiedFrom(own, exception.output) : undefined,
      ),
    )
    .sort();
}

/**
 * Internal: the carriers of `p` against `definitions` (by `id@version`, the rules whose
 * checksum matched), `context` being the proof's (`contextOf`), each reported through
 * `invalid`:
 * - `carrier does not select its target: id@version[ at subject]`: a rule pending
 *   `PENDING_CARRIER` whose `carrier` has no `inhibit` or `substitute` selecting it;
 * - `target decided as if its carrier were not pending: id@version[ at subject]`: a decision
 *   of a rule a carrier pending with `fired: false` selects, in its scope (`inScope`), that is
 *   a step or an exclusion after the exceptions no other exception produced (it is pending
 *   `PENDING_CARRIER`, pending otherwise, excluded before the exceptions, `INHIBITED` or
 *   `SHORT_CIRCUITED`; a substitution decides nothing: its target still waits);
 * - `carrier exceptions differ from its definition: id@version[ at subject]`: an instance
 *   that fired (applied, its step imposed or not, pending with `fired: true`, excluded after
 *   the exceptions ran) whose exception records are not exactly the exceptions its definition
 *   carries (one record each, `affected` possibly empty), or a tie loser whose one record is
 *   of a kind it does not carry.
 */
export function carrierRuleFindings(
  p: UnsignedProof,
  definitions: ReadonlyMap<string, RuleDefinition>,
  context: Context,
  invalid: (message: string) => void,
): void {
  for (const entry of p.pending) {
    if (entry.carrier === undefined) continue;
    const carrier = definitions.get(ruleKey(entry.carrier));
    const target = definitions.get(ruleKey(entry));
    if (carrier !== undefined && target !== undefined && !selects(carrier, target)) {
      invalid(`carrier does not select its target: ${citeName(instanceKey(entry))}`);
    }
  }
  waitingTargets(p, definitions, context.imposed, invalid);
  recordedExceptions(p, definitions, context.ties.losers, invalid);
}

/**
 * A set of carrier rules, as a chain: `carrier`, then those of `parent`. The target rules a
 * group stands for are selected by exactly its carriers; `refined` holds the groups of one
 * carrier more.
 */
interface Group {
  id: string;
  carrier: string;
  parent: Group | undefined;
  refined: Map<string, Group>;
}

/** How a group's decisions ask its carriers' instances (see `waitingTargets`). */
interface Plan {
  members: string[];
  instances: number;
  decisions: number;
  merged: boolean;
}

/** The target rules (among `targets`, through `index`) `carrier`, rule `key`, selects. */
function selectedBy(
  carrier: RuleDefinition,
  key: string,
  index: Index,
  targets: ReadonlyMap<string, RuleDefinition>,
): Set<string> {
  const own = carrier.ruleSet ?? LOCAL_RULE_SET;
  const chosen = new Set<string>();
  for (const selector of selectorsOf(carrier)) {
    for (const target of index.candidates(selector, own)) {
      const definition = targets.get(target);
      if (target === key || chosen.has(target) || definition === undefined) continue;
      if (matchesSelector(selected(definition), selector, own)) chosen.add(target);
    }
  }
  return chosen;
}

/**
 * `target decided as if its carrier were not pending` (see `carrierRuleFindings`). With D
 * decisions, P pending entries, R rule definitions, and the target rules (those with a decision
 * that does not wait) grouped by the exact set of carrier rules (pending with `fired: false`)
 * selecting them, a group g having I_g carrier instances, D_g decisions and C_g carriers, the
 * work is linear in:
 * - D + P + R: the decisions, the carrier instances and the target rules, each indexed once;
 * - the candidates of each selector: the target rules of its most selective field, one lookup
 *   per name it lists (`Index`), each confirmed by `matchesSelector`;
 * - the pairs (carrier rule, target rule it selects), each refining the target's group once;
 * - the questions: each decision of a group asks its merged trie once, or the trie of each of
 *   its carriers in turn, stopping at the first that reaches it: at most C_g questions, a
 *   number the rules fix, never the proof; each question linear in the subject's depth.
 * Memory is linear in P + D, beside the index and the groups of the rules (R, and the pairs):
 * each carrier instance is marked at most once in its own carrier's trie, and the merged
 * tries, chosen by saving (D_g × C_g - I_g, the greatest first, ties in the order of their
 * first decision), hold at most P + D marks in all. One carrier with N instances selecting M
 * target rules marks N instances, never N × M; a carrier beside M carriers selecting one
 * target each, N + M; groups sharing carriers never copy them beyond the budget.
 */
function waitingTargets(
  p: UnsignedProof,
  definitions: ReadonlyMap<string, RuleDefinition>,
  imposed: ReadonlySet<string>,
  invalid: (message: string) => void,
): void {
  // Pending, excluded before the exceptions, or by another exception (a substitution excludes
  // nothing: the rule it reaches is still decided by its own conditions).
  const waits = (decision: Decision): boolean => {
    if (!('status' in decision)) return true;
    if (!('reason' in decision)) return false;
    const { reason } = decision;
    return BEFORE_EXCEPTIONS.has(reason) || reason === 'INHIBITED' || reason === 'SHORT_CIRCUITED';
  };
  const decisions: Decision[] = [];
  for (const step of p.applied) {
    if (!imposed.has(imposedKey(step, step.output))) decisions.push(step);
  }
  for (const skip of p.skipped) decisions.push(skip);
  const early: Decision[] = [];
  const targets = new Map<string, RuleDefinition>();
  for (const decision of decisions) {
    if (waits(decision)) continue;
    const key = ruleKey(decision);
    const definition = definitions.get(key);
    if (definition === undefined) continue;
    early.push(decision);
    targets.set(key, definition);
  }
  if (early.length === 0) return;
  // The subjects of the instances of the carriers pending without firing, by rule.
  const carriers = new Map<string, (string | undefined)[]>();
  for (const entry of p.pending) {
    if (entry.fired !== false) continue;
    const key = ruleKey(entry);
    if (!definitions.has(key)) continue;
    const subjects = carriers.get(key);
    if (subjects === undefined) carriers.set(key, [entry.subject]);
    else subjects.push(entry.subject);
  }
  // The target rules by the exact set of carrier rules selecting them (`Group`), refined
  // carrier by carrier: one step per carrier rule and target rule it selects.
  const index = new Index(targets);
  const groupOf = new Map<string, Group>();
  const top = new Map<string, Group>();
  let groups = 0;
  for (const key of carriers.keys()) {
    const carrier = definitions.get(key);
    if (carrier === undefined) continue;
    for (const target of selectedBy(carrier, key, index, targets)) {
      const parent = groupOf.get(target);
      const children = parent?.refined ?? top;
      let group = children.get(key);
      if (group === undefined) {
        group = { id: String(groups++), carrier: key, parent, refined: new Map() };
        children.set(key, group);
      }
      groupOf.set(target, group);
    }
  }
  // Per group, its carriers and their instances, and its decisions.
  const plans = new Map<Group, Plan>();
  for (const decision of early) {
    const group = groupOf.get(ruleKey(decision));
    if (group === undefined) continue;
    let plan = plans.get(group);
    if (plan === undefined) {
      const members: string[] = [];
      let instances = 0;
      for (let link: Group | undefined = group; link !== undefined; link = link.parent) {
        members.push(link.carrier);
        instances += carriers.get(link.carrier)?.length ?? 0;
      }
      plan = { members, instances, decisions: 0, merged: false };
      plans.set(group, plan);
    }
    plan.decisions += 1;
  }
  // The groups merged in one trie (`merged`, the group's id as `ruleId`): by saving (D_g × C_g
  // questions for I_g marks), the greatest first, ties in the order of their first decision,
  // while their marks fit a budget of the pending entries and the decisions (P + D: memory
  // linear in the proof). Any other group asks the trie of each of its carriers (`own`, the
  // carrier rule as `ruleId`), where each instance is marked once.
  const saving = (plan: Plan): number => plan.decisions * plan.members.length - plan.instances;
  const bySaving = [...plans].filter(([, plan]) => saving(plan) > 0);
  bySaving.sort(([, a], [, b]) => saving(b) - saving(a));
  let budget = p.pending.length + decisions.length;
  const own = new Scope();
  const ownMarked = new Set<string>();
  const merged = new Scope();
  const markAll = (scope: Scope, ruleId: string, key: string): void => {
    for (const subject of carriers.get(key) ?? []) {
      scope.mark(subject === undefined ? { ruleId } : { ruleId, subject });
    }
  };
  for (const [group, plan] of bySaving) {
    if (plan.instances > budget) continue;
    budget -= plan.instances;
    plan.merged = true;
    for (const key of plan.members) markAll(merged, group.id, key);
  }
  for (const plan of plans.values()) {
    if (plan.merged) continue;
    for (const key of plan.members) {
      if (ownMarked.has(key)) continue;
      ownMarked.add(key);
      markAll(own, key, key);
    }
  }
  // In the order of the decisions: a carrier instance at the decision's subject, above it or
  // under it (D-21), the first found ending the questions.
  const reaches = (scope: Scope, ruleId: string, subject: string | undefined): boolean => {
    const at = subject === undefined ? { ruleId } : { ruleId, subject };
    return scope.covers(at) || scope.within(at);
  };
  for (const decision of early) {
    const group = groupOf.get(ruleKey(decision));
    const plan = group && plans.get(group);
    if (group === undefined || plan === undefined) continue;
    const { subject } = decision;
    const waited = plan.merged
      ? reaches(merged, group.id, subject)
      : plan.members.some((key) => reaches(own, key, subject));
    if (!waited) continue;
    invalid(
      `target decided as if its carrier were not pending: ${citeName(instanceKey(decision))}`,
    );
  }
}

/**
 * `carrier exceptions differ from its definition` (see `carrierRuleFindings`): each instance
 * that fired (applied, its step imposed by its own short circuit or not, pending with `fired:
 * true`, excluded for a reason that does not stop a carrier, `stopsCarrier`), counted once,
 * records exactly its definition's exceptions; a tie loser (`losers`, `Ties`) fired nothing,
 * and records its tie record only, of a kind its definition carries.
 */
function recordedExceptions(
  p: UnsignedProof,
  definitions: ReadonlyMap<string, RuleDefinition>,
  losers: ReadonlySet<string>,
  invalid: (message: string) => void,
): void {
  const records = new Map<string, string[]>();
  for (const exception of p.exceptions) {
    const key = instanceKey(exception);
    const list = records.get(key) ?? [];
    list.push(signature(exception.kind, exception.output));
    records.set(key, list);
  }
  const fired: { ruleId: string; version: number; subject?: string }[] = [
    ...p.applied,
    ...p.pending.filter((entry) => entry.fired === true),
    ...p.skipped.filter((skip) => !stopsCarrier(skip.reason)),
  ];
  const seen = new Set<string>();
  for (const instance of fired) {
    const key = instanceKey(instance);
    if (seen.has(key)) continue;
    seen.add(key);
    const definition = definitions.get(ruleKey(instance));
    if (definition === undefined) continue;
    const recorded = (records.get(key) ?? []).sort();
    const defined = definedSignatures(definition);
    const same = losers.has(key)
      ? recorded.length === 1 && defined.includes(recorded[0] ?? '')
      : recorded.length === defined.length && recorded.every((s, i) => s === defined[i]);
    if (!same) invalid(`carrier exceptions differ from its definition: ${citeName(key)}`);
  }
}
