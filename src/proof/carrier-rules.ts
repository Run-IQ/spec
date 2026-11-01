import { citeName } from '../errors.js';
import type { RuleDefinition } from '../rule/definition.js';
import { matchesSelector } from '../rule/exceptions.js';
import { LOCAL_RULE_SET, qualifiedFrom } from '../rule/ruleSet.js';
import { BEFORE_EXCEPTIONS } from './effects.js';
import { imposedKey, imposedSteps, instanceKey } from './output-values.js';
import { ruleKey, standingsOf } from './precedence.js';
import { Scope, stopsCarrier, tiesOf } from './ties.js';
import type { ProofPending, ProofSkip, ProofStep, UnsignedProof } from './types.js';

// Internal to `@run-iq/spec`: the carriers of a proof against the rule definitions `verifyProof`
// was given (`rules`): which rules each targets (`matchesSelector`, as core resolves targets
// statically, D-21) and which exceptions each carries.

type Decision = ProofStep | ProofSkip | ProofPending;

/** True when an `inhibit` or `substitute` of `carrier` selects `target` (D-21, D-37). */
function selects(carrier: RuleDefinition, target: RuleDefinition): boolean {
  const own = carrier.ruleSet ?? LOCAL_RULE_SET;
  const rule = {
    id: target.id,
    ruleSet: target.ruleSet ?? LOCAL_RULE_SET,
    tags: target.tags,
    dimensions: target.dimensions,
    output: target.output,
    model: target.model,
  };
  return (carrier.exceptions ?? []).some(
    (exception) =>
      exception.kind !== 'shortCircuit' && matchesSelector(rule, exception.targets, own),
  );
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
 * checksum matched), each reported through `invalid`:
 * - `carrier does not select its target: id@version[ at subject]`: a rule pending
 *   `PENDING_CARRIER` whose `carrier` has no `inhibit` or `substitute` selecting it;
 * - `target decided as if its carrier were not pending: id@version[ at subject]`: a decision
 *   of a rule a carrier pending with `fired: false` selects, in its scope (`inScope`), that is
 *   a step or an exclusion after the exceptions no other exception produced (it is pending
 *   `PENDING_CARRIER`, pending otherwise, excluded before the exceptions, `INHIBITED`,
 *   `SHORT_CIRCUITED` or substituted);
 * - `carrier exceptions differ from its definition: id@version[ at subject]`: an instance
 *   that fired (applied, pending with `fired: true`, excluded after the exceptions ran) whose
 *   exception records are not exactly the exceptions its definition carries (one record each,
 *   `affected` possibly empty), or a tie loser whose one record is of a kind it does not carry.
 */
export function carrierRuleFindings(
  p: UnsignedProof,
  definitions: ReadonlyMap<string, RuleDefinition>,
  invalid: (message: string) => void,
): void {
  const imposed = imposedSteps(p);
  for (const entry of p.pending) {
    if (entry.carrier === undefined) continue;
    const carrier = definitions.get(ruleKey(entry.carrier));
    const target = definitions.get(ruleKey(entry));
    if (carrier !== undefined && target !== undefined && !selects(carrier, target)) {
      invalid(`carrier does not select its target: ${citeName(instanceKey(entry))}`);
    }
  }
  waitingTargets(p, definitions, imposed, invalid);
  recordedExceptions(p, definitions, imposed, invalid);
}

/**
 * `target decided as if its carrier were not pending` (see `carrierRuleFindings`). Linear in
 * the decisions, plus the selectors against the rule definitions, plus the decisions of each
 * target a carrier selects: the decisions are indexed by rule once, the carrier instances by
 * subject in one trie (`Scope`), and each decision asks each carrier selecting its rule once.
 */
