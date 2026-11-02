import { citeName, isOwnError, newSpecError, reasonOf, unreadableMessage } from '../errors.js';
import { sha256Hex } from '../hash.js';
import { boundMessages, boundWithFixed } from '../issues.js';
import type { RuleDefinition, RuleDefinitionInput } from '../rule/definition.js';
import type { CivilCalendar } from '../time/civil.js';
import { canonicalRulePayload } from '../rule/payload.js';
import { LOCAL_RULE_SET, qualifyName } from '../rule/ruleSet.js';
import { isPlainObject, readList, withValueBudget } from '../values.js';
import { misspellingOf } from '../rule/fields.js';
import { extend } from './collect.js';
import { carrierRuleFindings } from './carrier-rules.js';
import { definitionFindings } from './definition-checks.js';
import type { Context } from './combination.js';
import { contextOf, inconsistencies } from './consistency.js';
import { isLifted, liftedChecks, LIFTS, unexplained } from './lifts.js';
import type { RuleIdentity } from './lifts.js';
import { instanceKey } from './output-values.js';
import { proofView } from './redact.js';
import type { Redactions } from './redact.js';
import { treeDigest } from './tree.js';
import { publicKeyBytes, signatureMatches } from './sign.js';
import type { DecisionProof, ProofVerification, ProofView } from './types.js';
import { readDecisionProof } from './validate.js';

/**
 * An issue, and what it does: `invalid` makes the proof invalid, `warning` keeps it from being
 * `authentic`, `notice` says what could not be checked (redacted entries) and changes nothing.
 */
interface Finding {
  message: string;
  level: 'invalid' | 'warning' | 'notice';
  /** Never cut when issues are bounded: the notices that say what was not checked. */
  fixed?: true;
}

const invalidFinding = (message: string): Finding => ({ message, level: 'invalid' });

/** The notice of a call without `rules`: what `authentic` then does not cover. */
const RULES_NOT_CHECKED =
  'rules not checked: pass rules to compare checksums, priorities and carriers';

/** The notice of every verdict that is not `invalid`: `verifyProof` executes nothing. */
const NOT_REPLAYED = 'conditions and amounts not checked: verifyProof does not replay the decision';

