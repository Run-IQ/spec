import { toJsonValue } from '../canonical.js';
import { describeError, unreadableMessage } from '../errors.js';
import { sha256Hex } from '../hash.js';
import type { RuleDefinition, RuleDefinitionInput } from '../rule/definition.js';
import { canonicalRulePayload } from '../rule/payload.js';
import { isPlainObject } from '../values.js';
import { contentDigest, inconsistencies } from './digest.js';
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
 *    and nothing else is checked. A `format` outside `PROOF_FORMATS` gives the single issue
 *    `unknown format: <format>`: this version cannot read a later format. The proof is then read once into a plain-JSON snapshot
 *    (each property read exactly once), validated again, and every later check runs on that
 *    snapshot only.
 * 2. The digest, recomputed from the content: `digest mismatch` makes it `invalid`.
 * 3. Internal consistency: every rule the proof cites (in `applied`, `skipped`, `exceptions`,
 *    output `contributors` and exception `affected`) must be listed in `rules`, otherwise
 *    `cited rule not listed: id@version` (or `: id` for the lists of ids) makes it `invalid`.
 *    So does every contradiction between `strata` and the rest of the proof:
 *    `stratum output unknown: name`, `stratum output repeated: name`,
 *    `output not in strata: name`, `stratum out of range: id@version` (an entry of `applied`,
 *    `skipped` or `exceptions` whose stratum `strata` does not have), and
 *    `step stratum mismatch: id@version` (an applied rule whose output is not in its stratum);
 *    `output name reserved: name` (an output key, stratum name or step output starting with
 *    `$`); and `decimal value not canonical: name` (a `decimal` output whose value, or an
 *    applied contribution or `unrounded` value for it, is not a canonical decimal string).
 * 4. The signature. `unsigned`, or `untrusted key` (its `keyId` is not an own key of
 *    `trustedKeys`), or `trusted key malformed` (not 64 hex characters, not a curve point, or
 *    a small-order point), leave it at best `consistent`: nothing proves who produced it.
 *    `signature invalid` makes it `invalid`. `trustedKeys` maps a key id to a hex ed25519
 *    public key.
 * 5. With `rules`, the rules the decision claims to have received: the set of
 *    `{ id, version, checksum }` of `rules` (each checksum recomputed as
 *    `sha256Hex(canonicalRulePayload(rule))`) must equal the set in `proof.rules`. Each
 *    difference makes it `invalid`: `rule missing: id@version` (in the proof, not given),
 *    `unexpected rule: id@version` (given, not in the proof), `rule checksum mismatch:
 *    id@version`, `duplicate rule: id@version`, `rule invalid: rules[i]: <reason>`.
 *
 * Malformed options (not an object, `trustedKeys` not an object, `rules` not an array) make it
 * `invalid` too, rather than being ignored.
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
    return verify(p, o);
  } catch (error) {
    // A hostile value (a Proxy, a throwing getter) can still throw while being read.
    return { status: 'invalid', issues: [unreadableMessage('proof', error)] };
  }
}

function verify(p: unknown, options: unknown): ProofVerification {
  const { proof, errors } = readDecisionProof(p);
  if (!proof) return { status: 'invalid', issues: errors };

  const findings: Finding[] = [];
  if (contentDigest(proof) !== proof.digest)
    findings.push({ message: 'digest mismatch', invalid: true });
  for (const message of inconsistencies(proof)) findings.push({ message, invalid: true });
  if (options !== undefined && !isPlainObject(options)) {
    findings.push({ message: 'options must be an object { trustedKeys?, rules? }', invalid: true });
  }
  const trustedKeys = isPlainObject(options) ? options.trustedKeys : undefined;
  const rules = isPlainObject(options) ? options.rules : undefined;
  findings.push(...signatureFindings(proof, trustedKeys));
  if (rules !== undefined) findings.push(...ruleFindings(proof, rules));

  const issues = findings.map((finding) => finding.message);
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

  const given = new Map<string, string>();
  Array.from(rules as unknown[]).forEach((rule, i) => {
    let key: string;
    let checksum: string;
    try {
      // One JSON snapshot of the rule (each property read once), then its canonical payload.
      // canonicalRulePayload validates any value; the cast only lets it be called.
      const payload = canonicalRulePayload(toJsonValue(rule, `rules[${i}]`) as RuleDefinitionInput);
      // The payload is the canonical JSON of a normalized definition.
      const definition = JSON.parse(payload) as RuleDefinition;
      key = `${definition.id}@${definition.version}`;
      checksum = sha256Hex(payload);
    } catch (error) {
      invalid(`rule invalid: rules[${i}]: ${describeError(error)}`);
      return;
    }
    if (given.has(key)) invalid(`duplicate rule: ${key}`);
    else given.set(key, checksum);
  });

  const cited = new Set<string>();
  for (const ref of p.rules) {
    const key = `${ref.id}@${ref.version}`;
    cited.add(key);
    const checksum = given.get(key);
    if (checksum === undefined) invalid(`rule missing: ${key}`);
    else if (checksum !== ref.checksum) invalid(`rule checksum mismatch: ${key}`);
  }
  for (const key of given.keys()) {
    if (!cited.has(key)) invalid(`unexpected rule: ${key}`);
  }
  return findings;
}
