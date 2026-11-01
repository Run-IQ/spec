import { citeName, reasonOf, unreadableMessage } from '../errors.js';
import { sha256Hex } from '../hash.js';
import { boundMessages } from '../issues.js';
import type { RuleDefinition, RuleDefinitionInput } from '../rule/definition.js';
import { canonicalRulePayload } from '../rule/payload.js';
import { LOCAL_RULE_SET, qualifyName } from '../rule/ruleSet.js';
import { isPlainObject, readList, withValueBudget } from '../values.js';
import { extend } from './collect.js';
import { carrierRuleFindings } from './carrier-rules.js';
import type { Context } from './combination.js';
import { contextOf, inconsistencies } from './consistency.js';
import { instanceKey } from './output-values.js';
import { contentDigest } from './digest.js';
import { publicKeyBytes, signatureMatches } from './sign.js';
import type { DecisionProof, ProofVerification } from './types.js';
import { readDecisionProof } from './validate.js';

/** An issue and whether it makes the proof `invalid` or only keeps it from being `authentic`. */
interface Finding {
  message: string;
  invalid: boolean;
}

/**
 * Verifies a decision proof without executing anything, and never throws: any malformed input
 * gives `invalid`. Issues are short, stable English strings.
 *
 * 1. The shape (`validateProof`). A malformed proof is `invalid` with the validation messages,
 *    and nothing else is checked. A `format` outside `PROOF_FORMATS` gives the single
 *    issue `unknown format: <format>`: this version cannot read a later format. The proof is
 *    read once (each property read and counted exactly once) into a plain-JSON snapshot built
 *    from the very values checked, and every later check runs on that snapshot only.
 * 2. The digest, recomputed from the content: `digest mismatch` makes it `invalid`.
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
 * Malformed options (not an object, `trustedKeys` not an object, `rules` not an array) make it
 * `invalid` too, rather than being ignored.
 *
 * `issues` lists at most 100 messages, then `further problems not listed (limit 100)`
 * (`IssueList`, shared by every validator of the package).
 *
 * `authentic` needs a matching digest, a valid signature by a trusted key, and no difference
 * in `rules`. A proof that is only `consistent` must not be used for audit.
 *
 * The verdict is about the data read during the call. Act on verified data: take a JSON copy
 * first (`JSON.parse(JSON.stringify(p))`), verify the copy and use it, never a live object whose
 * accessors could return something else afterwards.
 */
export function verifyProof(
  p: unknown,
  o?: { trustedKeys?: Record<string, string>; rules?: ReadonlyArray<RuleDefinitionInput> },
): ProofVerification {
  try {
    return withValueBudget(() => verify(p, o));
  } catch (error) {
    // A hostile value (a Proxy, a throwing getter) can still throw while being read.
    return { status: 'invalid', issues: [unreadableMessage('proof', error)] };
  }
}

function verify(p: unknown, options: unknown): ProofVerification {
  const { proof, errors } = readDecisionProof(p);
  if (!proof) return { status: 'invalid', issues: boundMessages(errors) };

  const findings: Finding[] = [];
  if (contentDigest(proof) !== proof.digest) {
    findings.push({ message: 'digest mismatch', invalid: true });
  }
  const context = contextOf(proof);
  for (const message of inconsistencies(proof, context)) findings.push({ message, invalid: true });
  extend(findings, optionFindings(proof, options, context));

  const issues = boundMessages(findings.map((finding) => finding.message));
  if (findings.some((finding) => finding.invalid)) return { status: 'invalid', issues };
  return { status: findings.length > 0 ? 'consistent' : 'authentic', issues };
}

/**
 * The findings of the options: their shape, the signature against `trustedKeys`, the rules
 * against `rules`. An option that cannot be read (a throwing getter, a Proxy trap) is an
 * options problem (`options could not be read: <reason>`, `options.rules could not be read:
 * <reason>`, …), never one of the proof.
 */
function optionFindings(proof: DecisionProof, options: unknown, context: Context): Finding[] {
  const unreadable = (subject: string, error: unknown): Finding[] => [
    { message: unreadableMessage(subject, error), invalid: true },
  ];
  let record: Record<string, unknown> | undefined;
  try {
    record = isPlainObject(options) ? options : undefined;
  } catch (error) {
    return unreadable('options', error);
  }
  const findings: Finding[] = [];
  if (options !== undefined && record === undefined) {
    findings.push({ message: 'options must be an object { trustedKeys?, rules? }', invalid: true });
  }
  let trustedKeys: unknown;
  let rules: unknown;
  try {
    trustedKeys = record?.trustedKeys;
  } catch (error) {
    return [...findings, ...unreadable('options.trustedKeys', error)];
  }
  try {
    rules = record?.rules;
  } catch (error) {
    return [...findings, ...unreadable('options.rules', error)];
  }
  try {
    extend(findings, signatureFindings(proof, trustedKeys));
  } catch (error) {
    return [...findings, ...unreadable('options.trustedKeys', error)];
  }
  if (rules === undefined) return findings;
  try {
    extend(findings, ruleFindings(proof, rules, context));
  } catch (error) {
    extend(findings, unreadable('options.rules', error));
  }
  return findings;
}

function signatureFindings(p: DecisionProof, trustedKeys: unknown): Finding[] {
  if (trustedKeys !== undefined && !isPlainObject(trustedKeys)) {
    return [{ message: 'trustedKeys must be an object of hex public keys', invalid: true }];
  }
  if (!p.signature) return [{ message: 'unsigned', invalid: false }];
  const { keyId, value } = p.signature;
  if (!trustedKeys || !Object.hasOwn(trustedKeys, keyId)) {
    return [{ message: 'untrusted key', invalid: false }];
  }
  const publicKey = publicKeyBytes(trustedKeys[keyId]);
  if (!publicKey) return [{ message: 'trusted key malformed', invalid: false }];
  if (!signatureMatches(p.digest, value, publicKey)) {
    return [{ message: 'signature invalid', invalid: true }];
  }
  return [];
}

function ruleFindings(p: DecisionProof, rules: unknown, context: Context): Finding[] {
  if (!Array.isArray(rules)) return [{ message: 'rules must be an array', invalid: true }];
  const findings: Finding[] = [];
  const invalid = (message: string): void => {
    findings.push({ message, invalid: true });
  };

  const items = readList(rules, 'rules');
  if (!Array.isArray(items)) return [{ message: items.message, invalid: true }];
  const given = new Map<string, string>();
  const priorities = new Map<string, number>();
  const carriers = new Set<string>();
  const definitions = new Map<string, RuleDefinition>();
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
  for (const key of given.keys()) {
    if (!cited.has(key)) invalid(`unexpected rule: ${citeName(key)}`);
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
  return findings;
}
