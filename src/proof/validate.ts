import { citeName, unreadableMessage } from '../errors.js';
import { IssueList } from '../issues.js';
import type { RuleValidationIssue } from '../issues.js';
import { isRuleVersion } from '../rule/definition.js';
import { isRuleSetId, qualifyName } from '../rule/ruleSet.js';
import { isPlainObject, withValueBudget } from '../values.js';
import { checkObject, scalarCheck } from './checks.js';
import type { Add, Shape } from './checks.js';
import {
  DECISION_PROOF,
  PROOF_HEADER,
  SECTION_ENTRY,
  UNSALTED_PROOF,
  UNSIGNED_PROOF,
} from './shape.js';
import { PROOF_SECTIONS } from './types.js';
import type {
  DecisionProof,
  ProofHeader,
  ProofSection,
  UnsaltedProof,
  UnsignedProof,
} from './types.js';

const SEAL_KEYS: ReadonlySet<string> = new Set(['digest', 'signature']);

/**
 * Checks a decision proof without throwing and reports every problem found, each with its path
 * (`rules[1].checksum`, `outputs[0].type`; `''` when the value itself is not an object), like
 * `validateRuleDefinition`. `errors` holds the same messages, in the same order.
 *
 * It checks the shape only, never the digest or the signature (`verifyProof` does):
 * - the format is closed: every object refuses unknown keys; a member whose value is
 *   `undefined` is absent, known or not (the TypeScript idiom of an optional field), as in the
 *   canonical form, while an `undefined` inside a free-form value (an output value, bounds, a
 *   contribution, `unrounded`) or as a list item is refused: `<path> is not JSON: undefined`;
 * - a value that cannot be read (a getter or a Proxy trap that throws) gives the single issue
 *   `proof could not be read: <reason>` at path `''`; a free-form value that cannot be read is
 *   reported at its path, and one nested more than `MAX_JSON_DEPTH` (1000) levels deep gives
 *   `<path> is nested deeper than 1000 levels`, at its first container past the limit; each
 *   value is counted once, and past `MAX_JSON_VALUES` values in all,
 *   `<path> is too large: more than 10000000 values`;
 * - `format` is one of `PROOF_FORMATS`; a string that is not gives the single issue
 *   `unknown format: <format>` at path `format` (the rest follows rules of another format);
 * - the header: `evaluatedAt` is `null`, a civil date or a canonical instant; `sealedAt` a
 *   canonical instant (`YYYY-MM-DDTHH:MM:SS.sssZ`); `inputDigest` and `digest` lowercase sha256
 *   hex; `inputSalted` a boolean; `timeZone` (and a rule set's) a time zone in its normal form;
 *   `ruleSets` a list of packs `{ kind, id, version, digest, imports?, timeZone? }` (pack ids,
 *   `imports` not empty), local entries `{ kind, timeZone? }` and referentials `{ kind, id,
 *   version, digest }`; `versions` with `engine`, `plugins`, `dsls`, `models` and `components`
 *   (`declaredBy` is `engine`, `plugin:<name>` or `model:<name>`); `strata` lists of output
 *   names; `requested` a non-empty list of output names; `supersedes` `{ digest, reason }`
 *   with `reason` a code (`^[a-z0-9][a-z0-9_-]*$`);
 * - the ten sections are lists, each entry closed and carrying a `salt` of 16 bytes in
 *   lowercase hex. A rule is `{ id, version, checksum, ruleSet, priority, sourceRef?, salt }`,
 *   its id bare and its priority a finite number; a step's `rank` is a non-negative integer; an
 *   exception names its `output` when it is a `shortCircuit`, and only then. Every other rule
 *   is cited by its qualified id (`qualifyName`, D-37) and every output by its name, both as
 *   cited names (`citedNameProblem`: no `$` output, no `local:`); subjects are subjects
 *   (`isSubject`); pending `missing` pointers are pointers of the evaluation
 *   context, and fact paths pointers to an input fact (`contextToInputPointer`); a pending
 *   entry's `fired`, when present, is a boolean (whether its rule carries exceptions,
 *   which it must then carry, only the rules' definitions say: `verifyProof` with `rules`);
 *   a pending entry carries `carrier` (`{ ruleId, version, subject? }`) exactly when its reason
 *   is `PENDING_CARRIER`, and an `ERROR` entry's `detail` is `<CAUSE>: <message>`, its cause
 *   (the text before the first `:`) one of `ERROR_CAUSES`;
 * - an output carries its declaration in its normal form, checked as an output declaration
 *   (`validateOutputDeclaration`); its `status` is an output status, while the status of a
 *   step, an exclusion or an exception is never `undetermined`;
 * - a grouped exclusion (`instances`, 2 or more) has no subject and one of the reasons
 *   `INACTIVE_DATE`, `DIMENSION_MISMATCH`, `TAG_MISMATCH`, `NOT_REQUESTED`; a fact read carries
 *   `method`, `status` and `assertionDigest` together or none; `matches` and each match's
 *   `values` are not empty.
 *
 * Consistency is not checked here (`verifyProof`, `sealProof` and `signProof` check it: orders,
 * citations, statuses, values against their declarations and contributions). The JSON schema
 * likewise checks the shape only.
 *
 * It agrees with `schema/decision-proof.schema.json` on JSON documents, plus checks JSON Schema
 * cannot express: no two entries of `rules` have the same qualified id and version, no text
 * holds a lone UTF-16 surrogate, and a time segment of a subject names two real days, the first
 * before the second.
 *
 * Lists at most 100 problems, in the order found, then one last issue `further problems not
 * listed (limit 100)`; a path or message longer than 1024 code units is cut there, then `…`
 * (`IssueList`, shared by every validator of the package).
 */
