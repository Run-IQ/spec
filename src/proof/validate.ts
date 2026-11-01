import { toJsonValue } from '../canonical.js';
import { COMBINE_STRATEGIES, OUTPUT_TYPES } from '../decision/output.js';
import { combinationProblem } from '../decision/read-declaration.js';
import {
  checkNormalRounding,
  checkRounding,
  isRoundable,
  roundingNotApplicable,
} from '../decision/rounding.js';
import {
  citeName,
  describeError,
  isOwnError,
  quoteText,
  specErrorPath,
  unreadableMessage,
} from '../errors.js';
import { parseRuleDate } from '../rule/date.js';
import { isRuleVersion } from '../rule/definition.js';
import { KINDS } from '../rule/exceptions.js';
import { IssueList } from '../issues.js';
import type { RuleValidationIssue } from '../issues.js';
import {
  isPlainObject,
  readList,
  spendValues,
  tooLargeMessage,
  withValueBudget,
} from '../values.js';
import { isProofFormat, PROOF_FORMATS } from './formats.js';
import type { DecisionProof, UnsignedProof } from './types.js';

type Add = (path: string, message: string) => void;
/**
 * Checks `value` at `path`, reporting each problem through `add`, and returns its copy: the
 * value itself for a scalar, a plain copy of what was read for a list or an object. The copy is
 * the proof's snapshot only when nothing was reported.
 */
type Check = (value: unknown, path: string, add: Add) => unknown;

/** A closed object: its fields in reporting order, and which of them may be absent. */
interface Shape {
  /** How messages write the object: `{ id, version, checksum, sourceRef? }`. */
  readonly summary: string;
  readonly fields: Readonly<Record<string, Check>>;
  readonly optional?: readonly string[];
  /**
   * Checked before anything else, on the members read: when it reports a problem, that problem
   * is the only one (an unknown format makes the rest of the object unreadable).
   */
  readonly gate?: (members: ReadonlyMap<string, unknown>) => RuleValidationIssue | undefined;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** 64 bytes in base64url without padding: 86 characters, the last one with 4 zero low bits. */
const SIGNATURE_BASE64URL = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const DATE_FORMS = 'YYYY-MM-DD, or a date-time with Z or an offset';

/** A check of a scalar: `test` reports its problem; the copy is the value itself. */
function scalarCheck(test: (value: unknown, path: string, add: Add) => void): Check {
  return (value, path, add) => {
    test(value, path, add);
    return value;
  };
}

const nonEmptyString = scalarCheck((value, path, add) => {
  if (typeof value !== 'string' || value === '') {
    add(path, `${citeName(path)} must be a non-empty string`);
  }
});

const anyString = scalarCheck((value, path, add) => {
  if (typeof value !== 'string') add(path, `${citeName(path)} must be a string`);
});

const version = scalarCheck((value, path, add) => {
  if (!isRuleVersion(value)) add(path, `${citeName(path)} must be a positive integer`);
});

/** A stratum index: a safe integer, 0 or more. Whether `strata` has it is checked later. */
const stratum = scalarCheck((value, path, add) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    add(path, `${citeName(path)} must be a non-negative integer`);
  }
});

const sha256 = scalarCheck((value, path, add) => {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    add(path, `${citeName(path)} must be a lowercase sha256 hex string`);
  }
});

/**
 * An ISO date string, in the grammar of rule dates. A `Date` object is refused: proofs are JSON.
 */
function isoDate(nullable: boolean): Check {
  return scalarCheck((value, path, add) => {
    if (nullable && value === null) return;
    if (typeof value === 'string') {
      try {
        parseRuleDate(value, path);
        return;
      } catch (error) {
        if (!isOwnError(error)) throw error;
      }
    }
    add(path, `${citeName(path)} must be ${nullable ? 'null or ' : ''}an ISO date: ${DATE_FORMS}`);
  });
}

/** A format listed in `PROOF_FORMATS`; an unknown one is reported by `formatGate`. */
const proofFormat = scalarCheck((value, path, add) => {
  if (!isProofFormat(value)) {
    add(path, `${citeName(path)} must be one of ${PROOF_FORMATS.join(', ')}`);
  }
});

/**
 * A proof in a format this package does not know (a later `run-iq.proof/2`) is refused with that
 * single issue: its other fields follow rules this version cannot check.
 */
function formatGate(members: ReadonlyMap<string, unknown>): RuleValidationIssue | undefined {
  const format = members.get('format');
  if (typeof format !== 'string' || isProofFormat(format)) return undefined;
  return { path: 'format', message: `unknown format: ${citeName(format)}` };
}

