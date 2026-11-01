import { readDeclaration } from '../decision/read-declaration.js';
import { OUTPUT_STATUSES } from '../decision/status.js';
import { citeName, isOwnError, quoteText } from '../errors.js';
import { ASSERTION_METHODS, ASSERTION_STATUSES } from '../input/types.js';
import type { RuleValidationIssue } from '../issues.js';
import { contextToInputPointer, parseReadPointer } from '../path/pointer.js';
import { isSubject } from '../path/subject.js';
import { isRuleVersion } from '../rule/definition.js';
import { dimensionValueProblem, reservedDimensionNameMessage } from '../rule/dimensions.js';
import { KINDS } from '../rule/exceptions.js';
import { citedNameProblem, isRuleSetId, packIdProblem, ruleSetIdMessage } from '../rule/ruleSet.js';
import { isCivilDate, isInstant, isTimeZone, normalizeTimeZone } from '../time/civil.js';
import { hasLoneSurrogate, isPlainObject, loneSurrogateMessage, ownCopy } from '../values.js';
import {
  boolean,
  checkObject,
  constant,
  document,
  json,
  listOf,
  mapOf,
  nonEmptyString,
  objectOf,
  oneOf,
  scalarCheck,
  sha256,
  stringCheck,
} from './checks.js';
import type { Add, Check, Shape } from './checks.js';
import { isProofFormat, PROOF_FORMATS } from './formats.js';

// Internal to `@run-iq/spec`: the shape of a decision proof, as `validateProof` checks it and
// `schema/decision-proof.schema.json` describes it.

/** 64 bytes in base64url without padding: 86 characters, the last one with 4 zero low bits. */
const SIGNATURE_BASE64URL = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const SALT = /^[0-9a-f]{32}$/;
const CODE = /^[a-z0-9][a-z0-9_-]*$/;
const DECLARED_BY = /^(?:engine|(?:plugin|model):[\s\S]+)$/;
/** The exclusions grouped into one entry when two instances or more of a rule have them. */
export const GROUPED_REASONS: readonly string[] = [
  'INACTIVE_DATE',
  'DIMENSION_MISMATCH',
  'TAG_MISMATCH',
  'NOT_REQUESTED',
];
const SETTLED: readonly string[] = OUTPUT_STATUSES.filter((status) => status !== 'undetermined');
const SUBJECT_FORM =
  'a JSON pointer whose ! segments are !group=<value> or !segment=<from>..<until>';

const version = scalarCheck((value, path, add) => {
  if (!isRuleVersion(value)) add(path, `${citeName(path)} must be a positive integer`);
});

/** A stratum index: a safe integer, 0 or more. Whether `strata` has it is checked later. */
const stratum = scalarCheck((value, path, add) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    add(path, `${citeName(path)} must be a non-negative integer`);
  }
});

const salt = scalarCheck((value, path, add) => {
  if (typeof value !== 'string' || !SALT.test(value)) {
    add(path, `${citeName(path)} must be 16 bytes in lowercase hex (32 characters)`);
  }
});

const code = stringCheck('a non-empty string', (text, path) =>
  CODE.test(text) ? undefined : `${citeName(path)} must be a code matching ${CODE.source}`,
);

/** A rule id inside its rule set: bare. */
const ruleId = stringCheck('a non-empty string', (text, path) =>
  text.includes(':')
    ? `${citeName(path)} must not contain ":": a rule id is qualified by its rule set`
    : undefined,
);

/** A rule cited by its qualified id (D-37). */
const citedRule = stringCheck('a non-empty string', (text, path) =>
  citedNameProblem(text, path, 'rule'),
);

/** An output cited by its qualified name. */
const outputName = stringCheck('a non-empty string', (text, path) =>
  citedNameProblem(text, path, 'output'),
);

const ruleSetId = scalarCheck((value, path, add) => {
  if (!isRuleSetId(value)) add(path, ruleSetIdMessage(path, value));
});

const packId = scalarCheck((value, path, add) => {
  const problem = packIdProblem(value);
  if (problem !== undefined) add(path, `${citeName(path)}: ${problem}`);
});

const timeZone = scalarCheck((value, path, add) => {
  if (typeof value !== 'string' || !isTimeZone(value)) {
    add(path, `${citeName(path)} must be UTC, ±HH:MM or an IANA name Area/Location`);
  } else if (normalizeTimeZone(value) !== value) {
    add(path, `${citeName(path)} must be written UTC: +00:00 and -00:00 are UTC`);
  }
});

const evaluatedAt = scalarCheck((value, path, add) => {
  if (value !== null && !isCivilDate(value) && !isInstant(value)) {
    add(
      path,
      `${citeName(path)} must be null, a civil date YYYY-MM-DD or an instant ` +
        'YYYY-MM-DDTHH:MM:SS.sssZ',
    );
  }
});