export function validateProof(value: unknown): {
  errors: string[];
  issues: RuleValidationIssue[];
} {
  const { issues } = withValueBudget(() => collect(value, DECISION_PROOF, new Set()));
  return { errors: issues.map((issue) => issue.message), issues };
}

/** Internal: a proof read by `readDecisionProof` or `readUnsignedProof`. */
export type ProofRead<T> = { proof: T; errors: [] } | { proof: undefined; errors: string[] };

/**
 * Internal: a validated, plain-JSON snapshot of a sealed proof, or the validation messages.
 *
 * `value` is read once, as `validateProof` reads it: each property is read exactly once and
 * counted once, and the snapshot is built from the very values checked. Callers check and use
 * ONLY the snapshot: an accessor or a Proxy cannot show one value to the digest check and
 * another to the signature check.
 */
export function readDecisionProof(value: unknown, forSigning = false): ProofRead<DecisionProof> {
  const reserve = forSigning ? signatureReserve : undefined;
  const { issues, snapshot } = withValueBudget(() =>
    collect(value, DECISION_PROOF, new Set(), reserve),
  );
  return conforms<DecisionProof>(snapshot, issues)
    ? { proof: snapshot, errors: [] }
    : { proof: undefined, errors: issues.map((issue) => issue.message) };
}

/**
 * Internal: like `readDecisionProof`, for the content a proof's leaves are made of
 * (`proofLeafHashes`): `digest` and `signature` are ignored and left out of the snapshot.
 */
export function readProofContent(value: unknown): ProofRead<UnsignedProof> {
  const { issues, snapshot } = withValueBudget(() => collect(value, UNSIGNED_PROOF, SEAL_KEYS));
  return conforms<UnsignedProof>(snapshot, issues)
    ? { proof: snapshot, errors: [] }
    : { proof: undefined, errors: issues.map((issue) => issue.message) };
}

/**
 * Internal: like `readDecisionProof`, for the content `sealProof` seals: entries without `salt`,
 * none redacted; `digest` and `signature` are ignored and left out of the snapshot, since
 * sealing replaces them. The `digest` that sealing adds is counted too (the salts are counted by
 * `sealProof`), so the sealed proof stays within the budget.
 */
export function readUnsaltedProof(value: unknown): ProofRead<UnsaltedProof> {
  const { issues, snapshot } = withValueBudget(() =>
    collect(value, UNSALTED_PROOF, SEAL_KEYS, digestReserve),
  );
  return conforms<UnsaltedProof>(snapshot, issues)
    ? { proof: snapshot, errors: [] }
    : { proof: undefined, errors: issues.map((issue) => issue.message) };
}

/**
 * A leaf of a proof as `proofLeafHash` reads it: the header (the proof without `digest`,
 * `signature` and the ten sections), or entry `i` of section `s`, salted or redacted.
 */
export type ProofLeaf =
  | { s: 'header'; e: ProofHeader }
  | { [S in ProofSection]: { s: S; i: number; e: UnsignedProof[S][number] } }[ProofSection];

/**
 * Internal: a validated, plain-JSON snapshot of a leaf (`ProofLeaf`), read once, or the
 * validation messages: `s` is `header` or a section of `PROOF_SECTIONS`; a header leaf has no
 * `i` and its `e` is a header as `validateProof` checks one (no section, `digest` nor
 * `signature`); an entry leaf has `i`, a safe integer from 0, and its `e` is an entry of its
 * section, salted or redacted.
 */
export function readProofLeaf(value: unknown): { leaf?: ProofLeaf; errors: string[] } {
  const issues = new IssueList();
  const add: Add = (path, message) => {
    issues.add(path, message);
  };
  let leaf: ProofLeaf | undefined;
  try {
    withValueBudget(() => {
      const read = checkObject(value, '', LEAF, add, new Set());
      if (read === undefined) return;
      const { s, i } = read.copy;
      const isSection = PROOF_SECTIONS.some((section) => section === s);
      if (s !== 'header' && !isSection) {
        add('s', `s must be header or a section: ${PROOF_SECTIONS.join(', ')}`);
        return;
      }
      if (s === 'header' && i !== undefined) add('i', 'i applies only to an entry of a section');
      if (s !== 'header' && i === undefined) add('i', 'i is required for an entry of a section');
      const entry = read.members.get('e');
      if (entry === undefined) return;
      const copy =
        s === 'header'
          ? checkObject(entry, 'e', PROOF_HEADER, add, new Set())?.copy
          : SECTION_ENTRY[s as ProofSection](entry, 'e', add);
      // Checked: a plain copy of a header or of an entry of `s`.
      leaf = { ...read.copy, e: copy } as ProofLeaf;
    });
  } catch (error) {
    return { errors: [unreadableMessage('leaf', error)] };
  }
  const errors = issues.toArray().map((issue) => issue.message);
  return errors.length === 0 && leaf !== undefined ? { leaf, errors } : { errors };
}

