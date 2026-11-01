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
 * `target decided as if its carrier were not pending` (see `carrierRuleFindings`). Linear in
 * the decisions and the rule definitions, plus the rules each selector may select, plus, per
 * target rule, the instances of the carriers selecting it: the target rules are indexed by
 * each field a selector names (`Index`), so each selector costs one lookup per name it lists;
 * the instances of all the carriers selecting a target rule are merged in one trie (`Scope`,
 * by the target rule as `ruleId`), and each decision asks it once.
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
  // Each target rule, with the instances of every carrier selecting it, in one trie.
  const index = new Index(targets);
  const waiting = new Scope();
  for (const [key, subjects] of carriers) {
    const carrier = definitions.get(key);
    if (carrier === undefined) continue;
    const own = carrier.ruleSet ?? LOCAL_RULE_SET;
    const chosen = new Set<string>();
    for (const selector of selectorsOf(carrier)) {
      for (const target of index.candidates(selector, own)) {
        const definition = targets.get(target);
        if (target === key || chosen.has(target) || definition === undefined) continue;
        if (matchesSelector(selected(definition), selector, own)) chosen.add(target);
      }
    }
    for (const target of chosen) {
      for (const subject of subjects) {
        waiting.mark(subject === undefined ? { ruleId: target } : { ruleId: target, subject });
      }
    }
  }
  // In the order of the decisions: a carrier instance at the decision's subject, above it or
  // under it (D-21).
  for (const decision of early) {
    const key = ruleKey(decision);
    const at =
      decision.subject === undefined ? { ruleId: key } : { ruleId: key, subject: decision.subject };
    if (!waiting.covers(at) && !waiting.within(at)) continue;
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