const instant = scalarCheck((value, path, add) => {
  if (!isInstant(value)) add(path, `${citeName(path)} must be an instant YYYY-MM-DDTHH:MM:SS.sssZ`);
});

const subject = scalarCheck((value, path, add) => {
  if (!isSubject(value)) add(path, `${citeName(path)} must be a subject: ${SUBJECT_FORM}`);
  else if (hasLoneSurrogate(value)) add(path, loneSurrogateMessage(path));
});

/** A pointer of the evaluation context, as a rule reads it (`/$outputs/x` included). */
const contextPointer = scalarCheck((value, path, add) => {
  const what = `${citeName(path)} must be a JSON pointer of the evaluation context`;
  if (typeof value !== 'string') return add(path, what);
  try {
    parseReadPointer(value);
  } catch (error) {
    return add(path, `${what}: ${isOwnError(error) ? error.message : 'unreadable'}`);
  }
  if (hasLoneSurrogate(value)) add(path, loneSurrogateMessage(path));
});

/** A pointer of the evaluation context to a fact of the input (`contextToInputPointer`). */
const factPointer = scalarCheck((value, path, add) => {
  const what = `${citeName(path)} must be a pointer to an input fact`;
  if (typeof value !== 'string') return add(path, what);
  let input: string | undefined;
  try {
    input = contextToInputPointer(value);
  } catch (error) {
    return add(path, `${what}: ${isOwnError(error) ? error.message : 'unreadable'}`);
  }
  if (input === undefined) add(path, `${what}: ${quoteText(value)} is not in the input`);
  else if (hasLoneSurrogate(value)) add(path, loneSurrogateMessage(path));
});

/** The status of a rule's decision (`what`: step, exclusion, exception): never undetermined. */
function settledStatus(what: string): Check {
  const known = oneOf(SETTLED);
  return (value, path, add) => {
    if (value === 'undetermined')
      add(path, `${citeName(path)}: ${what} status cannot be undetermined`);
    else known(value, path, add);
    return value;
  };
}

const status = oneOf(OUTPUT_STATUSES);

const dimensionValue = scalarCheck((value, path, add) => {
  const problem = dimensionValueProblem(value, path);
  if (problem !== undefined) add(path, problem);
});

const RULE_REF: Shape = {
  summary: '{ id, version, checksum, ruleSet, sourceRef?, salt }',
  fields: {
    id: ruleId,
    version,
    checksum: sha256,
    ruleSet: ruleSetId,
    sourceRef: nonEmptyString,
    salt,
  },
  optional: ['sourceRef'],
};

const PACK: Shape = {
  summary: '{ kind, id, version, digest, imports?, timeZone? }',
  fields: {
    kind: constant('pack'),
    id: packId,
    version: nonEmptyString,
    digest: sha256,
    imports: listOf(packId, 'absent imports nothing'),
    timeZone,
  },
  optional: ['imports', 'timeZone'],
};

const LOCAL: Shape = {
  summary: '{ kind, timeZone? }',
  fields: { kind: constant('local'), timeZone },
  optional: ['timeZone'],
};

const REFERENTIAL: Shape = {
  summary: '{ kind, id, version, digest }',
  fields: {
    kind: constant('referential'),
    id: nonEmptyString,
    version: nonEmptyString,
    digest: sha256,
  },
};

const RULE_SET_KINDS: Readonly<Record<string, Shape>> = {
  pack: PACK,
  local: LOCAL,
  referential: REFERENTIAL,
};

/** A rule set: the shape its `kind` names; a missing or unknown kind is the only problem. */
const RULE_SET: Shape = {
  summary: '{ kind, … }',
  fields: {},
  gate: (members, path): RuleValidationIssue | Shape => {
    const kind = members.get('kind');
    const at = `${path}.kind`;
    if (kind === undefined) return { path: at, message: `${citeName(at)} is required` };
    if (typeof kind === 'string' && Object.hasOwn(RULE_SET_KINDS, kind)) {
      const shape = RULE_SET_KINDS[kind];
      if (shape !== undefined) return shape;
    }
    return { path: at, message: `${citeName(at)} must be one of pack, local, referential` };
  },
};

const COMPONENT: Shape = {
  summary: '{ name, version, digest?, declaredBy }',
  fields: {
    name: nonEmptyString,
    version: nonEmptyString,
    digest: sha256,
    declaredBy: stringCheck('a non-empty string', (text, path) =>
      DECLARED_BY.test(text)
        ? undefined
        : `${citeName(path)} must be engine, plugin:<name> or model:<name>`,
    ),
  },
  optional: ['digest'],
};

