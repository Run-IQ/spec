import { citeName, reasonOf, unreadableMessage } from '../errors.js';
import { sha256Hex } from '../hash.js';
import { boundMessages } from '../issues.js';
import type { RuleDefinition, RuleDefinitionInput } from '../rule/definition.js';
import { canonicalRulePayload } from '../rule/payload.js';
import { LOCAL_RULE_SET, qualifyName } from '../rule/ruleSet.js';
import { isPlainObject, readList, withValueBudget } from '../values.js';
import { inconsistencies } from './consistency.js';
import { priorityProblems } from './statuses.js';
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
 *    name`); `unrounded` values; and rules with undeclared reads that are determined.
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
 *    id@version`, `duplicate rule: id@version`, `rule invalid: rules[i]: <reason>`.
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
  for (const message of inconsistencies(proof)) findings.push({ message, invalid: true });
  if (options !== undefined && !isPlainObject(options)) {
    findings.push({ message: 'options must be an object { trustedKeys?, rules? }', invalid: true });
  }
  const trustedKeys = isPlainObject(options) ? options.trustedKeys : undefined;
  const rules = isPlainObject(options) ? options.rules : undefined;
  findings.push(...signatureFindings(proof, trustedKeys));
  if (rules !== undefined) findings.push(...ruleFindings(proof, rules));

  const issues = boundMessages(findings.map((finding) => finding.message));
  if (findings.some((finding) => finding.invalid)) return { status: 'invalid', issues };
  return { status: findings.length > 0 ? 'consistent' : 'authentic', issues };
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

function ruleFindings(p: DecisionProof, rules: unknown): Finding[] {
  if (!Array.isArray(rules)) return [{ message: 'rules must be an array', invalid: true }];
  const findings: Finding[] = [];
  const invalid = (message: string): void => {
    findings.push({ message, invalid: true });
  };

  const items = readList(rules, 'rules');
  if (!Array.isArray(items)) return [{ message: items.message, invalid: true }];
  const given = new Map<string, string>();
  const priorities = new Map<string, number>();
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
  for (const ref of p.rules) {
    const key = `${qualifyName(ref.ruleSet, ref.id)}@${ref.version}`;
    cited.add(key);
    const checksum = given.get(key);
    if (checksum === undefined) invalid(`rule missing: ${citeName(key)}`);
    else if (checksum !== ref.checksum) invalid(`rule checksum mismatch: ${citeName(key)}`);
  }
  for (const key of given.keys()) {
    if (!cited.has(key)) invalid(`unexpected rule: ${citeName(key)}`);
  }
  // Given the definitions, a settled highestPriority fed by a pending rule is checked too.
  const priorityOf = (ruleId: string, version: number): number | undefined =>
    priorities.get(`${ruleId}@${version}`);
  for (const message of priorityProblems(p, priorityOf)) invalid(message);
  return findings;
}
