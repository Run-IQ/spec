import {
  citeName,
  isOwnOptionsError,
  newOptionsError,
  reasonOf,
  unreadableMessage,
} from '../errors.js';
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
import { signatureMatches } from './sign.js';
import { readTrustedKeys } from './trusted-keys.js';
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
 * Verifies a decision proof without executing anything. Any malformed proof gives `invalid`; a
 * mistake of the caller in the options (`VerifyOptionsError`, code `INVALID_OPTIONS`, naming the
 * option) throws, never a verdict on the proof. Issues are short, stable English strings.
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
 *    `trustedKeys`), leave it at best `consistent`: nothing proves who produced it.
 *    `signature invalid` makes it `invalid`. `trustedKeys` maps a key id to a hex ed25519
 *    public key; a key that is malformed (not 64 hex characters, not a curve point, a
 *    small-order point) is the caller's mistake and throws.
 * 5. With `rules`, the rules the decision claims to have received: the set of
 *    `{ ruleSet, id, version, checksum }` of `rules` (each checksum recomputed as
 *    `sha256Hex(canonicalRulePayload(rule))`, a rule without `ruleSet` being local) must equal
 *    the set in `proof.rules`. Each difference makes it `invalid`, the rule cited by its
 *    qualified id (D-37): `rule missing: id@version` (in the proof, not given),
 *    `unexpected rule: id@version` (given, not in the proof), `rule checksum mismatch:
 *    id@version`, and, for a rule whose checksum matches, `rule priority mismatch: id@version` when the priority the
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
 * Malformed options throw `VerifyOptionsError` (`INVALID_OPTIONS`), the option named, before the
 * proof is read: options that are not an object, an unknown key, `trustedKeys` that are not
 * keys, `rules` that are not a list or hold a rule that is not valid or is listed twice, a
 * calendar that is not one or that throws. They are never ignored and never a verdict.
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
  try {
    // The options have a budget of their own (`MAX_VERIFY_OPTIONS_NODES`), so that nothing a
    // caller passes can use up the budget of the proof: a correct proof is never called too
    // large for what the options hold.
    const options = withValueBudget(() => readOptions(o), MAX_VERIFY_OPTIONS_NODES);
    return withValueBudget(() => verify(p, options));
  } catch (error) {
    // A mistake of the caller in the options is never a verdict on the proof.
    if (isOwnOptionsError(error)) throw error;
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

/** The rules a caller gave, read once: their identity, checksum and priority. */
interface GivenRules {
  given: Map<string, string>;
  priorities: Map<string, number>;
  carriers: Set<string>;
  definitions: Map<string, RuleDefinition>;
  identities: Map<string, RuleIdentity>;
}

/** The options of a call, read and checked once: what the caller gave is the caller's. */
interface Options {
  /** The public keys of `trustedKeys`, by key id. */
  keys: Map<string, Uint8Array>;
  rules: GivenRules | undefined;
  calendar: CivilCalendar | undefined;
  maxProofTimeZones: number;
}

/**
 * The most values the options of one call may hold (the rules given count with their `params`):
 * past it, the call throws `VerifyOptionsError`. The proof has its own budget.
 */
export const MAX_VERIFY_OPTIONS_NODES = 10_000_000;

/** The distinct time zones a proof may name (`maxProofTimeZones`, by default). */
export const MAX_PROOF_TIME_ZONES = 64;

/**
 * Reads and checks every option once. A mistake of the caller throws `VerifyOptionsError`
 * (`INVALID_OPTIONS`) naming the option, never a verdict on the proof: options that are not an
 * object, an unknown key (`calender`), an option that cannot be read, a `maxProofTimeZones` that
 * is not a positive integer, a calendar that is not one, `trustedKeys` that are not keys (a
 * malformed one included), a `rules` list that is not a list, holds a rule that is not valid or
 * lists a rule twice. What the rules say about the proof stays a verdict.
 */
function readOptions(o: unknown): Options {
  const fail = (option: string, message: string): never => {
    throw newOptionsError(option, message);
  };
  const none: Options = {
    keys: new Map(),
    rules: undefined,
    calendar: undefined,
    maxProofTimeZones: MAX_PROOF_TIME_ZONES,
  };
  if (o === undefined) return none;
  let record: Record<string, unknown> | undefined;
  try {
    record = isPlainObject(o) ? o : undefined;
  } catch (error) {
    return fail('options', unreadableMessage('options', error));
  }
  if (record === undefined) {
    return fail(
      'options',
      'options must be an object { trustedKeys?, rules?, calendar?, maxProofTimeZones? }',
    );
  }
  try {
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key === 'string' && OPTION_KEYS.includes(key)) continue;
      const name = typeof key === 'symbol' ? key.toString() : key;
      const wanted = typeof key === 'symbol' ? undefined : misspellingOf(key, OPTION_NAMES);
      const hint = wanted === undefined ? '' : ` (did you mean ${wanted}?)`;
      fail(`options.${citeName(name)}`, `options.${citeName(name)} is not an option${hint}`);
    }
  } catch (error) {
    if (isOwnOptionsError(error)) throw error;
    return fail('options', unreadableMessage('options', error));
  }
  const read = (name: string): unknown => {
    try {
      return record[name];
    } catch (error) {
      return fail(`options.${name}`, unreadableMessage(`options.${name}`, error));
    }
  };
  const max = read('maxProofTimeZones');
  if (max !== undefined && !(typeof max === 'number' && Number.isSafeInteger(max) && max > 0)) {
    fail('options.maxProofTimeZones', 'options.maxProofTimeZones must be a positive integer');
  }
  const calendar = readCalendar(read('calendar'), fail);
  return {
    keys: readTrustedKeys(read('trustedKeys'), 'options.trustedKeys', fail),
    rules: readGivenRules(read('rules'), fail),
    calendar,
    maxProofTimeZones: (max as number | undefined) ?? MAX_PROOF_TIME_ZONES,
  };
}