function constant(expected: string): Check {
  return scalarCheck((value, path, add) => {
    if (value !== expected) add(path, `${citeName(path)} must be "${expected}"`);
  });
}

function oneOf(allowed: readonly string[]): Check {
  return scalarCheck((value, path, add) => {
    if (!allowed.some((item) => item === value)) {
      add(path, `${citeName(path)} must be one of ${allowed.join(', ')}`);
    }
  });
}

/**
 * A free-form value: JSON, at most `MAX_JSON_DEPTH` levels deep, without `undefined`; a
 * problem is reported at the path of the bad value. A value that cannot be read (a getter, a
 * Proxy trap) is reported at `path` with `unreadableMessage`.
 */
const json: Check = (value, path, add) => {
  try {
    return toJsonValue(value, path);
  } catch (error) {
    if (isOwnError(error)) add(specErrorPath(error) ?? path, describeError(error));
    else add(path, unreadableMessage(path, error));
    return undefined;
  }
};

function listOf(item: Check): Check {
  return (value, path, add) => {
    if (!Array.isArray(value)) {
      add(path, `${citeName(path)} must be an array`);
      return undefined;
    }
    const items = readList(value, path);
    if (!Array.isArray(items)) {
      add(items.path, items.message);
      return undefined;
    }
    return items.map((v, i) => item(v, `${path}[${i}]`, add));
  };
}

/**
 * The own members of the plain object `value`, each read once after all are counted
 * (`spendValues`); `undefined` after reporting that there are too many to read.
 */
function readMembers(
  value: Record<string, unknown>,
  path: string,
  add: Add,
): Map<string, unknown> | undefined {
  const keys = Object.keys(value);
  if (!spendValues(keys.length)) {
    add(path, tooLargeMessage(path || 'proof'));
    return undefined;
  }
  return new Map(keys.map((key) => [key, value[key]]));
}

/** An object of named entries: names must be non-empty, an `undefined` entry is absent. */
function mapOf(item: Check, summary: string): Check {
  return (value, path, add) => {
    if (!isPlainObject(value)) {
      add(path, `${citeName(path)} must be an object of ${summary}`);
      return undefined;
    }
    const members = readMembers(value, path, add);
    if (members === undefined) return undefined;
    const copy: Record<string, unknown> = {};
    for (const [name, entry] of members) {
      if (entry === undefined) continue;
      if (name === '') add(path, `${citeName(path)} has an empty name`);
      // Plain assignment would turn a `__proto__` key into a prototype change.
      else defineMember(copy, name, item(entry, `${path}.${name}`, add));
    }
    return copy;
  };
}

function defineMember(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function objectOf(shape: Shape): Check {
  return (value, path, add) => checkObject(value, path, shape, add, new Set())?.copy;
}

/**
 * Checks a closed object. A member whose value is `undefined` is absent, known or not (the
 * TypeScript idiom of an optional field, as in the canonical form). Unknown keys are reported
 * first, then each field in order; keys in `ignored` are skipped.
 * Each own property is read once, after all are counted (`spendValues`), so an accessor cannot
 * answer two checks differently. Returns the copies of the fields checked (known, not
 * `undefined`; `ignored` keys are left out) and their checks' copies, or `undefined` when
 * `value` is not an object, has too many members, or the shape's gate stopped.
 */
function checkObject(
  value: unknown,
  path: string,
  shape: Shape,
  add: Add,
  ignored: ReadonlySet<string>,
  reserve?: (members: ReadonlyMap<string, unknown>) => number,
): { members: ReadonlyMap<string, unknown>; copy: Record<string, unknown> } | undefined {
  if (!isPlainObject(value)) {
    add(path, `${citeName(path)} must be an object ${shape.summary}`);
    return undefined;
  }
  const members = readMembers(value, path, add);
  if (members === undefined) return undefined;
  if (reserve !== undefined && !spendValues(reserve(members))) {
    add(path, tooLargeMessage(path || 'proof'));
    return undefined;
  }
  const stop = shape.gate?.(members);
  if (stop) {
    add(stop.path, stop.message);
    return undefined;
  }
  const at = (key: string): string => (path ? `${path}.${key}` : key);
  for (const [key, member] of members) {
    // A member whose value is `undefined` is absent, known or not.
    if (member === undefined || ignored.has(key) || Object.hasOwn(shape.fields, key)) continue;
    add(at(key), `${citeName(path || 'proof')} has an unknown key ${quoteText(key)}`);
  }
  const copy: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(shape.fields)) {
    const field = members.get(key);
    if (field !== undefined) copy[key] = check(field, at(key), add);
    else if (!shape.optional?.includes(key)) add(at(key), `${citeName(at(key))} is required`);
  }
  return { members, copy };
}