/**
 * Verifies a decision proof without executing anything, and never throws: any malformed input
 * gives `invalid`. Issues are short, stable English strings.
 *
 * 1. The shape (`validateProof`). A malformed proof is `invalid` with the validation messages,
 *    and nothing else is checked. A `format` outside `PROOF_FORMATS` gives the single
 *    issue `unknown format: <format>`: this version cannot read a later format. The proof is
 *    read once (each property read and counted exactly once) into a plain-JSON snapshot built
 *    from the very values checked, and every later check runs on that snapshot only.
 * 2. The digest, recomputed from the leaves (`proofLeafHashes`, D-16): `digest mismatch` makes
 *    it `invalid`. A redacted entry gives its leaf as it is: redacting keeps the digest.
 * 3. Internal consistency (`inconsistencies`), each contradiction an issue that makes it
 *    `invalid`, in this order: citations (`cited rule not listed: id@version`, qualified, or
 *    `: id`; `cited output not listed: name`; `rule set not listed: id`); rule sets (listed
 *    twice, importing themselves or a pack not listed, imports out of order); the order and
 *    identity of every list (`<section> not sorted at i`, `duplicate output: name`,
 *    `rule decided twice: id@version`, ...); strata (`stratum output unknown: name`,
 *    `stratum output repeated: name`, `output not in strata: name`,
 *    `stratum out of range: id@version`, `step stratum mismatch: id@version`); rules feeding an
 *    output of a rule set their pack does not import; models missing from `versions.models`;
 *    decimals not canonical (`decimal value not canonical: name`); values off their output's
 *    declaration or its rounding; the outputs and items (status, value, bounds, selection,
 *    their contributors, pending rules and statuses, and whether each value follows from its
 *    contributions under `combine`: `output value does not follow from its contributions:
 *    name`; their completeness: `undetermined output without a cause: name`, `settled output
 *    with pending rules: name`, a `highestPriority` winner outranking the pending rules by the
 *    priorities `rules` records; `item outside its per collection: name at subject`);
 *    `unrounded` values; rules with undeclared reads that are determined; `rule not decided:
 *    id@version`; and the statuses exceptions impose (`exception status differs from its
 *    carrier's decision: id@version`, `decision weaker than the exception that affected it:
 *    id@version`).
 * 4. The signature. `unsigned`, or `untrusted key` (its `keyId` is not an own key of
 *    `trustedKeys`), or `trusted key malformed` (not 64 hex characters, not a curve point, or
 *    a small-order point), leave it at best `consistent`: nothing proves who produced it.
 *    `signature invalid` makes it `invalid`. `trustedKeys` maps a key id to a hex ed25519
 *    public key.
 * 5. With `rules`, the rules the decision claims to have received: the set of
 *    `{ ruleSet, id, version, checksum }` of `rules` (each checksum recomputed as
 *    `sha256Hex(canonicalRulePayload(rule))`, a rule without `ruleSet` being local) must equal
 *    the set in `proof.rules`. Each difference makes it `invalid`, the rule cited by its
 *    qualified id (D-37): `rule missing: id@version` (in the proof, not given),
 *    `unexpected rule: id@version` (given, not in the proof), `rule checksum mismatch:
 *    id@version`, `duplicate rule: id@version`, `rule invalid: rules[i]: <reason>`, and, for a
 *    rule whose checksum matches, `rule priority mismatch: id@version` when the priority the
 *    proof records is not that of the definition (`-0` and `0` are the same priority). Then,
 *    in the order of `pending`, for a given rule: `fired missing: id@version[ at
 *    subject]` on a pending entry of a rule whose definition carries exceptions, and
 *    `fired on a rule without exceptions: …` on one of a rule that carries none (R18). Then
 *    the carriers against their definitions (`carrierRuleFindings`): `carrier does not select
 *    its target`, `target decided as if its carrier were not pending`, `carrier exceptions
 *    differ from its definition`.
 *
 *    With redacted entries of `rules`, the rules given that the proof does not show are compared
 *    by number: `rules check incomplete: n redacted rule(s)` keeps it at best `consistent`;
 *    `unexpected rules: u given, not in the proof (n redacted)` or `rules missing: m redacted,
 *    not given` make it `invalid` when the numbers differ. The checks of the exception records
 *    of carriers are not made while `skipped` or `exceptions` has a redacted entry.
 *
 * Malformed options (not an object, `trustedKeys` not an object, `rules` not an array) make it
 * `invalid` too, rather than being ignored.
 *
 * `issues` lists at most 100 messages, then `further problems not listed (limit 100)`
 * (`IssueList`, shared by every validator of the package).
 *
 * `authentic` needs a matching digest, a valid signature by a trusted key, and no difference
 * in `rules`; notices aside, it has no issue. A proof that is only `consistent` must not be
 * used for audit.
 *
 * The verdict is about the data read during the call. Act on verified data: take a JSON copy
 * first (`JSON.parse(JSON.stringify(p))`), verify the copy and use it, never a live object whose
 * accessors could return something else afterwards.
 */
export function verifyProof(
  p: unknown,
  o?: {
    trustedKeys?: Record<string, string>;
    rules?: ReadonlyArray<RuleDefinitionInput>;
    calendar?: CivilCalendar;
    maxProofTimeZones?: number;
  },
): ProofVerification {
  // The options are the caller's: an unknown or unreadable one is a mistake of the caller, not a
  // fault of the proof, so it throws (the key named) instead of blaming a correct proof.
  const options = readOptions(o);
  try {
    return withValueBudget(() => verify(p, options));
  } catch (error) {
    // A hostile value (a Proxy, a throwing getter) can still throw while being read.
    return { status: 'invalid', issues: [unreadableMessage('proof', error)] };
  }
}

