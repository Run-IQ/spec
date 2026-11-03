import { readDeclaration } from '../decision/read-declaration.js';
import { citeName, quoteText } from '../errors.js';
import { ASSERTION_METHODS, ASSERTION_STATUSES } from '../input/types.js';
import type { RuleValidationIssue } from '../issues.js';
import { reservedDimensionNameMessage } from '../rule/dimensions.js';
import { KINDS } from '../rule/exceptions.js';
import { isPlainObject, ownCopy } from '../values.js';
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
import { hasErrorCause } from './carriers.js';
import { isProofFormat, PROOF_FORMATS } from './formats.js';
import { PROOF_SECTIONS } from './types.js';
import type { ProofSection } from './types.js';
import {
  citedRule,
  code,
  contextPointer,
  DECLARED_BY,
  dimensionValue,
  evaluatedAt,
  factPointer,
  instant,
  outputName,
  packId,
  priority,
  rank,
  ruleId,
  ruleSetId,
  salt,
  settledStatus,
  SIGNATURE_BASE64URL,
  status,
  stratum,
  subject,
  timeZone,
  version,
  GROUPED_REASONS,
} from './fields.js';
import {
  NativeSet,
  NativeString,
  arrayFilter,
  arrayJoin,
  arrayMap,
  arraySlice,
  arraySome,
  mapGet,
  numberIsSafeInteger,
  objectEntries,
  objectFromEntries,
  objectHasOwn,
  regExpTest,
  stringReplace,
  stringStartsWith,
} from '../intrinsics.js';

// Internal to `@run-iq/spec`: the shape of a decision proof, as `validateProof` checks it and
// `schema/decision-proof.schema.json` describes it.

const RULE_REF: Shape = {
  summary: '{ id, version, checksum, ruleSet, priority, sourceRef?, salt }',
  fields: {
    id: ruleId,
    version,
    checksum: sha256,
    ruleSet: ruleSetId,
    priority,
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
    const kind = mapGet(members, 'kind');
    const at = `${path}.kind`;
    if (kind === undefined) return { path: at, message: `${citeName(at)} is required` };
    if (typeof kind === 'string' && objectHasOwn(RULE_SET_KINDS, kind)) {
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
      regExpTest(DECLARED_BY, text)
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
    // Read here, checked as a declaration by `outputOf`.
    ...objectFromEntries(arrayMap(DECLARATION_KEYS, (key) => [key, document])),
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
 * An output of `shape` (salted or not): its declaration members are checked as an output
 * declaration (`validateOutputDeclaration`), on their copies, and must be written in its normal
 * form (`normalizeOutputDeclaration`): no `empty: false`, no `rounding.at: 'output'`, no
 * increment that is a scale. A redacted output (its gate gave `REDACTED`) has none.
 */
function outputOf(shape: Shape): Check {
  return (value, path, add) => {
    const read = checkObject(value, path, shape, add, new NativeSet());
    if (read === undefined) return undefined;
    const { copy } = read;
    if (mapGet(read.members, 'redacted') !== undefined) return copy;
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
}

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
      name: (name, at) =>
        stringStartsWith(name, '$') ? reservedDimensionNameMessage(at) : undefined,
      nonEmpty: 'absent matches nothing',
    }),
    rank,
    salt,
  },
  optional: ['subject', 'unrounded', 'sourceRef', 'matches', 'rank'],
};

const instances = scalarCheck((value, path, add) => {
  if (typeof value !== 'number' || !numberIsSafeInteger(value) || value < 2) {
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
    } else if (!arraySome(GROUPED_REASONS, (reason) => reason === copy.reason)) {
      const reasons = `${arrayJoin(arraySlice(GROUPED_REASONS, 0, 3), ', ')} or NOT_REQUESTED`;
      add(at, `${citeName(at)} applies only to ${reasons}`);
    }
  },
};

const CARRIER: Shape = {
  summary: '{ ruleId, version, subject? }',
  fields: { ruleId: citedRule, version, subject },
  optional: ['subject'],
};

