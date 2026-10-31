import { toJsonValue } from '../canonical.js';
import type { JsonValue } from '../canonical.js';
import {
  checkRounding,
  COMBINE_STRATEGIES,
  isRoundable,
  OUTPUT_TYPES,
  roundingNotApplicable,
} from '../decision/output.js';
import { describeError, SpecError, specErrorPath } from '../errors.js';
import { parseRuleDate } from '../rule/date.js';
import { isRuleVersion } from '../rule/definition.js';
import { KINDS } from '../rule/exceptions.js';
import type { RuleValidationIssue } from '../rule/validate.js';
import { isPlainObject } from '../values.js';
import { PROOF_FORMAT } from './types.js';
import type { DecisionProof, UnsignedProof } from './types.js';

type Add = (path: string, message: string) => void;
type Check = (value: unknown, path: string, add: Add) => void;

/** A closed object: its fields in reporting order, and which of them may be absent. */
interface Shape {
  /** How messages write the object: `{ id, version, checksum, sourceRef? }`. */
  readonly summary: string;
  readonly fields: Readonly<Record<string, Check>>;
  readonly optional?: readonly string[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** 64 bytes in base64url without padding: 86 characters, the last one with 4 zero low bits. */
const SIGNATURE_BASE64URL = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const DATE_FORMS = 'YYYY-MM-DD, or a date-time with Z or an offset';

const nonEmptyString: Check = (value, path, add) => {
  if (typeof value !== 'string' || value === '') add(path, `${path} must be a non-empty string`);
};

const anyString: Check = (value, path, add) => {
  if (typeof value !== 'string') add(path, `${path} must be a string`);
};

const version: Check = (value, path, add) => {
  if (!isRuleVersion(value)) add(path, `${path} must be a positive integer`);
};

/** A stratum index: a safe integer, 0 or more. Whether `strata` has it is checked later. */
const stratum: Check = (value, path, add) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    add(path, `${path} must be a non-negative integer`);
  }
};

const sha256: Check = (value, path, add) => {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    add(path, `${path} must be a lowercase sha256 hex string`);
  }
};

/** An ISO date string, in the grammar of rule dates. A `Date` object is refused: proofs are JSON. */
function isoDate(nullable: boolean): Check {
  return (value, path, add) => {
    if (nullable && value === null) return;
    if (typeof value === 'string') {
      try {
        parseRuleDate(value, path);
        return;
      } catch (error) {
        if (!(error instanceof SpecError)) throw error;
      }
    }
    add(path, `${path} must be ${nullable ? 'null or ' : ''}an ISO date: ${DATE_FORMS}`);
  };
}

function constant(expected: string): Check {
  return (value, path, add) => {
    if (value !== expected) add(path, `${path} must be "${expected}"`);
  };
}

function oneOf(allowed: readonly string[]): Check {
  return (value, path, add) => {
    if (!allowed.some((item) => item === value)) {
      add(path, `${path} must be one of ${allowed.join(', ')}`);
    }
  };
}

/** Any value with a canonical JSON form; a problem is reported at the path of the bad value. */
const json: Check = (value, path, add) => {
  try {
    toJsonValue(value, path);
  } catch (error) {
    add(specErrorPath(error) ?? path, describeError(error));
  }
};

function listOf(item: Check): Check {
  return (value, path, add) => {
    if (!Array.isArray(value)) {
      add(path, `${path} must be an array`);
      return;
    }
    Array.from(value as unknown[]).forEach((v, i) => item(v, `${path}[${i}]`, add));
  };
}

/** An object of named entries: names must be non-empty, an `undefined` entry is absent. */
function mapOf(item: Check, summary: string): Check {
  return (value, path, add) => {
    if (!isPlainObject(value)) {
      add(path, `${path} must be an object of ${summary}`);
      return;
    }
    for (const [name, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      if (name === '') add(path, `${path} has an empty name`);
      else item(entry, `${path}.${name}`, add);
    }
  };
}

function objectOf(shape: Shape): Check {
  return (value, path, add) => {
    checkObject(value, path, shape, add, new Set());
  };
}

/**
 * Checks a closed object. Unknown keys are reported first, then each field in order. An
 * `undefined` member counts as absent, as in the canonical form; keys in `ignored` are skipped.
 * Each own property is read once, so an accessor cannot answer two checks differently. Returns
 * the members read, or `undefined` when `value` is not an object.
 */
function checkObject(
  value: unknown,
  path: string,
  shape: Shape,
  add: Add,
  ignored: ReadonlySet<string>,
): ReadonlyMap<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    add(path, `${path} must be an object ${shape.summary}`);
    return undefined;
  }
  const members = new Map<string, unknown>(Object.entries(value));
  const at = (key: string): string => (path ? `${path}.${key}` : key);
  for (const [key, member] of members) {
    if (member === undefined || ignored.has(key) || Object.hasOwn(shape.fields, key)) continue;
    add(at(key), `${path || 'proof'} has an unknown key "${key}"`);
  }
  for (const [key, check] of Object.entries(shape.fields)) {
    const field = members.get(key);
    if (field !== undefined) check(field, at(key), add);
    else if (!shape.optional?.includes(key)) add(at(key), `${at(key)} is required`);
  }
  return members;
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
 * An output. Its `rounding` is checked as in an output declaration: on a known type that
 * cannot be rounded, only that is reported; otherwise its shape is checked.
 */