function verify(p: unknown, options: Options): ProofVerification {
  const { proof, errors } = readDecisionProof(p);
  if (!proof) return { status: 'invalid', issues: boundMessages(errors) };

  const findings: Finding[] = [];
  if (treeDigest(proof) !== proof.digest) findings.push(invalidFinding('digest mismatch'));
  const { view, redactions } = proofView(proof);
  const zones = new Set<string>([proof.timeZone]);
  for (const set of proof.ruleSets)
    if (set.kind !== 'referential' && set.timeZone) zones.add(set.timeZone);
  if (zones.size > options.maxProofTimeZones) {
    findings.push(
      invalidFinding(
        `proof names ${zones.size} time zones, more than maxProofTimeZones (${options.maxProofTimeZones})`,
      ),
    );
  }
  const context = contextOf(view, redactions.hidden);
  for (const message of inconsistencies(view, context, redactions.positions)) {
    findings.push(invalidFinding(message));
  }
  if (redactions.count > 0) {
    findings.push({
      message: `redacted entries: ${redactions.count}`,
      level: 'notice',
      fixed: true,
    });
    if (!proof.inputSalted) {
      findings.push({ message: 'redacted entries in an unsalted proof', level: 'warning' });
    }
  }
  const unchecked: string[] = [];
  extend(findings, optionFindings(view, proof, options, context, redactions, unchecked));
  // Every problem lifted, when the redacted entries cannot explain them all with the rules given.
  for (const message of unexplained(redactions.hidden)) findings.push(invalidFinding(message));
  const lifted = liftedChecks(redactions.hidden);
  for (const { check, redacted } of lifted) {
    const message = `check lifted: ${check} (${redacted.join(', ')} redacted)`;
    findings.push({ message, level: 'notice', fixed: true });
  }

  // What was not checked is said under a verdict that claims something, never under `invalid`,
  // which stops at its problem.
  const refused = findings.some((finding) => finding.level === 'invalid');
  if (!refused) {
    unchecked.push(NOT_REPLAYED);
    // Fixed in number (a handful of kinds, never one per rule), so never cut.
    for (const message of unchecked) findings.push({ message, level: 'notice' });
  }
  const issues = boundWithFixed(findings);
  const trusted = !findings.some((finding) => finding.level === 'warning');
  if (refused) {
    return redactions.count > 0
      ? { status: 'invalid', issues, redacted: redactions.count, lifted }
      : { status: 'invalid', issues };
  }
  if (redactions.count === 0) return { status: trusted ? 'authentic' : 'consistent', issues };
  // What a redacted entry hides is never checked: never the full verdict (D-16).
  const status = trusted ? 'authentic-redacted' : 'consistent-redacted';
  return { status, issues, redacted: redactions.count, lifted };
}

/** The options of a call, read once. */
interface Options {
  /** False when the argument is given but is not an object: a verdict, as it always was. */
  shapeOk: boolean;
  trustedKeys: unknown;
  rules: unknown;
  calendar: unknown;
  maxProofTimeZones: number;
}

/** The distinct time zones a proof may name (`maxProofTimeZones`, by default). */
export const MAX_PROOF_TIME_ZONES = 64;

/**
 * Reads the options once. An unknown key (a typo: `calender`), an option that cannot be read, or
 * a `maxProofTimeZones` that is not a positive integer throws `SpecError` (`INVALID_PROOF`) with
 * the option named: a mistake of the caller, never a verdict on the proof.
 */
function readOptions(o: unknown): Options {
  const fail = (message: string): never => {
    throw newSpecError('INVALID_PROOF', message);
  };
  const empty: Options = {
    shapeOk: true,
    trustedKeys: undefined,
    rules: undefined,
    calendar: undefined,
    maxProofTimeZones: MAX_PROOF_TIME_ZONES,
  };
  if (o === undefined) return empty;
  let record: Record<string, unknown> | undefined;
  try {
    record = isPlainObject(o) ? o : undefined;
  } catch (error) {
    return fail(unreadableMessage('options', error));
  }
  if (record === undefined) return { ...empty, shapeOk: false };
  try {
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key === 'string' && OPTION_KEYS.includes(key)) continue;
      const name = typeof key === 'symbol' ? key.toString() : key;
      const wanted = typeof key === 'symbol' ? undefined : misspellingOf(key, OPTION_NAMES);
      const hint = wanted === undefined ? '' : ` (did you mean ${wanted}?)`;
      fail(`options.${citeName(name)} is not an option${hint}`);
    }
  } catch (error) {
    return isOwnError(error) ? fail(error.message) : fail(unreadableMessage('options', error));
  }
  const read = (name: string): unknown => {
    try {
      return record[name];
    } catch (error) {
      return fail(unreadableMessage(`options.${name}`, error));
    }
  };
  const max = read('maxProofTimeZones');
  if (max !== undefined && !(typeof max === 'number' && Number.isSafeInteger(max) && max > 0)) {
    fail('options.maxProofTimeZones must be a positive integer');
  }
  return {
    shapeOk: true,
    trustedKeys: read('trustedKeys'),
    rules: read('rules'),
    calendar: read('calendar'),
    maxProofTimeZones: (max as number | undefined) ?? MAX_PROOF_TIME_ZONES,
  };
}

