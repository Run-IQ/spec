import { canonicalize } from '../canonical.js';
import type { JsonValue } from '../canonical.js';
import { citeName, reasonOf, unreadableMessage } from '../errors.js';
import { boundMessages } from '../issues.js';
import {
  checkText,
  childPointer,
  expectPlainObject,
  readFields,
  requireFields,
  runCheck,
  walkJson,
} from '../input/read.js';
import type { Add, Reader } from '../input/read.js';
import { SIGNATURE_BASE64URL } from '../proof/fields.js';
import { publicKeyBytes, signatureMatches } from '../proof/sign.js';
import type { ProofVerification } from '../proof/types.js';
import { isInstant } from '../time/civil.js';
import { isPlainObject, ownCopy, withValueBudget } from '../values.js';
import { ATTESTATION_FORMAT } from './types.js';
import type { Attestation, AttestationSubject } from './types.js';

/** Internal: a proof digest as `sealProof` writes it: 64 lowercase hex characters. */
export const HEX_DIGEST = /^[0-9a-f]{64}$/;

/** The kinds this version verifies (D-29); any other is at best `consistent`. */
const VERIFIED_KINDS: readonly string[] = ['cosignature'];

const KEYS: readonly string[] = [
  'format',
  'kind',
  'subject',
  'keyId',
  'role',
  'claims',
  'at',
  'signature',
];
const OPTIONAL: ReadonlySet<string> = new Set(['role', 'claims']);
const REQUIRED: readonly string[] = KEYS.filter((key) => !OPTIONAL.has(key));
const SUBJECT_KEYS: readonly string[] = ['proofDigest', 'keyId'];
const SHAPE = 'an object { format, kind, subject, keyId, role?, claims?, at, signature }';
const INSTANT_FORM = 'an instant in its canonical form YYYY-MM-DDTHH:MM:SS.sssZ';

/**
 * Verifies a detached attestation (D-29) of the proof whose digest is `proofDigest`, and never
 * throws: anything malformed gives `invalid`. Issues are short, stable English strings.
 *
 * 1. The arguments: `proofDigest` must be 64 lowercase hex characters, `trustedKeys` (read
 *    after the attestation) an object mapping a key id to a hex ed25519 public key, or
 *    `undefined` (no key trusted).
 * 2. The shape. `a` is read once (each property read and counted exactly once) into a plain
 *    copy, and every later check runs on that copy: a closed object `{ format, kind, subject,
 *    keyId, role?, at, signature }`; a `format` other than `run-iq.attestation/1` gives the
 *    single issue `unknown format: <format>`; `kind`, `keyId` and `role` non-empty strings
 *    without lone surrogate; `subject` exactly one of `{ proofDigest }` (64 lowercase hex
 *    characters) and `{ keyId }` (a non-empty string); `at` a canonical instant; `signature` an
 *    ed25519 signature in unpadded base64url (86 characters). A `cosignature` needs
 *    `subject.proofDigest` (`cosignature needs subject.proofDigest`). Each problem is named with
 *    its path (`/at must be …`, `/subject could not be read: <reason>`).
 * 3. The kind: one this version does not verify keeps it at best `consistent`
 *    (`attestation kind not supported: <kind>`). Its envelope and signature are still checked.
 * 4. The subject: a `subject.proofDigest` other than `proofDigest` makes it `invalid`
 *    (`attestation for another proof`).
 * 5. The signature, against `canonicalize` of the attestation without `signature`: `untrusted
 *    key` (its `keyId` is not an own key of `trustedKeys`) or `trusted key malformed` (not 64
 *    hex characters, not a curve point, a small-order point) leave it at best `consistent`;
 *    `signature invalid` makes it `invalid`.
 *
 * `authentic` needs a cosignature of `proofDigest` whose signature a trusted key verifies,
 * with no issue. Its cost is linear in the size of the attestation: each property is read
 * once, and the message signed is the canonical text of its members.
 *
 * The verdict is about the data read during the call: act on the copy it describes (take a JSON
 * copy first, verify it and use it).
 */
