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
import type { ProofPending, ProofSkip, ProofStep, ProofView } from './types.js';
import { isLifted, LIFTS } from './lifts.js';
import type { RuleIdentity } from './lifts.js';
import {
  NativeMap,
  NativeSet,
  NativeString,
  arrayEvery,
  arrayFilter,
  arrayFlatMap,
  arrayIncludes,
  arrayMap,
  arrayPush,
  arraySome,
  arraySort,
  mapGet,
  mapHas,
  mapKeys,
  mapSet,
  mapValues,
  objectKeys,
  setAdd,
  setHas,
  stringCharCodeAt,
} from '../intrinsics.js';

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
  arrayFlatMap(carrier.exceptions ?? [], (exception) =>
    exception.kind === 'shortCircuit' ? [] : [exception.targets],
  );

/** True when an `inhibit` or `substitute` of `carrier` selects `target` (D-21, D-37). */
function selects(carrier: RuleDefinition, target: RuleDefinition): boolean {
  const own = carrier.ruleSet ?? LOCAL_RULE_SET;
  const rule = selected(target);
  return arraySome(selectorsOf(carrier), (selector) => matchesSelector(rule, selector, own));
}

/**
 * The rule definitions by each field a selector names (`matchesSelector`): qualified id, tag,
 * qualified output, model, dimension and rule set. A selector constrains at least one of them,
 * so the rules it selects are among those of one lookup per name it lists.
 */
class Index {
  private readonly fields = new NativeMap<string, Map<string, string[]>>();

  constructor(definitions: Iterable<[string, RuleDefinition]>) {
    for (const [key, definition] of definitions) {
      const ruleSet = definition.ruleSet ?? LOCAL_RULE_SET;
      this.add('ids', qualifyName(ruleSet, definition.id), key);
      for (const tag of definition.tags) this.add('tags', tag, key);
      this.add('outputs', qualifiedFrom(ruleSet, definition.output ?? DEFAULT_OUTPUT), key);
      this.add('models', definition.model, key);
      for (const dimension of objectKeys(definition.dimensions)) {
        this.add('dimensions', dimension, key);
      }
      this.add('ruleSets', ruleSet, key);
    }
  }

  private add(field: string, value: string, key: string): void {
    let byValue = mapGet(this.fields, field);
    if (byValue === undefined) {
      byValue = new NativeMap();
      mapSet(this.fields, field, byValue);
    }
    const list = mapGet(byValue, value);
    if (list === undefined) mapSet(byValue, value, [key]);
    else if (list[list.length - 1] !== key) arrayPush(list, key);
  }

  /** The rules having one of `values` in `field`. */
  private lookup(field: string, values: readonly string[]): string[] {
    const byValue = mapGet(this.fields, field);
    return arrayFlatMap(
      values,
      (value) => (byValue === undefined ? undefined : mapGet(byValue, value)) ?? [],
    );
  }

