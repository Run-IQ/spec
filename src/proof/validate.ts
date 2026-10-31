import { toJsonValue } from '../canonical.js';
import { COMBINE_STRATEGIES, OUTPUT_TYPES } from '../decision/output.js';
import { SpecError } from '../errors.js';
import { parseRuleDate } from '../rule/date.js';
import { isRuleVersion } from '../rule/definition.js';
import { KINDS } from '../rule/exceptions.js';
import type { RuleValidationIssue } from '../rule/validate.js';
import { isPlainObject } from '../values.js';
import { PROOF_FORMAT } from './types.js';

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
    if (!(error instanceof Error)) throw error;
    add(error instanceof SpecError && error.path ? error.path : path, error.message);
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
  return (value, path, add) => checkObject(value, path, shape, add, new Set());
}

/**
 * Checks a closed object. Unknown keys are reported first, then each field in order. An
 * `undefined` member counts as absent, as in the canonical form; keys in `ignored` are skipped.
 */
function checkObject(
  value: unknown,
  path: string,
  shape: Shape,
  add: Add,
  ignored: ReadonlySet<string>,
): void {
  if (!isPlainObject(value)) {
    add(path, `${path} must be an object ${shape.summary}`);
    return;
  }
  const at = (key: string): string => (path ? `${path}.${key}` : key);
  for (const key of Object.keys(value)) {
    if (value[key] === undefined || ignored.has(key) || Object.hasOwn(shape.fields, key)) continue;
    add(at(key), `${path || 'proof'} has an unknown key "${key}"`);
  }
  for (const [key, check] of Object.entries(shape.fields)) {
    const field = value[key];
    if (field !== undefined) check(field, at(key), add);
    else if (!shape.optional?.includes(key)) add(at(key), `${at(key)} is required`);
  }
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
  summary: '{ type, combine, value, contributors }',
  fields: {
    type: oneOf(OUTPUT_TYPES),
    combine: oneOf(COMBINE_STRATEGIES),
    value: json,
    contributors: listOf(nonEmptyString),
  },
};

const STEP: Shape = {
  summary: '{ ruleId, version, model, output, contribution, sourceRef? }',
  fields: {
    ruleId: nonEmptyString,
    version,
    model: nonEmptyString,
    output: nonEmptyString,
    contribution: json,
    sourceRef: nonEmptyString,
  },
  optional: ['sourceRef'],
};

const SKIP: Shape = {
  summary: '{ ruleId, version, reason, detail? }',
  fields: { ruleId: nonEmptyString, version, reason: nonEmptyString, detail: anyString },
  optional: ['detail'],
};

const EXCEPTION: Shape = {
  summary: '{ ruleId, version, kind, affected }',
  fields: { ruleId: nonEmptyString, version, kind: oneOf(KINDS), affected: listOf(nonEmptyString) },
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
  outputs: mapOf(objectOf(OUTPUT), 'outputs'),
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
 * - output values and contributions are JSON.
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

/**
 * Internal: the problems of the content `sealProof` hashes. `digest` and `signature` are
 * ignored, since sealing replaces them.
 */
export function unsignedProofIssues(value: unknown): RuleValidationIssue[] {
  return collect(value, UNSIGNED_PROOF, SEAL_KEYS);
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
  checkObject(value, '', shape, add, ignored);
  checkUniqueRules(value.rules, add);
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