const RULE_REF: Shape = {
  summary: '{ id, version, checksum, sourceRef? }',
  fields: { id: nonEmptyString, version, checksum: sha256, sourceRef: nonEmptyString },
  optional: ['sourceRef'],
};

const RULE_SET: Shape = {
  summary: '{ kind, id, version, digest }',
  fields: { kind: constant('pack'), id: nonEmptyString, version: nonEmptyString, digest: sha256 },
};

const VERSIONS: Shape = {
  summary: '{ engine, plugins, dsls }',
  fields: {
    engine: nonEmptyString,
    plugins: mapOf(nonEmptyString, 'non-empty strings'),
    dsls: mapOf(nonEmptyString, 'non-empty strings'),
  },
};

const OUTPUT: Shape = {
  summary: '{ type, combine, value, contributors, rounding? }',
  fields: {
    type: oneOf(OUTPUT_TYPES),
    combine: oneOf(COMBINE_STRATEGIES),
    value: json,
    contributors: listOf(nonEmptyString),
    // Checked by `output`, which also knows the type.
    rounding: () => undefined,
  },
  optional: ['rounding'],
};

/**
 * An output. Its `combine` must apply to its `type`, as in an output declaration. Its
 * `rounding` is checked as in an output declaration (on a known type that cannot be rounded, or
 * on a `count`, only that is reported; otherwise its shape), and must be written in its normal
 * form (`normalizeOutputDeclaration`): no `at: 'output'`, no increment that is a scale.
 */
const output: Check = (value, path, add) => {
  const read = checkObject(value, path, OUTPUT, add, new Set());
  if (read === undefined) return undefined;
  const type = read.members.get('type');
  const combine = read.members.get('combine');
  const knownType = OUTPUT_TYPES.find((t) => t === type);
  const knownCombine = COMBINE_STRATEGIES.find((c) => c === combine);
  if (knownType !== undefined && knownCombine !== undefined) {
    const problem = combinationProblem(knownType, knownCombine);
    if (problem !== undefined) add(`${path}.combine`, `${citeName(path)}.combine ${problem}`);
  }
  const rounding = read.members.get('rounding');
  if (rounding === undefined) return read.copy;
  const at = `${path}.rounding`;
  if (knownType !== undefined && !isRoundable(knownType)) {
    roundingNotApplicable(at, add);
  } else if (knownCombine === 'count') {
    add(at, `${citeName(at)} does not apply to a count: its value is an integer`);
  } else {
    const checked = checkRounding(rounding, at, add);
    if (checked !== undefined) checkNormalRounding(checked, at, add);
    read.copy.rounding = checked?.copy;
  }
  return read.copy;
};

const STEP: Shape = {
  summary: '{ ruleId, version, model, output, contribution, stratum, unrounded?, sourceRef? }',
  fields: {
    ruleId: nonEmptyString,
    version,
    model: nonEmptyString,
    output: nonEmptyString,
    contribution: json,
    stratum,
    unrounded: json,
    sourceRef: nonEmptyString,
  },
  optional: ['unrounded', 'sourceRef'],
};

const SKIP: Shape = {
  summary: '{ ruleId, version, reason, detail?, stratum }',
  fields: { ruleId: nonEmptyString, version, reason: nonEmptyString, detail: anyString, stratum },
  optional: ['detail'],
};

const EXCEPTION: Shape = {
  summary: '{ ruleId, version, kind, affected, stratum }',
  fields: {
    ruleId: nonEmptyString,
    version,
    kind: oneOf(KINDS),
    affected: listOf(nonEmptyString),
    stratum,
  },
};

const SIGNATURE: Shape = {
  summary: '{ alg, keyId, value }',
  fields: {
    alg: constant('ed25519'),
    keyId: nonEmptyString,
    value: scalarCheck((value, path, add) => {
      if (typeof value !== 'string' || !SIGNATURE_BASE64URL.test(value)) {
        add(
          path,
          `${citeName(path)} must be an ed25519 signature in unpadded base64url (86 characters)`,
        );
      }
    }),
  },
};

const CONTENT_FIELDS: Readonly<Record<string, Check>> = {
  format: proofFormat,
  requestId: nonEmptyString,
  evaluatedAt: isoDate(true),
  sealedAt: isoDate(false),
  inputDigest: sha256,
  rules: listOf(objectOf(RULE_REF)),
  ruleSet: objectOf(RULE_SET),
  versions: objectOf(VERSIONS),
  strata: listOf(listOf(nonEmptyString)),
  outputs: mapOf(output, 'outputs'),
  applied: listOf(objectOf(STEP)),
  skipped: listOf(objectOf(SKIP)),
  exceptions: listOf(objectOf(EXCEPTION)),
};