const VERSIONS: Shape = {
  summary: '{ engine, plugins, dsls, models, components }',
  fields: {
    engine: nonEmptyString,
    plugins: mapOf(nonEmptyString, 'non-empty strings'),
    dsls: mapOf(nonEmptyString, 'non-empty strings'),
    models: mapOf(nonEmptyString, 'non-empty strings'),
    components: listOf(objectOf(COMPONENT)),
  },
};

const SUPERSEDES: Shape = {
  summary: '{ digest, reason }',
  fields: { digest: sha256, reason: code },
};

const BOUNDS: Shape = {
  summary: '{ min?, max? }',
  fields: { min: json, max: json },
  optional: ['min', 'max'],
};

const SELECTION: Shape = {
  summary: '{ ruleId, subject? }',
  fields: { ruleId: citedRule, subject },
  optional: ['subject'],
};

/** The members of an output declaration, as a proof output carries them. */
const DECLARATION_KEYS = [
  'type',
  'combine',
  'values',
  'rounding',
  'unit',
  'empty',
  'per',
  'dimension',
  'sign',
] as const;

const OUTPUT: Shape = {
  summary: '{ name, type, combine, status, value?, contributors, pending, … }',
  fields: {
    name: outputName,
    status,
    value: json,
    contributors: listOf(citedRule),
    pending: listOf(citedRule),
    bounds: objectOf(BOUNDS),
    selected: objectOf(SELECTION),
    // Read here, checked as a declaration by `output`.
    ...Object.fromEntries(DECLARATION_KEYS.map((key) => [key, document])),
    salt,
  },
  optional: [
    'value',
    'bounds',
    'selected',
    'values',
    'rounding',
    'unit',
    'empty',
    'per',
    'dimension',
    'sign',
  ],
};

/**
 * An output: its declaration members are checked as an output declaration
 * (`validateOutputDeclaration`), on their copies, and must be written in its normal form
 * (`normalizeOutputDeclaration`): no `empty: false`, no `rounding.at: 'output'`, no increment
 * that is a scale.
 */
const output: Check = (value, path, add) => {
  const read = checkObject(value, path, OUTPUT, add, new Set());
  if (read === undefined) return undefined;
  const { copy } = read;
  const declaration: Record<string, unknown> = {};
  for (const key of DECLARATION_KEYS) {
    if (copy[key] !== undefined) declaration[key] = copy[key];
  }
  // A missing type or strategy was reported as required.
  if (copy.type === undefined || copy.combine === undefined) return copy;
  // The copy was counted when it was read.
  const { issues, normal } = ownCopy(() => readDeclaration(declaration, path));
  for (const issue of issues) add(issue.path, issue.message);
  if (normal === undefined) return copy;
  if (copy.empty === false) {
    add(`${path}.empty`, `${citeName(path)}.empty must be absent: false is the default`);
  }
  checkNormalRounding(copy.rounding, normal.rounding?.scale, `${path}.rounding`, add);
  return copy;
};

/** The rounding `rounding` (valid) in its normal form: `at` not `output`, a scale as a scale. */
function checkNormalRounding(
  rounding: unknown,
  scale: number | undefined,
  at: string,
  add: Add,
): void {
  // A plain copy: reading it again spends nothing and runs no accessor.
  if (!isPlainObject(rounding)) return;
  if (rounding.at === 'output') {
    add(`${at}.at`, `${citeName(at)}.at must be absent: output is the default`);
  }
  const { increment } = rounding;
  if (typeof increment === 'string' && scale !== undefined) {
    add(
      `${at}.increment`,
      `${citeName(at)}.increment ${quoteText(increment)} must be written as scale ${scale}`,
    );
  }
}

const ITEM: Shape = {
  summary: '{ output, subject, status, value?, contributors, pending, bounds?, selected?, salt }',
  fields: {
    output: outputName,
    subject,
    status,
    value: json,
    contributors: listOf(citedRule),
    pending: listOf(citedRule),
    bounds: objectOf(BOUNDS),
    selected: objectOf(SELECTION),
    salt,
  },
  optional: ['value', 'bounds', 'selected'],
};

const MATCH: Shape = {
  summary: '{ values, via }',
  fields: {
    values: listOf(dimensionValue, 'a match has a value'),
    via: listOf(nonEmptyString),
  },
};

const STEP: Shape = {
  summary: '{ ruleId, version, subject?, model, output, contribution, status, stratum, … }',
  fields: {
    ruleId: citedRule,
    version,
    subject,
    model: nonEmptyString,
    output: outputName,
    contribution: json,
    status: settledStatus('step'),
    stratum,
    unrounded: json,
    sourceRef: nonEmptyString,
    matches: mapOf(objectOf(MATCH), 'matches', {
      name: (name, at) => (name.startsWith('$') ? reservedDimensionNameMessage(at) : undefined),
      nonEmpty: 'absent matches nothing',
    }),
    salt,
  },
  optional: ['subject', 'unrounded', 'sourceRef', 'matches'],
};