/** The options `verifyProof` reads: any other key is a mistake, never ignored. */
const OPTION_KEYS: readonly string[] = ['trustedKeys', 'rules', 'calendar', 'maxProofTimeZones'];
const OPTION_NAMES = OPTION_KEYS.map((name) => [name, name.toLowerCase()] as const);

/**
 * The findings of the options: their shape, the signature against `trustedKeys`, the rules
 * against `rules`. An option that cannot be read (a throwing getter, a Proxy trap) is an
 * options problem (`options could not be read: <reason>`, `options.rules could not be read:
 * <reason>`, …), never one of the proof.
 */
function optionFindings(
  view: ProofView,
  proof: DecisionProof,
  options: Options,
  context: Context,
  redactions: Redactions,
  unchecked: string[],
): Finding[] {
  const unreadable = (subject: string, error: unknown): Finding[] => [
    invalidFinding(unreadableMessage(subject, error)),
  ];
  const findings: Finding[] = [];
  if (!options.shapeOk) {
    findings.push(invalidFinding('options must be an object { trustedKeys?, rules?, calendar? }'));
  }
  const { trustedKeys, rules } = options;
  let calendar: unknown = options.calendar;
  if (calendar !== undefined && !isCalendar(calendar)) {
    findings.push(
      invalidFinding('options.calendar must be a calendar { toCivilDate, startOfDay }'),
    );
    calendar = undefined;
  }
  try {
    extend(findings, signatureFindings(proof, trustedKeys));
  } catch (error) {
    return [...findings, ...unreadable('options.trustedKeys', error)];
  }
  if (rules === undefined) {
    unchecked.push(RULES_NOT_CHECKED);
    return findings;
  }
  try {
    extend(
      findings,
      ruleFindings(
        view,
        rules,
        context,
        redactions,
        unchecked,
        calendar as CivilCalendar | undefined,
      ),
    );
  } catch (error) {
    extend(findings, unreadable('options.rules', error));
  }
  return findings;
}

function signatureFindings(p: DecisionProof, trustedKeys: unknown): Finding[] {
  const warning = (message: string): Finding[] => [{ message, level: 'warning' }];
  if (trustedKeys !== undefined && !isPlainObject(trustedKeys)) {
    return [invalidFinding('trustedKeys must be an object of hex public keys')];
  }
  // A broken trust anchor is a configuration error, whoever signed: every key is read.
  const malformed: Finding[] = [];
  const keys = new Map<string, Uint8Array | undefined>();
  for (const id of trustedKeys === undefined ? [] : Object.keys(trustedKeys)) {
    const bytes = publicKeyBytes((trustedKeys as Record<string, unknown>)[id]);
    keys.set(id, bytes);
    if (!bytes) malformed.push(invalidFinding(`${citeName(`trustedKeys.${id}`)} is malformed`));
  }
  if (malformed.length > 0) return malformed;
  if (!p.signature) return warning('unsigned');
  const { keyId, value } = p.signature;
  const publicKey = Object.hasOwn(trustedKeys ?? {}, keyId) ? keys.get(keyId) : undefined;
  if (!publicKey) return warning('untrusted key');
  if (!signatureMatches(p.digest, value, publicKey)) {
    return [invalidFinding('signature invalid')];
  }
  return [];
}