  /**
   * The rules `selector`, carried by a rule of `own`, may select: those of its most selective
   * field (the fewest rules), each to be confirmed by `matchesSelector`.
   */
  candidates(selector: RuleSelector, own: string): string[] {
    const qualified = (names: readonly string[]) =>
      arrayMap(names, (name) => qualifiedFrom(own, name));
    const fields: [string, readonly string[] | undefined][] = [
      ['ids', selector.ids && qualified(selector.ids)],
      ['tags', selector.tags],
      ['outputs', selector.outputs && qualified(selector.outputs)],
      ['models', selector.models],
      ['dimensions', selector.dimensions && objectKeys(selector.dimensions)],
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
  return arraySort(
    arrayMap(definition.exceptions ?? [], (exception) =>
      signature(
        exception.kind,
        exception.kind === 'shortCircuit' ? qualifiedFrom(own, exception.output) : undefined,
      ),
    ),
  );
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
 *   of a kind it does not carry. Not checked while `skipped` or `exceptions` has a redacted
 *   entry (`context.hidden`): a record, or what makes a carrier a tie loser, may be hidden.
 */
export function carrierRuleFindings(
  p: ProofView,
  definitions: ReadonlyMap<string, RuleDefinition>,
  context: Context,
  invalid: (message: string) => void,
): void {
  // Whether a carrier selects a target derives from the rules alone: once per pair.
  const selections = new NativeMap<string, boolean>();
  for (const entry of p.pending) {
    if (entry.carrier === undefined) continue;
    const carrierKey = ruleKey(entry.carrier);
    const targetKey = ruleKey(entry);
    const carrier = mapGet(definitions, carrierKey);
    const target = mapGet(definitions, targetKey);
    if (carrier === undefined || target === undefined) continue;
    const pair = `${carrierKey}\u0000${targetKey}`;
    let selected = mapGet(selections, pair);
    if (selected === undefined) {
      selected = selects(carrier, target);
      mapSet(selections, pair, selected);
    }
    if (!selected) invalid(`carrier does not select its target: ${citeName(instanceKey(entry))}`);
  }
  waitingTargets(p, definitions, context.imposed, invalid);
  // The exception records of a carrier, or its exclusion, may be redacted.
  // A hidden record or exclusion of that carrier instance.
  recordedExceptions(p, definitions, context.ties.losers, (message, rule) => {
    const ties = context.ties.uncertain;
    if (!isLifted(context.hidden, LIFTS.carrierRecords, { message, rule, ties })) invalid(message);
  });
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
  /** N_g: the trie nodes of its carriers' instances, merged. */
  nodes: number;
  /** S_g: the steps of one question per decision, through its subject (`nodesOf`). */
  steps: number;
  merged: boolean;
}

/**
 * The trie nodes a subject needs, a question through it costs: one per segment (a JSON
 * pointer's `/`), plus the root.
 */
function nodesOf(subject: string | undefined): number {
  let nodes = 1;
  if (subject === undefined) return nodes;
  for (let i = 0; i < subject.length; i++) if (stringCharCodeAt(subject, i) === 0x2f) nodes++;
  return nodes;
}

/** The target rules (among `targets`, through `index`) `carrier`, rule `key`, selects. */
function selectedBy(
  carrier: RuleDefinition,
  key: string,
  index: Index,
  targets: ReadonlyMap<string, RuleDefinition>,
): Set<string> {
  const own = carrier.ruleSet ?? LOCAL_RULE_SET;
  const chosen = new NativeSet<string>();
  for (const selector of selectorsOf(carrier)) {
    for (const target of index.candidates(selector, own)) {
      const definition = mapGet(targets, target);
      if (target === key || setHas(chosen, target) || definition === undefined) continue;
      if (matchesSelector(selected(definition), selector, own)) setAdd(chosen, target);
    }
  }
  return chosen;
}

/**
 * `target decided as if its carrier were not pending` (see `carrierRuleFindings`). With D
 * decisions, P pending entries, R rule definitions, and the target rules (those with a decision
 * that does not wait) grouped by the exact set of carrier rules (pending with `fired: false`)
 * selecting them, a group g having C_g carriers, N_g trie nodes for their instances (one per
 * subject segment, plus one: `nodesOf`) and S_g nodes through its decisions' subjects, the
 * work is linear in:
 * - D + P + R and the subject segments: the decisions, the carrier instances and the target
 *   rules, each indexed once;
 * - the candidates of each selector: the target rules of its most selective field, one lookup
 *   per name it lists (`Index`), each confirmed by `matchesSelector`;
 * - the pairs (carrier rule, target rule it selects), each refining the target's group once;
 * - the questions: each decision of a group asks its merged trie once, or the trie of each of
 *   its carriers in turn, stopping at the first that reaches it: at most C_g questions, a
 *   number the rules fix, never the proof; each question linear in the subject's depth.
 * Memory is linear in the total subject segments of the proof (those of the pending entries and
 * decisions, plus P + D), beside the index and the groups of the rules (R, and the pairs):
 * each carrier instance is marked at most once in its own carrier's trie, and the merged
 * tries, chosen by saving (S_g × C_g - N_g, the greatest first, ties in the order of their
 * first decision), hold at most that many nodes in all. One carrier with N instances selecting
 * M target rules marks N instances, never N × M; a carrier beside M carriers selecting one
 * target each, N + M; groups sharing carriers, or a deep instance, never copy them beyond the
 * budget.
 */
function waitingTargets(
  p: ProofView,
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
    return (
      setHas(BEFORE_EXCEPTIONS, reason) || reason === 'INHIBITED' || reason === 'SHORT_CIRCUITED'
    );
  };
  const decisions: Decision[] = [];
  for (const step of p.applied) {
    if (!setHas(imposed, imposedKey(step, step.output))) arrayPush(decisions, step);
  }
  for (const skip of p.skipped) arrayPush(decisions, skip);
  const early: Decision[] = [];
  const targets = new NativeMap<string, RuleDefinition>();
  for (const decision of decisions) {
    if (waits(decision)) continue;
    const key = ruleKey(decision);
    const definition = mapGet(definitions, key);
    if (definition === undefined) continue;
    arrayPush(early, decision);
    mapSet(targets, key, definition);
  }
  if (early.length === 0) return;
  // The subjects of the instances of the carriers pending without firing, by rule.
  // With the trie nodes they need (`nodesOf`), and the nodes all the subjects of the pending
  // entries and decisions would need: the budget of the merged tries.
  const carriers = new NativeMap<string, (string | undefined)[]>();
  const carrierNodes = new NativeMap<string, number>();
  let budget = 0;
  for (const decision of decisions) budget += nodesOf(decision.subject);
  for (const entry of p.pending) {
    const nodes = nodesOf(entry.subject);
    budget += nodes;
    if (entry.fired !== false) continue;
    const key = ruleKey(entry);
    if (!mapHas(definitions, key)) continue;
    const subjects = mapGet(carriers, key);
    if (subjects === undefined) mapSet(carriers, key, [entry.subject]);
    else arrayPush(subjects, entry.subject);
    mapSet(carrierNodes, key, (mapGet(carrierNodes, key) ?? 0) + nodes);
  }
  // The target rules by the exact set of carrier rules selecting them (`Group`), refined
  // carrier by carrier: one step per carrier rule and target rule it selects.
  const index = new Index(targets);
  const groupOf = new NativeMap<string, Group>();
  const top = new NativeMap<string, Group>();
  let groups = 0;
  for (const key of mapKeys(carriers)) {
    const carrier = mapGet(definitions, key);
    if (carrier === undefined) continue;
    for (const target of selectedBy(carrier, key, index, targets)) {
      const parent = mapGet(groupOf, target);
      const children = parent?.refined ?? top;
      let group = mapGet(children, key);
      if (group === undefined) {
        group = { id: NativeString(groups++), carrier: key, parent, refined: new NativeMap() };
        mapSet(children, key, group);
      }
      mapSet(groupOf, target, group);
    }
  }
  // Per group, its carriers and their instances, and its decisions.
  const plans = new NativeMap<Group, Plan>();
  for (const decision of early) {
    const group = mapGet(groupOf, ruleKey(decision));
    if (group === undefined) continue;
    let plan = mapGet(plans, group);
    if (plan === undefined) {
      const members: string[] = [];
      let nodes = 0;
      for (let link: Group | undefined = group; link !== undefined; link = link.parent) {
        arrayPush(members, link.carrier);
        nodes += mapGet(carrierNodes, link.carrier) ?? 0;
      }
      plan = { members, nodes, steps: 0, merged: false };
      mapSet(plans, group, plan);
    }
    plan.steps += nodesOf(decision.subject);
  }
  // The groups merged in one trie (`merged`, the group's id as `ruleId`), in trie nodes: by
  // saving (S_g × C_g steps of questions for N_g nodes), the greatest first, ties in the order
  // of their first decision, while their nodes fit the budget (memory linear in the subject
  // segments of the proof). Any other group asks the trie of each of its carriers (`own`, the
  // carrier rule as `ruleId`), where each instance is marked once.
  const saving = (plan: Plan): number => plan.steps * plan.members.length - plan.nodes;
  const bySaving = arrayFilter([...plans], ([, plan]) => saving(plan) > 0);
  arraySort(bySaving, ([, a], [, b]) => saving(b) - saving(a));
  const own = new Scope();
  const ownMarked = new NativeSet<string>();
  const merged = new Scope();
  const markAll = (scope: Scope, ruleId: string, key: string): void => {
    for (const subject of mapGet(carriers, key) ?? []) {
      scope.mark(subject === undefined ? { ruleId } : { ruleId, subject });
    }
  };
  for (const [group, plan] of bySaving) {
    if (plan.nodes > budget) continue;
    budget -= plan.nodes;
    plan.merged = true;
    for (const key of plan.members) markAll(merged, group.id, key);
  }
  for (const plan of mapValues(plans)) {
    if (plan.merged) continue;
    for (const key of plan.members) {
      if (setHas(ownMarked, key)) continue;
      setAdd(ownMarked, key);
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
    const group = mapGet(groupOf, ruleKey(decision));
    const plan = group && mapGet(plans, group);
    if (group === undefined || plan === undefined) continue;
    const { subject } = decision;
    const waited = plan.merged
      ? reaches(merged, group.id, subject)
      : arraySome(plan.members, (key) => reaches(own, key, subject));
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
  p: ProofView,
  definitions: ReadonlyMap<string, RuleDefinition>,
  losers: ReadonlySet<string>,
  invalid: (message: string, carrier: RuleIdentity) => void,
): void {
  const records = new NativeMap<string, string[]>();
  for (const exception of p.exceptions) {
    const key = instanceKey(exception);
    const list = mapGet(records, key) ?? [];
    arrayPush(list, signature(exception.kind, exception.output));
    mapSet(records, key, list);
  }
  const fired: { ruleId: string; version: number; subject?: string }[] = [
    ...p.applied,
    ...arrayFilter(p.pending, (entry) => entry.fired === true),
    ...arrayFilter(p.skipped, (skip) => !stopsCarrier(skip.reason)),
  ];
  const seen = new NativeSet<string>();
  const signatures = new NativeMap<string, string[]>();
  for (const instance of fired) {
    const key = instanceKey(instance);
    if (setHas(seen, key)) continue;
    setAdd(seen, key);
    const ruleOf = ruleKey(instance);
    const definition = mapGet(definitions, ruleOf);
    if (definition === undefined) continue;
    const recorded = arraySort(mapGet(records, key) ?? []);
    // A definition's signatures derive from it alone: once per rule.
    let defined = mapGet(signatures, ruleOf);
    if (defined === undefined) {
      defined = definedSignatures(definition);
      mapSet(signatures, ruleOf, defined);
    }
    const same = setHas(losers, key)
      ? recorded.length === 1 && arrayIncludes(defined, recorded[0] ?? '')
      : recorded.length === defined.length && arrayEvery(recorded, (s, i) => s === defined[i]);
    if (same) continue;
    const { ruleId: id, version, subject } = instance;
    const carrier = subject === undefined ? { id, version } : { id, version, subject };
    invalid(`carrier exceptions differ from its definition: ${citeName(key)}`, carrier);
  }
}