const instances = scalarCheck((value, path, add) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 2) {
    add(path, `${citeName(path)} must be an integer, 2 or more`);
  }
});

const SKIP: Shape = {
  summary: '{ ruleId, version, subject?, instances?, output?, reason, detail?, status, … }',
  fields: {
    ruleId: citedRule,
    version,
    subject,
    instances,
    output: outputName,
    reason: nonEmptyString,
    detail: nonEmptyString,
    status: settledStatus('exclusion'),
    stratum,
    salt,
  },
  optional: ['subject', 'instances', 'output', 'detail'],
  refine: (copy, path, add) => {
    if (copy.instances === undefined) return;
    const at = `${path}.instances`;
    if (copy.subject !== undefined) {
      add(at, `${citeName(at)} applies only to an entry without subject`);
    } else if (!GROUPED_REASONS.some((reason) => reason === copy.reason)) {
      const reasons = `${GROUPED_REASONS.slice(0, 3).join(', ')} or NOT_REQUESTED`;
      add(at, `${citeName(at)} applies only to ${reasons}`);
    }
  },
};

const PENDING: Shape = {
  summary: '{ ruleId, version, subject?, output?, reason, detail, missing, stratum, salt }',
  fields: {
    ruleId: citedRule,
    version,
    subject,
    output: outputName,
    reason: nonEmptyString,
    detail: nonEmptyString,
    missing: listOf(contextPointer),
    stratum,
    salt,
  },
  optional: ['subject', 'output'],
};

const AFFECTED: Shape = {
  summary: '{ ruleId, subject? }',
  fields: { ruleId: citedRule, subject },
  optional: ['subject'],
};

const EXCEPTION: Shape = {
  summary: '{ ruleId, version, subject?, kind, affected, status, stratum, salt }',
  fields: {
    ruleId: citedRule,
    version,
    subject,
    kind: oneOf(KINDS),
    affected: listOf(objectOf(AFFECTED)),
    status: settledStatus('exception'),
    stratum,
    salt,
  },
  optional: ['subject'],
};

const ASSERTION_KEYS = ['method', 'status', 'assertionDigest'];

const FACT_READ: Shape = {
  summary: '{ path, method?, status?, assertionDigest?, salt }',
  fields: {
    path: factPointer,
    method: oneOf(ASSERTION_METHODS),
    status: oneOf(ASSERTION_STATUSES),
    assertionDigest: sha256,
    salt,
  },
  optional: ASSERTION_KEYS,
  refine: (copy, path, add) => {
    const given = ASSERTION_KEYS.filter((key) => copy[key] !== undefined).length;
    if (given !== 0 && given !== ASSERTION_KEYS.length) {
      add(path, `${citeName(path)} must have method, status and assertionDigest together, or none`);
    }
  },
};

const MISSING_FACT: Shape = {
  summary: '{ path, salt }',
  fields: { path: factPointer, salt },
};

const UNDECLARED_READ: Shape = {
  summary: '{ ruleId, version, salt }',
  fields: { ruleId: citedRule, version, salt },
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

const CONTENT_FIELDS: Readonly<Record<string, Check>> = {
  format: proofFormat,
  requestId: nonEmptyString,
  evaluatedAt,
  sealedAt: instant,
  inputDigest: sha256,
  inputSalted: boolean,
  timeZone,
  ruleSets: listOf(objectOf(RULE_SET)),
  versions: objectOf(VERSIONS),
  strata: listOf(listOf(outputName)),
  requested: listOf(outputName, 'absent requests every output'),
  supersedes: objectOf(SUPERSEDES),
  rules: listOf(objectOf(RULE_REF)),
  outputs: listOf(output),
  items: listOf(objectOf(ITEM)),
  applied: listOf(objectOf(STEP)),
  skipped: listOf(objectOf(SKIP)),
  pending: listOf(objectOf(PENDING)),
  exceptions: listOf(objectOf(EXCEPTION)),
  factsRead: listOf(objectOf(FACT_READ)),
  missingFacts: listOf(objectOf(MISSING_FACT)),
  readsUndeclared: listOf(objectOf(UNDECLARED_READ)),
};

export const UNSIGNED_PROOF: Shape = {
  summary: '',
  fields: CONTENT_FIELDS,
  optional: ['requested', 'supersedes'],
  gate: formatGate,
};

export const DECISION_PROOF: Shape = {
  summary: '',
  fields: { ...CONTENT_FIELDS, digest: sha256, signature: objectOf(SIGNATURE) },
  optional: ['requested', 'supersedes', 'signature'],
  gate: formatGate,
};
