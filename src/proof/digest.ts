import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalSha256Hex } from '../canonical.js';
import type { JsonValue } from '../canonical.js';
import { isCanonicalDecimal } from '../decision/decimal.js';
import { isReservedOutputName } from '../decision/output.js';
import { citeName, newSpecError, unreadableMessage } from '../errors.js';
import type { DecisionProof, ProofInput, UnsignedProof } from './types.js';
import { expectPlainObject, readFields, requireFields, runCheck, walkJson } from '../input/read.js';
import { inputDigestBytes } from '../input/tree.js';
import { readValidInput } from '../input/validate.js';
import type { RuleValidationIssue } from '../issues.js';
import { offDeclarationValues } from './output-values.js';
import { readUnsignedProof } from './validate.js';
import { ownCopy, withValueBudget } from '../values.js';

/**
 * The digest a proof keeps in place of its input (D-15), lowercase hex:
 * `sha256(0x02 ‖ utf8('run-iq.input/1') ‖ 0x00 ‖ uint64be(n) ‖ root)`, where `n` is the number
 * of leaves of the input tree of `input` under `seed` (`inputLeaves`) and `root` the RFC 6962
 * root of their hashes (`inputLeafHash`, `merkleRoot`; the sha256 of nothing when `n` is 0).
 * It commits to the leaf count, so a disclosed leaf is checked against it with its size
 * (`verifyInputInclusion`). Key order does not change it; every fact, the seed and the place
 * of each value do. With a
 * secret seed (`deriveInputSeed`), the leaves are salted: a fact can later be disclosed alone,
 * and the digest cannot be tested against guessed inputs; with `UNSALTED_SEED`, anyone holding
 * the input can recompute it.
 *
 * `seed` is checked first (`INVALID_KEY` unless a `Uint8Array` of 32 bytes), then `input` is
 * read once and checked as `validateProofInput` checks it: it refuses exactly what that
 * validator refuses, with `SpecError` (`INVALID_INPUT`, `invalid input: <first problem>`, the
 * problem's path as `path`), never a raw error. The tree is built from the copy read, each
 * value counted once.
 */
export function computeInputDigest(input: ProofInput, seed: Uint8Array): string {
  return withValueBudget(() => bytesToHex(inputDigestBytes(input, seed)));
}

/**
 * The idempotency digest of a request (D-17): `sha256Hex(canonicalize(request))`, where
 * `request.input` is the normalized input and `request.options` the canonical form of the
 * options that change the decision (`core` builds it). Unsalted: the decision store keeps it
 * beside the decision to recognise a retry of the same request; it is never published (not in
 * a result, a proof or a log), since anyone holding a guess of the input could test it.
 *
 * `request` is read once: a plain object with exactly `input` and `options`. Throws
 * `SpecError` (`INVALID_INPUT`): for the request itself, `invalid request: <problem>`; for its
 * input, as `computeInputDigest` does (`invalid input: <first problem>`, the path in the
 * input); for its options, which must be a plain object of plain JSON as an input holds it
 * (no `undefined`, no hole, finite numbers below 2^53, at most 1000 levels),
 * `invalid options: <problem>` (the path in the options).
 */
export function computeIdempotencyDigest(request: {
  input: ProofInput;
  options: { [k: string]: JsonValue };
}): string {
  return withValueBudget(() => {
    const { input, options } = readRequest(request);
    const snapshot = readValidInput(input);
    const optionsCopy = readOptions(options);
    // Both copies were counted when they were read from the caller.
    // Hashed as it is written: the canonical text of a large request is never built.
    return ownCopy(() => canonicalSha256Hex({ input: snapshot, options: optionsCopy }));
  });
}

/** The two members of a request, each read once, or a thrown `SpecError` (`INVALID_INPUT`). */
function readRequest(value: unknown): { input: unknown; options: unknown } {
  let read: { input: unknown; options: unknown } | undefined;
  const { issues } = runCheck(
    (reader) => {
      const { add } = reader;
      const shape = 'a plain object { input, options }';
      if (!expectPlainObject(value, '', shape, add, 'a request')) return;
      const fields = readFields(value, '', 'request', REQUEST_KEYS, reader);
      if (fields === undefined) return;
      requireFields(fields, '', REQUEST_KEYS, add);
      if (fields.values.has('input') && fields.values.has('options')) {
        read = { input: fields.values.get('input'), options: fields.values.get('options') };
      }
    },
    (error) => ({ path: '', message: unreadableMessage('request', error) }),
  );
  return issueOr(issues, read, 'invalid request');
}

/** A plain copy of the options, or a thrown `SpecError` (`INVALID_INPUT`). */
function readOptions(value: unknown): JsonValue {
  let copy: JsonValue | undefined;
  const { issues } = runCheck(
    (reader) => {
      if (expectPlainObject(value, '', 'a plain object', reader.add, 'options')) {
        copy = walkJson(value, '', reader).copy;
      }
    },
    (error) => ({ path: '', message: unreadableMessage('options', error) }),
    { copy: true },
  );
  return issueOr(issues, copy, 'invalid options');
}

const REQUEST_KEYS: readonly string[] = ['input', 'options'];

/** `value` when `issues` is empty; otherwise throws `INVALID_INPUT` naming the first issue. */
function issueOr<T>(issues: readonly RuleValidationIssue[], value: T | undefined, what: string): T {
  const [first] = issues;
  if (first !== undefined || value === undefined) {
    throw newSpecError('INVALID_INPUT', `${what}: ${first?.message ?? 'unreadable'}`, first?.path);
  }
  return value;
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
  return withValueBudget(() => seal(p));
}

function seal(p: UnsignedProof): DecisionProof {
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
  // The snapshot's values were counted when they were read from the caller.
  return ownCopy(() => canonicalSha256Hex(proofContent(p)));
}

/**
 * Internal: every way `p` contradicts itself, each reported once, in this order: its unlisted
 * citations (`unlistedCitations`), its strata problems (`strataProblems`), its reserved output
 * names (`reservedOutputNames`), its non-canonical decimals (`nonCanonicalDecimals`) and its
 * values that contradict their output's declaration (`offDeclarationValues`). `p`
 * must be a plain-JSON snapshot that `validateProof` accepts.
 */
export function inconsistencies(p: UnsignedProof): string[] {
  return [
    ...unlistedCitations(p),
    ...strataProblems(p),
    ...reservedOutputNames(p),
    ...nonCanonicalDecimals(p),
    ...offDeclarationValues(p),
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