export function verifyAttestation(
  a: unknown,
  proofDigest: string,
  trustedKeys: Record<string, string>,
): ProofVerification {
  try {
    return withValueBudget(() => verify(a, proofDigest, trustedKeys));
  } catch (error) {
    // Never reached by a value read under guard; a last net, still never a throw.
    return invalid([unreadableMessage('attestation', error)]);
  }
}

/** An `invalid` verdict for `issues`. */
function invalid(issues: string[]): ProofVerification {
  return { status: 'invalid', issues: boundMessages(issues) };
}

interface Finding {
  readonly message: string;
  readonly level: 'invalid' | 'warning';
}

function verify(a: unknown, proofDigest: unknown, trustedKeys: unknown): ProofVerification {
  if (typeof proofDigest !== 'string' || !HEX_DIGEST.test(proofDigest)) {
    return invalid(['the expected proof digest must be 64 lowercase hex characters']);
  }
  let copy: Attestation | undefined;
  let unknownFormat: string | undefined;
  const { issues } = runCheck(
    (reader) => {
      const read = readAttestation(a, reader);
      if (typeof read === 'string') unknownFormat = read;
      else copy = read;
    },
    (error) => ({ path: '', message: unreadableMessage('attestation', error) }),
    { copy: true },
  );
  if (unknownFormat !== undefined) return invalid([`unknown format: ${unknownFormat}`]);
  if (issues.length > 0 || copy === undefined) {
    return invalid(issues.map((issue) => issue.message));
  }
  const read: Attestation = copy;
  const findings: Finding[] = [];
  if (!VERIFIED_KINDS.includes(read.kind)) {
    const message = `attestation kind not supported: ${citeName(read.kind)}`;
    findings.push({ message, level: 'warning' });
  }
  if ('proofDigest' in read.subject && read.subject.proofDigest !== proofDigest) {
    findings.push({ message: 'attestation for another proof', level: 'invalid' });
  }
  const signature = signatureFinding(read, trustedKeys);
  if (signature !== undefined) findings.push(signature);
  const messages = findings.map((finding) => finding.message);
  if (findings.some((finding) => finding.level === 'invalid')) return invalid(messages);
  return { status: findings.length > 0 ? 'consistent' : 'authentic', issues: messages };
}

/** What the signature of `a` (a copy) says under `trustedKeys`; `undefined` when it holds. */
function signatureFinding(a: Attestation, trustedKeys: unknown): Finding | undefined {
  let publicKey: unknown;
  try {
    if (trustedKeys !== undefined && !isPlainObject(trustedKeys)) {
      return { message: 'trustedKeys must be an object of hex public keys', level: 'invalid' };
    }
    if (trustedKeys === undefined || !Object.hasOwn(trustedKeys, a.keyId)) {
      return { message: 'untrusted key', level: 'warning' };
    }
    publicKey = trustedKeys[a.keyId];
  } catch (error) {
    return { message: unreadableMessage('trustedKeys', error), level: 'invalid' };
  }
  const key = publicKeyBytes(publicKey);
  if (!key) return { message: 'trusted key malformed', level: 'warning' };
  let message: string;
  try {
    message = attestationMessage(a);
  } catch (error) {
    // A text no string can hold once quoted: nothing that long was ever signed.
    return { message: `attestation too long to verify: ${reasonOf(error)}`, level: 'invalid' };
  }
  if (!signatureMatches(message, a.signature, key)) {
    return { message: 'signature invalid', level: 'invalid' };
  }
  return undefined;
}

/**
 * Internal: the message an attestation's signature covers: `canonicalize` of its members but
 * `signature`, as UTF-16 text (signed as UTF-8). `a` is a copy this package made: nothing is
 * counted again. Throws an own `SpecError` (`NON_SERIALIZABLE`) when the text is longer than
 * a string can hold.
 */
export function attestationMessage(a: object): string {
  const body: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  delete body.signature;
  return ownCopy(() => canonicalize(body));
}

/**
 * Reads the caller's attestation once into a copy, listing every problem of shape; the format
 * cited when it is a text other than `run-iq.attestation/1`.
 */