const UNSIGNED_PROOF: Shape = {
  summary: '',
  fields: CONTENT_FIELDS,
  optional: ['ruleSet'],
  gate: formatGate,
};

const DECISION_PROOF: Shape = {
  summary: '',
  fields: { ...CONTENT_FIELDS, digest: sha256, signature: objectOf(SIGNATURE) },
  optional: ['ruleSet', 'signature'],
  gate: formatGate,
};

const SEAL_KEYS: ReadonlySet<string> = new Set(['digest', 'signature']);

/**
 * Checks a decision proof without throwing and reports every problem found, each with its path
 * (`rules[1].checksum`, `outputs.tax.type`; `''` when the value itself is not an object), like
 * `validateRuleDefinition`. `errors` holds the same messages, in the same order.
 *
 * It checks the shape only, never the digest or the signature (`verifyProof` does):
 * - the format is closed: every object refuses unknown keys; a member whose value is
 *   `undefined` is absent, known or not (the TypeScript idiom of an optional field), as in the
 *   canonical form, while an `undefined` inside a free-form value (an output value, a
 *   contribution, `unrounded`) or as a list item is refused: `<path> is not JSON: undefined`;
 * - a value that cannot be read (a getter or a Proxy trap that throws) gives the single issue
 *   `proof could not be read: <reason>` at path `''`; an output value, contribution or
 *   `unrounded` value that cannot be read is reported at its path, and one nested more than
 *   `MAX_JSON_DEPTH` (1000) levels deep gives `<path> is nested deeper than 1000 levels`, at
 *   its first container past the limit; each value is counted once, and past `MAX_JSON_VALUES`
 *   values in all, `<path> is too large: more than 10000000 values`;
 * - `format` is one of `PROOF_FORMATS`; a string that is not gives the single issue
 *   `unknown format: <format>` at path `format` (the rest follows rules of another format);
 *   `evaluatedAt` (or `null`) and `sealedAt` are ISO date strings
 *   in the grammar of rule dates; `inputDigest`, `digest`, rule checksums and `ruleSet.digest`
 *   are lowercase sha256 hex; `signature.value` is 64 bytes in unpadded base64url;
 * - output values, contributions and `unrounded` values are JSON;
 * - `strata` is a list of lists of non-empty output names; every `stratum` of `applied`,
 *   `skipped` and `exceptions` is a safe integer, 0 or more;
 * - an output's `rounding` is checked as in an output declaration (`validateOutputDeclaration`),
 *   on a `number` or `decimal` output only.
 *
 * Consistency is not checked here: whether every cited rule is listed, whether `strata` covers
 * `outputs` and holds each `stratum`, whether an output name starts with the reserved `$`,
 * and whether decimal values are canonical are checked by `verifyProof`, `sealProof` and
 * `signProof` only. The JSON schema likewise checks the shape only.
 *
 * It agrees with `schema/decision-proof.schema.json` on JSON documents, plus one check JSON
 * Schema cannot express: no two entries of `rules` have the same id and version.
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
 * Internal: like `readDecisionProof`, for the content `sealProof` hashes: `digest` and
 * `signature` are ignored and left out of the snapshot, since sealing replaces them. The
 * `digest` that sealing adds is counted too, so the sealed proof stays within the budget.
 */
export function readUnsignedProof(value: unknown): ProofRead<UnsignedProof> {
  const { issues, snapshot } = withValueBudget(() =>
    collect(value, UNSIGNED_PROOF, SEAL_KEYS, digestReserve),
  );
  return conforms<UnsignedProof>(snapshot, issues)
    ? { proof: snapshot, errors: [] }
    : { proof: undefined, errors: issues.map((issue) => issue.message) };
}

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
    return { issues: issues.toArray(), snapshot: read?.copy };
  } catch (error) {
    // A hostile value (a throwing getter, a Proxy trap) never escapes as a raw error.
    return {
      issues: [{ path: '', message: unreadableMessage('proof', error) }],
      snapshot: undefined,
    };
  }
}

/** Validator-only: two rule references with the same id and version, read on the copy. */
function checkUniqueRules(rules: unknown, add: Add): void {
  // The list itself was checked (and any problem of it reported) by the shape of `rules`.
  if (!Array.isArray(rules)) return;
  const seen = new Set<string>();
  rules.forEach((rule: unknown, i) => {
    if (!isPlainObject(rule) || typeof rule.id !== 'string' || !isRuleVersion(rule.version)) {
      return;
    }
    const key = `${rule.id}@${rule.version}`;
    if (seen.has(key)) add(`rules[${i}]`, `rules[${i}] repeats ${citeName(key)}`);
    seen.add(key);
  });
}