function waitingTargets(
  p: UnsignedProof,
  definitions: ReadonlyMap<string, RuleDefinition>,
  imposed: ReadonlySet<string>,
  invalid: (message: string) => void,
): void {
  // A substitution reaches its affected rules at their subject or under it.
  const substituted = new Scope();
  for (const exception of p.exceptions) {
    if (exception.kind !== 'substitute') continue;
    for (const affected of exception.affected) substituted.mark(affected);
  }
  // Pending, excluded before the exceptions or by another exception, or substituted.
  const waits = (decision: Decision): boolean => {
    if (!('status' in decision)) return true;
    if ('reason' in decision) {
      const { reason } = decision;
      if (BEFORE_EXCEPTIONS.has(reason)) return true;
      if (reason === 'INHIBITED' || reason === 'SHORT_CIRCUITED') return true;
    }
    return substituted.covers(decision);
  };
  const decisions: Decision[] = [];
  for (const step of p.applied) {
    if (!imposed.has(imposedKey(step, step.output))) decisions.push(step);
  }
  for (const skip of p.skipped) decisions.push(skip);
  const early = new Map<string, Decision[]>();
  for (const decision of decisions) {
    if (waits(decision)) continue;
    const key = ruleKey(decision);
    const list = early.get(key);
    if (list === undefined) early.set(key, [decision]);
    else list.push(decision);
  }
  // The instances of the carriers pending without firing, by rule (as `ruleId`) and subject.
  const waiting = new Scope();
  const carriers = new Set<string>();
  for (const entry of p.pending) {
    if (entry.fired !== false) continue;
    const key = ruleKey(entry);
    if (!definitions.has(key)) continue;
    carriers.add(key);
    waiting.mark(
      entry.subject === undefined ? { ruleId: key } : { ruleId: key, subject: entry.subject },
    );
  }
  const reported = new Set<Decision>();
  for (const key of carriers) {
    const carrier = definitions.get(key);
    if (carrier === undefined) continue;
    for (const [target, definition] of definitions) {
      const list = early.get(target);
      if (target === key || list === undefined || !selects(carrier, definition)) continue;
      for (const decision of list) {
        if (reported.has(decision)) continue;
        const at =
          decision.subject === undefined
            ? { ruleId: key }
            : { ruleId: key, subject: decision.subject };
        // A carrier instance at the decision's subject, above it or under it (D-21).
        if (waiting.covers(at) || waiting.within(at)) reported.add(decision);
      }
    }
  }
  // In the order of the decisions.
  for (const decision of decisions) {
    if (!reported.has(decision)) continue;
    invalid(
      `target decided as if its carrier were not pending: ${citeName(instanceKey(decision))}`,
    );
  }
}

/**
 * `carrier exceptions differ from its definition` (see `carrierRuleFindings`): each instance
 * that fired (applied, pending with `fired: true`, excluded for a reason that does not stop a
 * carrier, `stopsCarrier`) records exactly its definition's exceptions; a tie loser (`Ties`)
 * fired nothing, and records its tie record only, of a kind its definition carries.
 */
function recordedExceptions(
  p: UnsignedProof,
  definitions: ReadonlyMap<string, RuleDefinition>,
  imposed: ReadonlySet<string>,
  invalid: (message: string) => void,
): void {
  const records = new Map<string, string[]>();
  for (const exception of p.exceptions) {
    const key = instanceKey(exception);
    const list = records.get(key) ?? [];
    list.push(signature(exception.kind, exception.output));
    records.set(key, list);
  }
  const { losers } = tiesOf(p, standingsOf(p));
  const fired: { ruleId: string; version: number; subject?: string }[] = [
    ...p.applied.filter((step) => !imposed.has(imposedKey(step, step.output))),
    ...p.pending.filter((entry) => entry.fired === true),
    ...p.skipped.filter((skip) => !stopsCarrier(skip.reason)),
  ];
  for (const instance of fired) {
    const definition = definitions.get(ruleKey(instance));
    if (definition === undefined) continue;
    const key = instanceKey(instance);
    const recorded = (records.get(key) ?? []).sort();
    const defined = definedSignatures(definition);
    const same = losers.has(key)
      ? recorded.length === 1 && defined.includes(recorded[0] ?? '')
      : recorded.length === defined.length && recorded.every((s, i) => s === defined[i]);
    if (!same) invalid(`carrier exceptions differ from its definition: ${citeName(key)}`);
  }
}