const PENDING: Shape = {
  summary:
    '{ ruleId, version, subject?, output?, reason, detail, missing, fired?, carrier?, ' +
    'stratum, salt }',
  fields: {
    ruleId: citedRule,
    version,
    subject,
    output: outputName,
    reason: nonEmptyString,
    detail: nonEmptyString,
    missing: listOf(contextPointer),
    fired: boolean,
    carrier: objectOf(CARRIER),
    stratum,
    salt,
  },
  optional: ['subject', 'output', 'fired', 'carrier'],
  refine: (copy, path, add) => {
    const at = `${path}.carrier`;
    if (copy.reason === 'PENDING_CARRIER' && copy.carrier === undefined) {
      add(at, `${citeName(at)} is required for PENDING_CARRIER`);
    } else if (copy.reason !== 'PENDING_CARRIER' && copy.carrier !== undefined) {
      add(at, `${citeName(at)} applies only to PENDING_CARRIER`);
    }
    if (copy.reason === 'ERROR' && !hasErrorCause(NativeString(copy.detail))) {
      const detail = `${path}.detail`;
      add(detail, `${citeName(detail)} must be <CAUSE>: <message>, its cause one of ERROR_CAUSES`);
    }
  },
};

const AFFECTED: Shape = {
  summary: '{ ruleId, subject? }',
  fields: { ruleId: citedRule, subject },
  optional: ['subject'],
};

const EXCEPTION: Shape = {
  summary: '{ ruleId, version, subject?, kind, output?, affected, status, stratum, salt }',
  fields: {
    ruleId: citedRule,
    version,
    subject,
    kind: oneOf(KINDS),
    output: outputName,
    affected: listOf(objectOf(AFFECTED)),
    status: settledStatus('exception'),
    stratum,
    salt,
  },
  optional: ['subject', 'output'],
  refine: (copy, path, add) => {
    // Checked once kind is: an unknown kind is its own problem.
    if (!arraySome(KINDS, (kind) => kind === copy.kind)) return;
    const at = `${path}.output`;
    if (copy.kind === 'shortCircuit' && copy.output === undefined) {
      add(at, `${citeName(at)} is required for a shortCircuit`);
    } else if (copy.kind !== 'shortCircuit' && copy.output !== undefined) {
      add(at, `${citeName(at)} applies only to a shortCircuit`);
    }
  },
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
    const given = arrayFilter(ASSERTION_KEYS, (key) => copy[key] !== undefined).length;
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
      if (typeof value !== 'string' || !regExpTest(SIGNATURE_BASE64URL, value)) {
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
    add(path, `${citeName(path)} must be one of ${arrayJoin(PROOF_FORMATS, ', ')}`);
  }
});

/**
 * A proof in a format this package does not know (a later `run-iq.proof/2`) is refused with that
 * single issue: its other fields follow rules this version cannot check.
 */
function formatGate(members: ReadonlyMap<string, unknown>): RuleValidationIssue | undefined {
  const format = mapGet(members, 'format');
  if (typeof format !== 'string' || isProofFormat(format)) return undefined;
  return { path: 'format', message: `unknown format: ${citeName(format)}` };
}

/**
 * A redacted entry (D-16): the hash of its leaf alone, in place of the entry. An entry of a
 * section with a `redacted` member is one, and has no other member.
 */
const REDACTED: Shape = {
  summary: '{ redacted }',
  fields: {
    redacted: scalarCheck((value, path, add) => {
      if (typeof value !== 'string' || !regExpTest(/^[0-9a-f]{64}$/, value)) {
        add(path, `${citeName(path)} must be a leaf hash: 64 lowercase hex characters`);
      }
    }),
  },
};

/** `shape` as an entry of a sealed proof: salted, or redacted (`REDACTED`) instead. */
function redactable(shape: Shape): Shape {
  return {
    ...shape,
    gate: (members) => (mapGet(members, 'redacted') !== undefined ? REDACTED : undefined),
  };
}

