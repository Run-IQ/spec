import { canonicalize } from '../canonical.js';
import type { JsonValue } from '../canonical.js';
import { isCanonicalDecimal } from '../decision/decimal.js';
import { isReservedOutputName } from '../decision/output.js';
import { citeName, newSpecError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import type { DecisionProof, ProofInput, UnsignedProof } from './types.js';
import { readUnsignedProof } from './validate.js';

/**
 * The digest a proof keeps in place of its input: `sha256Hex(canonicalize(input))`. Key order
 * and `undefined` members do not change it. Throws `SpecError` (`NON_SERIALIZABLE`, with the
 * path) for a value that has no JSON form.
 */
export function computeInputDigest(input: ProofInput): string {
  return sha256Hex(canonicalize(input));
}

/**
 * Seals a proof: returns a copy with `digest = sha256Hex(canonicalize(content))`, where the
 * content is every key but `digest` and `signature`. A `digest` or `signature` already on `p`
 * is dropped, so sealing again gives a fresh, unsigned proof.
 *
 * `p` is read once into a plain-JSON copy (each property read exactly once); that copy is what
 * is validated, hashed and returned, detached from `p` and without `undefined` members. Lists
 * keep their order: the producer sorts them (see `UnsignedProof`).
 *
 * Throws `SpecError` (`INVALID_PROOF`), naming the first problem, when the content is not a
 * valid unsigned proof (see `validateProof`) or is not internally consistent (see
 * `inconsistencies`: `cited rule not listed: ...`, `step stratum mismatch: ...`,
 * `output name reserved: ...`, `decimal value not canonical: ...`).
 */
export function sealProof(p: UnsignedProof): DecisionProof {
  const { proof, errors } = readUnsignedProof(p);
  if (!proof) throw newSpecError('INVALID_PROOF', `Cannot seal the proof: ${errors[0]}`);
  const [inconsistency] = inconsistencies(proof);
  if (inconsistency) {
    throw newSpecError('INVALID_PROOF', `Cannot seal the proof: ${inconsistency}`);
  }
  return { ...proof, digest: contentDigest(proof) };
}

/**
 * Internal: the digest `p` should carry, computed from its content. `p` must be a plain-JSON
 * snapshot (`readDecisionProof`, `readUnsignedProof`), never a caller's live object.
 */
export function contentDigest(p: UnsignedProof): string {
  return sha256Hex(canonicalize(proofContent(p)));
}

/**
 * Internal: every way `p` contradicts itself, each reported once, in this order: its unlisted
 * citations (`unlistedCitations`), its strata problems (`strataProblems`), its reserved output
 * names (`reservedOutputNames`) and its non-canonical decimals (`nonCanonicalDecimals`). `p`
 * must be a plain-JSON snapshot that `validateProof` accepts.
 */
export function inconsistencies(p: UnsignedProof): string[] {
  return [
    ...unlistedCitations(p),
    ...strataProblems(p),
    ...reservedOutputNames(p),
    ...nonCanonicalDecimals(p),
  ];
}

/**
 * Internal: the citations of rules that `p.rules` does not list, each reported once, in this
 * order:
 * - each `ruleId@version` of `applied`, `skipped` and `exceptions`:
 *   `cited rule not listed: id@version`;
 * - each rule id in the `contributors` of `outputs` (by output name) and in the `affected` of
 *   `exceptions`, which name rules by id only: `cited rule not listed: id`.
 */
export function unlistedCitations(p: UnsignedProof): string[] {
  const listed = new Set(p.rules.map((rule) => `${rule.id}@${rule.version}`));
  const listedIds = new Set(p.rules.map((rule) => rule.id));
  const issues = new Set<string>();
  for (const cited of [...p.applied, ...p.skipped, ...p.exceptions]) {
    const key = `${cited.ruleId}@${cited.version}`;
    if (!listed.has(key)) issues.add(`cited rule not listed: ${citeName(key)}`);
  }
  const outputNames = Object.keys(p.outputs).sort();
  const citedIds = [
    ...outputNames.flatMap((name) => p.outputs[name]?.contributors ?? []),
    ...p.exceptions.flatMap((exception) => exception.affected),
  ];
  for (const id of citedIds) {
    if (!listedIds.has(id)) issues.add(`cited rule not listed: ${citeName(id)}`);
  }
  return [...issues];
}

/** A shallow copy of `p` without `digest` and `signature`. */
function proofContent(p: UnsignedProof): Record<string, unknown> {
  const content: Record<string, unknown> = { ...p };
  delete content.digest;
  delete content.signature;
  return content;
}

/**
 * Internal: where `p.strata` contradicts the rest of the proof, each problem reported once, in
 * this order:
 * - each name of `strata`, in order: `stratum output unknown: name` (not a key of `outputs`),
 *   `stratum output repeated: name` (in more than one place);
 * - each key of `outputs`, sorted, in no stratum: `output not in strata: name`;
 * - each entry of `applied`, then `skipped`, then `exceptions`, in order: `stratum out of
 *   range: id@version` when its `stratum` is not an index of `strata`, otherwise, for an
 *   applied rule whose `output` is not in `strata[stratum]`, `step stratum mismatch:
 *   id@version`.
 *
 * Linear in the size of the proof: each stratum is turned into a set once.
 */
export function strataProblems(p: UnsignedProof): string[] {
  const issues = new Set<string>();
  const placed = new Set<string>();
  for (const name of p.strata.flat()) {
    if (!Object.hasOwn(p.outputs, name)) issues.add(`stratum output unknown: ${citeName(name)}`);
    if (placed.has(name)) issues.add(`stratum output repeated: ${citeName(name)}`);
    placed.add(name);
  }
  for (const name of Object.keys(p.outputs).sort()) {
    if (!placed.has(name)) issues.add(`output not in strata: ${citeName(name)}`);
  }
  const members = p.strata.map((names) => new Set(names));
  const place = (entry: { ruleId: string; version: number; stratum: number }, output?: string) => {
    const key = `${entry.ruleId}@${entry.version}`;
    const names = members[entry.stratum];
    if (!names) issues.add(`stratum out of range: ${citeName(key)}`);
    else if (output !== undefined && !names.has(output)) {
      issues.add(`step stratum mismatch: ${citeName(key)}`);
    }
  };
  for (const step of p.applied) place(step, step.output);
  for (const entry of [...p.skipped, ...p.exceptions]) place(entry);
  return [...issues];
}

/**
 * Internal: each output name starting with `$` (reserved, ruling R36), reported once as
 * `output name reserved: name`, looking at the keys of `outputs` (sorted), then the names of
 * `strata` and the `output` of `applied`, in order.
 */
export function reservedOutputNames(p: UnsignedProof): string[] {
  const names = [
    ...Object.keys(p.outputs).sort(),
    ...p.strata.flat(),
    ...p.applied.map((step) => step.output),
  ];
  const reserved = new Set(names.filter(isReservedOutputName));
  return [...reserved].map((name) => `output name reserved: ${citeName(name)}`);
}

/**
 * Internal: each `decimal` output (by sorted name) whose `value`, or the `contribution` or
 * `unrounded` value of an applied rule feeding it, is not a canonical decimal string
 * (`isCanonicalDecimal`), reported once as `decimal value not canonical: name`.
 *
 * Linear in the size of the proof: the applied list is read once.
 */
export function nonCanonicalDecimals(p: UnsignedProof): string[] {
  const canonical = (value: JsonValue): boolean =>
    typeof value === 'string' && isCanonicalDecimal(value);
  const isDecimal = (name: string): boolean =>
    Object.hasOwn(p.outputs, name) && p.outputs[name]?.type === 'decimal';
  const failing = new Set<string>();
  for (const step of p.applied) {
    if (!isDecimal(step.output)) continue;
    const unrounded = step.unrounded === undefined || canonical(step.unrounded);
    if (!canonical(step.contribution) || !unrounded) failing.add(step.output);
  }
  const issues: string[] = [];
  for (const name of Object.keys(p.outputs).sort()) {
    if (!isDecimal(name)) continue;
    if (!canonical(p.outputs[name]?.value ?? null) || failing.has(name)) {
      issues.push(`decimal value not canonical: ${citeName(name)}`);
    }
  }
  return issues;
}
