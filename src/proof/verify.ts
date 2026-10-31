import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import type { RuleDefinitionInput } from '../rule/definition.js';
import { normalizeRuleDefinition } from '../rule/normalize.js';
import { isPlainObject } from '../values.js';
import { contentDigest } from './digest.js';
import { keyBytes, signatureMatches } from './sign.js';
import type { DecisionProof, ProofVerification } from './types.js';
import { validateProof } from './validate.js';

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
 *    and nothing else is checked.
 * 2. The digest, recomputed from the content: `digest mismatch` makes it `invalid`.
 * 3. The signature. `unsigned`, or `untrusted key` (its `keyId` is not an own key of
 *    `trustedKeys`), or `trusted key malformed` (not 64 hex characters), leave it at best
 *    `consistent`: nothing proves who produced it. `signature invalid` makes it `invalid`.
 *    `trustedKeys` maps a key id to a hex ed25519 public key.
 * 4. With `rules`, the rules the decision claims to have received: the set of
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
 */
export function verifyProof(
  p: unknown,
  o?: { trustedKeys?: Record<string, string>; rules?: ReadonlyArray<RuleDefinitionInput> },
): ProofVerification {
  try {
    return verify(p, o);
  } catch (error) {
    // A hostile value (a Proxy, a throwing getter) can still throw while being read.
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 'invalid', issues: [`proof could not be read: ${reason}`] };
  }
}

function verify(p: unknown, options: unknown): ProofVerification {
  const { errors } = validateProof(p);
  if (!isWellFormed(p, errors)) return { status: 'invalid', issues: errors };

  const findings: Finding[] = [];
  if (contentDigest(p) !== p.digest) findings.push({ message: 'digest mismatch', invalid: true });
  if (options !== undefined && !isPlainObject(options)) {
    findings.push({ message: 'options must be an object { trustedKeys?, rules? }', invalid: true });
  }
  const trustedKeys = isPlainObject(options) ? options.trustedKeys : undefined;
  const rules = isPlainObject(options) ? options.rules : undefined;
  findings.push(...signatureFindings(p, trustedKeys));
  if (rules !== undefined) findings.push(...ruleFindings(p, rules));

  const issues = findings.map((finding) => finding.message);
  if (findings.some((finding) => finding.invalid)) return { status: 'invalid', issues };
  return { status: findings.length > 0 ? 'consistent' : 'authentic', issues };
}

/** `errors` are those `validateProof` found in `p`: none means `p` is a `DecisionProof`. */
function isWellFormed(p: unknown, errors: readonly string[]): p is DecisionProof {
  return errors.length === 0;
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
  const publicKey = keyBytes(trustedKeys[keyId]);
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
      // normalizeRuleDefinition validates any value; the cast only lets it be called.
      const definition = normalizeRuleDefinition(rule as RuleDefinitionInput);
      key = `${definition.id}@${definition.version}`;
      checksum = sha256Hex(canonicalize(definition));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      invalid(`rule invalid: rules[${i}]: ${reason}`);
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