/** A leaf: its kind `s`, its index `i` in its section, its content `e` (read apart). */
const LEAF: Shape = {
  summary: '{ s, i?, e }',
  fields: {
    s: scalarCheck((value, path, add) => {
      if (typeof value !== 'string') add(path, `${citeName(path)} must be a string`);
    }),
    i: scalarCheck((value, path, add) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        add(path, `${citeName(path)} must be a non-negative integer`);
      }
    }),
    // Read here, checked as the header or an entry of `s` by `readProofLeaf`.
    e: () => undefined,
  },
  optional: ['i'],
};

/** The values sealing adds to a proof whose root members are `members`: its `digest`. */
function digestReserve(members: ReadonlyMap<string, unknown>): number {
  return members.has('digest') ? 0 : 1;
}

/**
 * The values signing adds to a proof whose root members are `members`: `signature` and its
 * three members, less those already counted (a valid `signature` has exactly three).
 */
function signatureReserve(members: ReadonlyMap<string, unknown>): number {
  if (!members.has('signature')) return 4;
  return members.get('signature') === undefined ? 3 : 0;
}

/** `issues` are those found while reading `snapshot` as a `T`: none means it is a `T`. */
function conforms<T>(snapshot: unknown, issues: readonly RuleValidationIssue[]): snapshot is T {
  return issues.length === 0;
}

/**
 * The problems of `value` against `shape`, and its copy (the snapshot when there are none).
 * `reserve` gives the values a seal will add to the copy, counted as soon as the root's members
 * are: whatever `sealProof` or `signProof` returns, the validators accept within the budget.
 */
function collect(
  value: unknown,
  shape: Shape,
  ignored: ReadonlySet<string>,
  reserve?: (members: ReadonlyMap<string, unknown>) => number,
): { issues: RuleValidationIssue[]; snapshot: unknown } {
  const issues = new IssueList();
  const add: Add = (path, message) => {
    issues.add(path, message);
  };
  try {
    if (!isPlainObject(value)) {
      add('', 'a decision proof must be a plain object');
      return { issues: issues.toArray(), snapshot: undefined };
    }
    const read = checkObject(value, '', shape, add, ignored, reserve);
    checkUniqueRules(read?.copy.rules, add);
    checkRepeatedLeaves(read?.copy, add);
    return { issues: issues.toArray(), snapshot: read?.copy };
  } catch (error) {
    // A hostile value (a throwing getter, a Proxy trap) never escapes as a raw error.
    return {
      issues: [{ path: '', message: unreadableMessage('proof', error) }],
      snapshot: undefined,
    };
  }
}

/**
 * Validator-only: two rule references with the same qualified id and version (D-37), read on
 * the copy.
 */
function checkUniqueRules(rules: unknown, add: Add): void {
  // The list itself was checked (and any problem of it reported) by the shape of `rules`.
  if (!Array.isArray(rules)) return;
  const seen = new Set<string>();
  rules.forEach((rule: unknown, i) => {
    if (
      !isPlainObject(rule) ||
      typeof rule.id !== 'string' ||
      rule.id === '' ||
      rule.id.includes(':') ||
      !isRuleSetId(rule.ruleSet) ||
      !isRuleVersion(rule.version)
    ) {
      return;
    }
    const key = `${qualifyName(rule.ruleSet, rule.id)}@${rule.version}`;
    if (seen.has(key)) add(`rules[${i}]`, `rules[${i}] repeats ${citeName(key)}`);
    seen.add(key);
  });
}

/**
 * Validator-only: a redacted leaf hash that two entries carry. Each leaf commits to its section
 * and its place (D-16): two entries never have the same leaf, so a proof that repeats one was
 * not made by redacting a sealed proof. Read on the copy, each hash kept once.
 */
function checkRepeatedLeaves(content: Record<string, unknown> | undefined, add: Add): void {
  if (content === undefined) return;
  const first = new Map<string, string>();
  for (const section of PROOF_SECTIONS) {
    const list = content[section];
    if (!Array.isArray(list)) continue;
    list.forEach((entry: unknown, i) => {
      if (!isPlainObject(entry) || typeof entry.redacted !== 'string') return;
      const at = `${section}[${i}]`;
      const seen = first.get(entry.redacted);
      if (seen === undefined) first.set(entry.redacted, at);
      else add(at, `${at} repeats the redacted leaf of ${seen}`);
    });
  }
}