const output: Check = (value, path, add) => {
  const members = checkObject(value, path, OUTPUT, add, new Set());
  const rounding = members?.get('rounding');
  if (rounding === undefined) return;
  const type = members?.get('type');
  if (OUTPUT_TYPES.some((t) => t === type) && !isRoundable(type)) {
    roundingNotApplicable(`${path}.rounding`, add);
  } else checkRounding(rounding, `${path}.rounding`, add);
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
    value: (value, path, add) => {
      if (typeof value !== 'string' || !SIGNATURE_BASE64URL.test(value)) {
        add(path, `${path} must be an ed25519 signature in unpadded base64url (86 characters)`);
      }
    },
  },
};

const CONTENT_FIELDS: Readonly<Record<string, Check>> = {
  format: constant(PROOF_FORMAT),
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

const UNSIGNED_PROOF: Shape = { summary: '', fields: CONTENT_FIELDS, optional: ['ruleSet'] };

const DECISION_PROOF: Shape = {
  summary: '',
  fields: { ...CONTENT_FIELDS, digest: sha256, signature: objectOf(SIGNATURE) },
  optional: ['ruleSet', 'signature'],
};

const SEAL_KEYS: ReadonlySet<string> = new Set(['digest', 'signature']);

/**
 * Checks a decision proof without throwing and reports every problem found, each with its path
 * (`rules[1].checksum`, `outputs.tax.type`; `''` when the value itself is not an object), like
 * `validateRuleDefinition`. `errors` holds the same messages, in the same order.
 *
 * It checks the shape only, never the digest or the signature (`verifyProof` does):
 * - the format is closed: every object refuses unknown keys, and an `undefined` member counts
 *   as absent, as in the canonical form;
 * - `format` is `PROOF_FORMAT`; `evaluatedAt` (or `null`) and `sealedAt` are ISO date strings
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
 */
export function validateProof(value: unknown): {
  errors: string[];
  issues: RuleValidationIssue[];
} {
  const issues = collect(value, DECISION_PROOF, new Set());
  return { errors: issues.map((issue) => issue.message), issues };
}

/** Internal: a proof read by `readDecisionProof` or `readUnsignedProof`. */
export type ProofRead<T> = { proof: T; errors: [] } | { proof: undefined; errors: string[] };

/**
 * Internal: a validated, plain-JSON snapshot of a sealed proof, or the validation messages.
 *
 * `value` is validated, then copied to JSON reading each property exactly once, and the copy is
 * validated again. Callers check and use ONLY the snapshot: an accessor or a Proxy cannot show
 * one value to the digest check and another to the signature check.
 */
export function readDecisionProof(value: unknown): ProofRead<DecisionProof> {
  const { snapshot, errors } = readSnapshot(value, DECISION_PROOF, new Set());
  return conforms<DecisionProof>(snapshot, errors)
    ? { proof: snapshot, errors: [] }
    : { proof: undefined, errors };
}

/**
 * Internal: like `readDecisionProof`, for the content `sealProof` hashes: `digest` and
 * `signature` are ignored and left out of the snapshot, since sealing replaces them.
 */
export function readUnsignedProof(value: unknown): ProofRead<UnsignedProof> {
  const { snapshot, errors } = readSnapshot(value, UNSIGNED_PROOF, SEAL_KEYS);
  return conforms<UnsignedProof>(snapshot, errors)
    ? { proof: snapshot, errors: [] }
    : { proof: undefined, errors };
}

/** `errors` are those found in `snapshot` against the shape of `T`: none means it is a `T`. */
function conforms<T>(snapshot: unknown, errors: readonly string[]): snapshot is T {
  return errors.length === 0;
}

/** The JSON snapshot of `value` and the problems of `value` or of the snapshot. */
function readSnapshot(
  value: unknown,
  shape: Shape,
  ignored: ReadonlySet<string>,
): { snapshot: unknown; errors: string[] } {
  const messages = (issues: RuleValidationIssue[]): string[] => issues.map((i) => i.message);
  const first = collect(value, shape, ignored);
  if (first.length > 0) return { snapshot: undefined, errors: messages(first) };

  let snapshot: JsonValue;
  try {
    snapshot = toJsonValue(value, '');
  } catch (error) {
    return { snapshot: undefined, errors: [describeError(error)] };
  }
  if (isPlainObject(snapshot)) for (const key of ignored) delete snapshot[key];
  return { snapshot, errors: messages(collect(snapshot, shape, ignored)) };
}

function collect(
  value: unknown,
  shape: Shape,
  ignored: ReadonlySet<string>,
): RuleValidationIssue[] {
  const issues: RuleValidationIssue[] = [];
  const add: Add = (path, message) => {
    issues.push({ path, message });
  };
  if (!isPlainObject(value)) {
    add('', 'a decision proof must be a plain object');
    return issues;
  }
  const members = checkObject(value, '', shape, add, ignored);
  checkUniqueRules(members?.get('rules'), add);
  return issues;
}

/** Validator-only: two rule references with the same id and version. */
function checkUniqueRules(rules: unknown, add: Add): void {
  if (!Array.isArray(rules)) return;
  const seen = new Set<string>();
  Array.from(rules as unknown[]).forEach((rule, i) => {
    if (!isPlainObject(rule) || typeof rule.id !== 'string' || !isRuleVersion(rule.version)) {
      return;
    }
    const key = `${rule.id}@${rule.version}`;
    if (seen.has(key)) add(`rules[${i}]`, `rules[${i}] repeats ${key}`);
    seen.add(key);
  });
}
