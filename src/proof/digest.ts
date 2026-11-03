import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalSha256Hex } from '../canonical.js';
import type { JsonValue } from '../canonical.js';
import { newSpecError, unreadableMessage } from '../errors.js';
import { PROOF_SECTIONS } from './types.js';
import type {
  ProofCounts,
  DecisionProof,
  ProofInput,
  ProofView,
  UnsaltedProof,
  UnsignedProof,
} from './types.js';
import { expectPlainObject, readFields, requireFields, runCheck, walkJson } from '../input/read.js';
import { inputDigestBytes } from '../input/tree.js';
import { readValidInput } from '../input/validate.js';
import type { RuleValidationIssue } from '../issues.js';
import { inconsistencies } from './consistency.js';
import { readUnsaltedProof } from './validate.js';
import { treeDigest } from './tree.js';
import { inputSalter, readSeed, UNSALTED_SEED } from '../input/seed.js';
import { MAX_JSON_VALUES, ownCopy, spendValues, withValueBudget } from '../values.js';
import {
  arrayMap,
  mapGet,
  mapHas,
  objectFromEntries,
  uint8ArrayEvery,
  uint8ArraySubarray,
} from '../intrinsics.js';

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
      if (mapHas(fields.values, 'input') && mapHas(fields.values, 'options')) {
        read = { input: mapGet(fields.values, 'input'), options: mapGet(fields.values, 'options') };
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
 * Seals a proof (D-14, D-16): returns a copy whose every entry carries its `salt`, and whose
 * `digest` commits to its leaves (`proofLeafHashes`): `sha256(0x02 ‖ utf8(format) ‖ 0x00 ‖
 * uint64be(n) ‖ root)`, `root` the RFC 6962 root of its `n` leaves, the header first, then each
 * entry of each section in the order of `PROOF_SECTIONS`. The salt of entry `index` of
 * `section` is the first 16 bytes of `HMAC-SHA256(seed, utf8('proof:' + section + ':' +
 * index))`, in lowercase hex: under a secret seed (`deriveInputSeed`, the seed of the input
 * digest), an entry can later be redacted (`redactProof`) without its leaf giving it away.
 *
 * `seed` defaults to `UNSALTED_SEED` (salts anyone can compute: such a proof cannot be
 * redacted). `inputSalted` must say which: `true` with a secret seed, `false` with
 * `UNSALTED_SEED`. A `digest` or `signature` already on `p` is dropped, so sealing gives a fresh,
 * unsigned proof.
 *
 * `p` is read once into a plain-JSON copy (each property read exactly once); that copy is what
 * is validated, salted, hashed and returned, detached from `p` and without `undefined` members.
 * Lists keep their order: the producer sorts them (see `UnsignedProof`). Its entries carry no
 * `salt` and none is redacted (`UnsaltedProof`).
 *
 * Throws `SpecError`:
 * - `INVALID_KEY` when `seed` is not a `Uint8Array` of 32 bytes (checked first);
 * - `INVALID_PROOF`, `Cannot seal the proof: <first problem>`, when the content is not a valid
 *   unsalted proof (see `validateProof`; an entry with a `salt` or redacted is refused; a value
 *   past the budget is named by its path), when the content fits but its salts would not (`the
 *   salts of its <n> entries would take it past 10000000 values`), when `inputSalted does not
 *   match the seed`, or when it is not internally consistent (the checks
 *   of `verifyProof`: `cited rule not listed: ...`, `outputs not sorted at 1`, `output value does
 *   not follow from its contributions: ...`, …).
 */
export function sealProof(p: UnsaltedProof, seed: Uint8Array = UNSALTED_SEED): DecisionProof {
  return withValueBudget(() => seal(p, seed));
}

function seal(p: UnsaltedProof, seed: Uint8Array): DecisionProof {
  const bytes = readSeed(seed);
  const { proof, errors } = readUnsaltedProof(p);
  if (!proof) throw newSpecError('INVALID_PROOF', `Cannot seal the proof: ${errors[0]}`);
  if (proof.inputSalted === uint8ArrayEvery(bytes, (byte) => byte === 0)) {
    throw newSpecError(
      'INVALID_PROOF',
      'Cannot seal the proof: inputSalted does not match the seed',
    );
  }
  const salted = saltEntries(proof, bytes);
  if (typeof salted === 'number') {
    throw newSpecError(
      'INVALID_PROOF',
      `Cannot seal the proof: the salts of its ${salted} entries would take it past ${MAX_JSON_VALUES} values`,
    );
  }
  const [inconsistency] = inconsistencies(salted);
  if (inconsistency) {
    throw newSpecError('INVALID_PROOF', `Cannot seal the proof: ${inconsistency}`);
  }
  const counts = objectFromEntries(
    arrayMap(PROOF_SECTIONS, (section) => [section, salted[section].length]),
  ) as ProofCounts;
  const content = { ...salted, counts };
  return { ...content, digest: treeDigest(content) };
}

/**
 * `proof` (a snapshot) with the salt of its place on each entry (D-14), or the number of its
 * entries when their salts do not fit the value budget left once it was read (with the digest
 * sealing adds): each salt is a value of the sealed proof, counted here.
 */
function saltEntries(proof: UnsaltedProof, seed: Uint8Array): ProofView | number {
  let entries = 0;
  for (const section of PROOF_SECTIONS) entries += proof[section].length;
  if (!spendValues(entries)) return entries;
  const salter = inputSalter(seed, 'proof:');
  const salted = { ...proof } as unknown as Record<string, unknown>;
  for (const section of PROOF_SECTIONS) {
    salted[section] = arrayMap(proof[section] as readonly object[], (entry: object, i) => ({
      ...entry,
      salt: bytesToHex(uint8ArraySubarray(salter(`${section}:${i}`), 0, SALT_BYTES)),
    }));
  }
  return salted as unknown as ProofView;
}

/** The bytes of the salt of a proof entry (D-14): the first 16 of its HMAC. */
const SALT_BYTES = 16;

/**
 * Internal: the digest `p` should carry, computed from its content (`treeDigest`). `p` must be
 * a plain-JSON snapshot (`readDecisionProof`), never a caller's live object.
 */
export function contentDigest(p: UnsignedProof): string {
  return treeDigest(p);
}
