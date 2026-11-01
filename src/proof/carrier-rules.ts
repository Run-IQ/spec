import { citeName } from '../errors.js';
import type { RuleDefinition } from '../rule/definition.js';
import { matchesSelector } from '../rule/exceptions.js';
import { LOCAL_RULE_SET, qualifiedFrom } from '../rule/ruleSet.js';
import { subjectContains } from '../path/subject.js';
import { inScope } from './carriers.js';
import { BEFORE_EXCEPTIONS } from './effects.js';
import { imposedKey, imposedSteps, instanceKey } from './output-values.js';
import { ruleKey } from './precedence.js';
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
 * - `carrier exceptions differ from its definition: id@version[ at subject]`: an applied
 *   instance, or one pending with `fired: true`, whose exception records are not exactly the
 *   exceptions its definition carries (one record each, `affected` possibly empty).
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

/** `target decided as if its carrier were not pending` (see `carrierRuleFindings`). */
function waitingTargets(
  p: UnsignedProof,
  definitions: ReadonlyMap<string, RuleDefinition>,
  imposed: ReadonlySet<string>,
  invalid: (message: string) => void,
): void {
  const byRule = new Map<string, Decision[]>();
  const decisions: Decision[] = [
    ...p.applied.filter((step) => !imposed.has(imposedKey(step, step.output))),
    ...p.skipped,
    ...p.pending,
  ];
  for (const decision of decisions) {
    const list = byRule.get(ruleKey(decision)) ?? [];
    list.push(decision);
    byRule.set(ruleKey(decision), list);
  }
  const substituted = new Map<string, (string | undefined)[]>();
  for (const exception of p.exceptions) {
    if (exception.kind !== 'substitute') continue;
    for (const affected of exception.affected) {
      const list = substituted.get(affected.ruleId) ?? [];
      list.push(affected.subject);
      substituted.set(affected.ruleId, list);
    }
  }
  const produced = (decision: Decision): boolean =>
    (substituted.get(decision.ruleId) ?? []).some(
      (at) =>
        at === undefined ||
        (decision.subject !== undefined && subjectContains(at, decision.subject)),
    );
  // Pending, excluded before the exceptions or by another exception, or substituted.
  const waits = (decision: Decision): boolean => {
    if (!('status' in decision)) return true;
    if ('reason' in decision) {
      const { reason } = decision;
      if (BEFORE_EXCEPTIONS.has(reason)) return true;
      if (reason === 'INHIBITED' || reason === 'SHORT_CIRCUITED') return true;
    }
    return produced(decision);
  };
  const targetsOf = new Map<string, string[]>();
  const reported = new Set<Decision>();
  for (const entry of p.pending) {
    if (entry.fired !== false) continue;
    const key = ruleKey(entry);
    const carrier = definitions.get(key);
    if (carrier === undefined) continue;
    let targets = targetsOf.get(key);
    if (targets === undefined) {
      targets = [];
      for (const [other, definition] of definitions) {
        if (other !== key && selects(carrier, definition)) targets.push(other);
      }
      targetsOf.set(key, targets);
    }
    for (const target of targets) {
      for (const decision of byRule.get(target) ?? []) {
        if (reported.has(decision) || !inScope(entry.subject, decision.subject)) continue;
        if (waits(decision)) continue;
        reported.add(decision);
      }
    }
  }
  // In the order of the decisions.
  for (const decision of decisions) {
    if (reported.has(decision)) {
      invalid(
        `target decided as if its carrier were not pending: ${citeName(instanceKey(decision))}`,
      );
    }
  }
}

/** `carrier exceptions differ from its definition` (see `carrierRuleFindings`). */
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
  const fired: { ruleId: string; version: number; subject?: string }[] = [
    ...p.applied.filter((step) => !imposed.has(imposedKey(step, step.output))),
    ...p.pending.filter((entry) => entry.fired === true),
  ];
  for (const instance of fired) {
    const definition = definitions.get(ruleKey(instance));
    if (definition === undefined) continue;
    const recorded = (records.get(instanceKey(instance)) ?? []).sort();
    const defined = definedSignatures(definition);
    const same = recorded.length === defined.length && recorded.every((s, i) => s === defined[i]);
    if (!same) {
      invalid(`carrier exceptions differ from its definition: ${citeName(instanceKey(instance))}`);
    }
  }
}