function ruleFindings(
  p: ProofView,
  rules: unknown,
  context: Context,
  redactions: Redactions,
  unchecked: string[],
  calendar: CivilCalendar | undefined,
): Finding[] {
  if (!Array.isArray(rules)) return [invalidFinding('rules must be an array')];
  const findings: Finding[] = [];
  const invalid = (message: string): void => {
    findings.push(invalidFinding(message));
  };

  const items = readList(rules, 'rules');
  if (!Array.isArray(items)) return [invalidFinding(items.message)];
  const given = new Map<string, string>();
  const priorities = new Map<string, number>();
  const carriers = new Set<string>();
  const definitions = new Map<string, RuleDefinition>();
  const identities = new Map<string, RuleIdentity>();
  items.forEach((rule, i) => {
    let key: string;
    let checksum: string;
    let priority: number;
    try {
      // Read and counted as `canonicalRulePayload` reads any rule, so `verifyProof` accepts a
      // rule exactly when `computeRuleChecksum` does. It validates any value; the cast only
      // lets it be called.
      const payload = canonicalRulePayload(rule as RuleDefinitionInput);
      // The payload is the canonical JSON of a normalized definition.
      const definition = JSON.parse(payload) as RuleDefinition;
      const id = qualifyName(definition.ruleSet ?? LOCAL_RULE_SET, definition.id);
      key = `${id}@${definition.version}`;
      checksum = sha256Hex(payload);
      priority = definition.priority;
      if ((definition.exceptions ?? []).length > 0) carriers.add(key);
      if (!definitions.has(key)) definitions.set(key, definition);
      identities.set(key, { id, version: definition.version });
    } catch (error) {
      invalid(`rule invalid: rules[${i}]: ${reasonOf(error)}`);
      return;
    }
    if (given.has(key)) invalid(`duplicate rule: ${citeName(key)}`);
    else {
      given.set(key, checksum);
      priorities.set(key, priority);
    }
  });

  const cited = new Set<string>();
  const matched = new Map<string, RuleDefinition>();
  for (const ref of p.rules) {
    const key = `${qualifyName(ref.ruleSet, ref.id)}@${ref.version}`;
    cited.add(key);
    const checksum = given.get(key);
    const definition = definitions.get(key);
    if (checksum === ref.checksum && definition !== undefined) matched.set(key, definition);
    if (checksum === undefined) invalid(`rule missing: ${citeName(key)}`);
    else if (checksum !== ref.checksum) invalid(`rule checksum mismatch: ${citeName(key)}`);
    else if (priorities.get(key) !== ref.priority) {
      invalid(`rule priority mismatch: ${citeName(key)}`);
    }
  }
  // A rule given that the proof does not show may be one of its redacted rules: those are
  // compared by number (D-16).
  const hiddenRules = redactions.bySection.get('rules') ?? 0;
  // The keys of `given`, with their rules.
  const uncited = [...identities].filter(([key]) => !cited.has(key));
  if (hiddenRules === 0) {
    for (const [key] of uncited) invalid(`unexpected rule: ${citeName(key)}`);
  } else {
    const plural = hiddenRules === 1 ? 'rule' : 'rules';
    findings.push({
      message: `rules check incomplete: ${hiddenRules} redacted ${plural}`,
      level: 'warning',
    });
    if (uncited.length > hiddenRules) {
      invalid(
        `unexpected rules: ${uncited.length} given, not in the proof (${hiddenRules} redacted)`,
      );
    } else {
      // Each a hidden rules entry of that rule, one each.
      for (const [key, rule] of uncited) {
        const message = `unexpected rule: ${citeName(key)}`;
        if (!isLifted(redactions.hidden, LIFTS.givenRules, { message, rule })) invalid(message);
      }
      if (uncited.length < hiddenRules) {
        invalid(`rules missing: ${hiddenRules - uncited.length} redacted, not given`);
      }
    }
  }
  // `fired` is on the pending entries of the rules that carry exceptions, only (R18):
  // only their definitions say which rules those are.
  for (const entry of p.pending) {
    const key = `${entry.ruleId}@${entry.version}`;
    if (!given.has(key)) continue;
    const at = citeName(instanceKey(entry));
    if (carriers.has(key) && entry.fired === undefined) {
      invalid(`fired missing: ${at}`);
    } else if (!carriers.has(key) && entry.fired !== undefined) {
      invalid(`fired on a rule without exceptions: ${at}`);
    }
  }
  carrierRuleFindings(p, matched, context, invalid);
  definitionFindings(
    p,
    matched,
    { invalid, unchecked: (message) => unchecked.push(message) },
    calendar,
  );
  // A redacted entry has no rule to compare with its definition: say so, never skip it.
  for (const section of ['applied', 'skipped', 'pending'] as const) {
    const hidden = redactions.bySection.get(section) ?? 0;
    if (hidden > 0) {
      const entries = hidden === 1 ? 'entry' : 'entries';
      unchecked.push(`${hidden} ${section} ${entries} redacted: not checked against rules`);
    }
  }
  return findings;
}

/** A calendar a caller gives: an object with the two functions `windowContains` calls. */
function isCalendar(value: unknown): value is CivilCalendar {
  try {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as CivilCalendar).toCivilDate === 'function' &&
      typeof (value as CivilCalendar).startOfDay === 'function'
    );
  } catch {
    return false;
  }
}