type Fail = (option: string, message: string) => never;

/** The rules of `rules`, each read once: a rule that is not valid or is listed twice is the caller's. */
function readGivenRules(rules: unknown, fail: Fail): GivenRules | undefined {
  if (rules === undefined) return undefined;
  let items: unknown;
  try {
    if (!Array.isArray(rules)) return fail('options.rules', 'options.rules must be an array');
    items = readList(rules, 'options.rules');
  } catch (error) {
    if (isOwnOptionsError(error)) throw error;
    return fail('options.rules', unreadableMessage('options.rules', error));
  }
  if (!Array.isArray(items)) {
    return fail('options.rules', (items as { message: string }).message);
  }
  const out: GivenRules = {
    given: new Map(),
    priorities: new Map(),
    carriers: new Set(),
    definitions: new Map(),
    identities: new Map(),
  };
  items.forEach((rule, i) => {
    const at = `options.rules[${i}]`;
    let key: string;
    let checksum: string;
    let definition: RuleDefinition;
    let id: string;
    try {
      // Read and counted as `canonicalRulePayload` reads any rule, so `verifyProof` accepts a
      // rule exactly when `computeRuleChecksum` does.
      const payload = canonicalRulePayload(rule as RuleDefinitionInput);
      // The payload is the canonical JSON of a normalized definition.
      definition = JSON.parse(payload) as RuleDefinition;
      id = qualifyName(definition.ruleSet ?? LOCAL_RULE_SET, definition.id);
      key = `${id}@${definition.version}`;
      checksum = sha256Hex(payload);
    } catch (error) {
      return fail(at, `${at} is not a valid rule: ${reasonOf(error)}`);
    }
    if (out.given.has(key)) return fail(at, `${at} repeats the rule ${citeName(key)}`);
    out.given.set(key, checksum);
    out.priorities.set(key, definition.priority);
    if ((definition.exceptions ?? []).length > 0) out.carriers.add(key);
    out.definitions.set(key, definition);
    out.identities.set(key, { id, version: definition.version });
  });
  return out;
}

/** The options `verifyProof` reads: any other key is a mistake, never ignored. */
const OPTION_KEYS: readonly string[] = ['trustedKeys', 'rules', 'calendar', 'maxProofTimeZones'];
const OPTION_NAMES = OPTION_KEYS.map((name) => [name, name.toLowerCase()] as const);

/**
 * The findings of the options against the proof: the signature against `trustedKeys`, the rules
 * given against the rules of the proof. The options themselves were checked before (`readOptions`).
 */
function optionFindings(
  view: ProofView,
  proof: DecisionProof,
  options: Options,
  context: Context,
  redactions: Redactions,
  unchecked: string[],
): Finding[] {
  const findings: Finding[] = [];
  extend(findings, signatureFindings(proof, options.keys));
  if (options.rules === undefined) {
    unchecked.push(RULES_NOT_CHECKED);
    return findings;
  }
  extend(
    findings,
    ruleFindings(view, options.rules, context, redactions, unchecked, options.calendar),
  );
  return findings;
}

function signatureFindings(p: DecisionProof, keys: Map<string, Uint8Array>): Finding[] {
  const warning = (message: string): Finding[] => [{ message, level: 'warning' }];
  if (!p.signature) return warning('unsigned');
  const { keyId, value } = p.signature;
  const publicKey = keys.get(keyId);
  if (!publicKey) return warning('untrusted key');
  if (!signatureMatches(p.digest, value, publicKey)) {
    return [invalidFinding('signature invalid')];
  }
  return [];
}

function ruleFindings(
  p: ProofView,
  given: GivenRules,
  context: Context,
  redactions: Redactions,
  unchecked: string[],
  calendar: CivilCalendar | undefined,
): Finding[] {
  const findings: Finding[] = [];
  const invalid = (message: string): void => {
    findings.push(invalidFinding(message));
  };
  const { given: checksums, priorities, carriers, definitions, identities } = given;

  const cited = new Set<string>();
  const matched = new Map<string, RuleDefinition>();
  for (const ref of p.rules) {
    const key = `${qualifyName(ref.ruleSet, ref.id)}@${ref.version}`;
    cited.add(key);
    const checksum = checksums.get(key);
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
    if (!checksums.has(key)) continue;
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

/**
 * The calendar a caller gives, its two functions read once: the copy checked is the copy used
 * (a getter cannot answer differently later). Anything else, a throwing getter included, is the
 * caller's mistake.
 */
function readCalendar(value: unknown, fail: Fail): CivilCalendar | undefined {
  if (value === undefined) return undefined;
  const mustBe = 'options.calendar must be a calendar { toCivilDate, startOfDay }';
  if (typeof value !== 'object' || value === null) return fail('options.calendar', mustBe);
  let toCivilDate: unknown;
  let startOfDay: unknown;
  try {
    toCivilDate = (value as CivilCalendar).toCivilDate;
    startOfDay = (value as CivilCalendar).startOfDay;
  } catch (error) {
    return fail('options.calendar', unreadableMessage('options.calendar', error));
  }
  if (typeof toCivilDate !== 'function' || typeof startOfDay !== 'function') {
    return fail('options.calendar', mustBe);
  }
  const civil = toCivilDate as CivilCalendar['toCivilDate'];
  const start = startOfDay as CivilCalendar['startOfDay'];
  return Object.freeze({
    toCivilDate: (instant: string, zone: string) => civil.call(value, instant, zone),
    startOfDay: (day: string, zone: string) => start.call(value, day, zone),
  });
}