function readAttestation(value: unknown, reader: Reader): Attestation | string | undefined {
  const { add } = reader;
  if (!expectPlainObject(value, 'attestation', SHAPE, add)) return undefined;
  const fields = readFields(value, 'attestation', 'attestation', KEYS, reader, {
    join: (_path, key) => childPointer('', key),
  });
  if (fields === undefined) return undefined;
  requireFields(fields, '', REQUIRED, add);
  const field = (key: string): unknown => fields.values.get(key);
  const has = (key: string): boolean => fields.values.has(key);
  const format = field('format');
  if (typeof format === 'string' && format !== ATTESTATION_FORMAT) return citeName(format);
  if (has('format') && format !== ATTESTATION_FORMAT) add('/format', '/format must be a string');
  const kind = field('kind');
  if (has('kind')) checkText(kind, '/kind', add);
  const subject = has('subject') ? readSubject(field('subject'), reader) : undefined;
  if (kind === 'cosignature' && subject !== undefined && !('proofDigest' in subject)) {
    add('/subject', 'cosignature needs subject.proofDigest');
  }
  if (has('keyId')) checkText(field('keyId'), '/keyId', add);
  if (has('role')) checkText(field('role'), '/role', add);
  const claims = has('claims') ? readClaims(field('claims'), kind, reader) : undefined;
  if (has('at')) checkInstant(field('at'), '/at', add);
  const signature = field('signature');
  if (has('signature') && (typeof signature !== 'string' || !SIGNATURE_BASE64URL.test(signature))) {
    add(
      '/signature',
      '/signature must be an ed25519 signature in unpadded base64url (86 characters)',
    );
  }
  if (reader.issues.length > 0 || subject === undefined) return undefined;
  const role = field('role');
  return {
    format: ATTESTATION_FORMAT,
    kind: kind as string,
    subject,
    keyId: field('keyId') as string,
    ...(role === undefined ? {} : { role: role as string }),
    ...(claims === undefined ? {} : { claims }),
    at: field('at') as string,
    signature: signature as string,
  };
}

/**
 * The claims at `/claims`, read once into a plain copy (ruling 9K2-8): refused on a
 * `cosignature` (`cosignature takes no claims`, its content not read); otherwise a plain JSON
 * object, checked as input values are (`walkJson`: no lone surrogate, numbers below 2^53, at
 * most 1000 levels, every value counted in the budget) and never interpreted.
 */
function readClaims(
  value: unknown,
  kind: unknown,
  reader: Reader,
): { [key: string]: JsonValue } | undefined {
  const path = '/claims';
  if (kind === 'cosignature') {
    reader.add(path, 'cosignature takes no claims');
    return undefined;
  }
  if (!expectPlainObject(value, path, 'a plain JSON object', reader.add)) return undefined;
  const copy = walkJson(value, path, reader).copy;
  return copy as { [key: string]: JsonValue } | undefined;
}

/** The subject at `/subject`, read once: exactly one of its two members, checked. */
function readSubject(value: unknown, reader: Reader): AttestationSubject | undefined {
  const { add } = reader;
  const path = '/subject';
  if (!expectPlainObject(value, path, 'an object { proofDigest } or { keyId }', add)) {
    return undefined;
  }
  const fields = readFields(value, path, path, SUBJECT_KEYS, reader);
  if (fields === undefined) return undefined;
  if (fields.values.size + fields.failed.size !== 1) {
    add(path, `${path} must hold exactly one of proofDigest and keyId`);
    return undefined;
  }
  const proofDigest = fields.values.get('proofDigest');
  if (fields.values.has('proofDigest')) {
    if (typeof proofDigest === 'string' && HEX_DIGEST.test(proofDigest)) return { proofDigest };
    add(`${path}/proofDigest`, `${path}/proofDigest must be 64 lowercase hex characters`);
    return undefined;
  }
  const keyId = fields.values.get('keyId');
  if (fields.values.has('keyId') && checkText(keyId, `${path}/keyId`, add)) return { keyId };
  return undefined;
}

/** Internal: true for a canonical instant; reports any other value at `path`. */
export function checkInstant(value: unknown, path: string, add: Add): value is string {
  if (isInstant(value)) return true;
  add(path, `${citeName(path)} must be ${INSTANT_FORM}`);
  return false;
}