/** `shape` as an entry of a proof not yet sealed: without its `salt`, never redacted. */
function unsalted(shape: Shape): Shape {
  const fields = { ...shape.fields };
  delete fields.salt;
  return { ...shape, summary: stringReplace(shape.summary, ', salt }', ' }'), fields };
}

/** The entry shapes of the ten sections (`outputs` aside: `outputOf`), salted. */
const ENTRIES: Readonly<Record<Exclude<ProofSection, 'outputs'>, Shape>> = {
  rules: RULE_REF,
  items: ITEM,
  applied: STEP,
  skipped: SKIP,
  pending: PENDING,
  exceptions: EXCEPTION,
  factsRead: FACT_READ,
  missingFacts: MISSING_FACT,
  readsUndeclared: UNDECLARED_READ,
};

/** The check of an entry of each section, as `variant` reads it. */
function entryChecks(variant: (shape: Shape) => Shape): Record<ProofSection, Check> {
  const checks = { outputs: outputOf(variant(OUTPUT)) } as Record<ProofSection, Check>;
  for (const [section, shape] of objectEntries(ENTRIES)) {
    checks[section as ProofSection] = objectOf(variant(shape));
  }
  return checks;
}

/** Internal: the check of an entry of each section of a sealed proof (salted or redacted). */
export const SECTION_ENTRY: Readonly<Record<ProofSection, Check>> = entryChecks(redactable);

const UNSALTED_ENTRY = entryChecks(unsalted);

/** `counts`: the number of entries of each section, each a safe integer from 0. */
const COUNTS: Shape = {
  summary: `{ ${arrayJoin(PROOF_SECTIONS, ', ')} }`,
  fields: objectFromEntries(arrayMap(PROOF_SECTIONS, (section) => [section, stratum])),
};

/** The fields of the header of a proof before sealing (`UnsaltedProof`): without `counts`. */
const UNSALTED_HEADER_FIELDS: Readonly<Record<string, Check>> = {
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
};

/** The fields of the header (D-16): every field but the ten sections, `digest`, `signature`. */
const HEADER_FIELDS: Readonly<Record<string, Check>> = {
  ...UNSALTED_HEADER_FIELDS,
  counts: objectOf(COUNTS),
};

/** The section fields: each a list of entries checked by `entries`. */
function sectionFields(entries: Readonly<Record<ProofSection, Check>>): Record<string, Check> {
  return objectFromEntries(
    arrayMap(PROOF_SECTIONS, (section) => [section, listOf(entries[section])]),
  ) as Record<string, Check>;
}

const CONTENT_FIELDS: Readonly<Record<string, Check>> = {
  ...HEADER_FIELDS,
  ...sectionFields(SECTION_ENTRY),
};

const OPTIONAL_HEADER = ['requested', 'supersedes'];

/** Internal: the header of a proof alone (a leaf, `proofLeafHash`). */
export const PROOF_HEADER: Shape = {
  summary: '',
  fields: HEADER_FIELDS,
  optional: OPTIONAL_HEADER,
  gate: formatGate,
};

/** Internal: the content of a sealed proof (`digest` and `signature` read apart). */
export const UNSIGNED_PROOF: Shape = {
  summary: '',
  fields: CONTENT_FIELDS,
  optional: OPTIONAL_HEADER,
  gate: formatGate,
};

/** Internal: the content `sealProof` seals: entries without `salt`, none redacted. */
export const UNSALTED_PROOF: Shape = {
  summary: '',
  fields: { ...UNSALTED_HEADER_FIELDS, ...sectionFields(UNSALTED_ENTRY) },
  optional: OPTIONAL_HEADER,
  gate: formatGate,
};

export const DECISION_PROOF: Shape = {
  summary: '',
  fields: { ...CONTENT_FIELDS, digest: sha256, signature: objectOf(SIGNATURE) },
  optional: [...OPTIONAL_HEADER, 'signature'],
  gate: formatGate,
};
