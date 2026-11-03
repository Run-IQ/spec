import { canonicalize } from '../canonical.js';
import type { JsonValue } from '../canonical.js';
import {
  citeName,
  isOwnOptionsError,
  newOptionsError,
  reasonOf,
  unreadableMessage,
} from '../errors.js';
import { boundMessages } from '../issues.js';
import {
  checkText,
  childPointer,
  expectPlainObject,
  markRead,
  readFields,
  requireFields,
  runCheck,
  walkJson,
} from '../input/read.js';
import type { Add, Fields, Reader } from '../input/read.js';
import { SIGNATURE_BASE64URL } from '../proof/fields.js';
import { signatureMatches } from '../proof/sign.js';
import { readTrustedKeys } from '../proof/trusted-keys.js';
import type { ProofVerification } from '../proof/types.js';
import { isInstant } from '../time/civil.js';
import { ownCopy, withValueBudget } from '../values.js';
import { ATTESTATION_FORMAT } from './types.js';
import type { Attestation, AttestationSubject } from './types.js';

/** Internal: a proof digest as `sealProof` writes it: 64 lowercase hex characters. */
export const HEX_DIGEST = /^[0-9a-f]{64}$/;

/** The kinds this version verifies (D-29); any other is `invalid`. */
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
 * Verifies a detached attestation (D-29) of the proof whose digest is `proofDigest`: anything
 * malformed in the attestation gives `invalid`; a mistake of the caller in the arguments throws
 * `VerifyOptionsError` (`INVALID_OPTIONS`). Issues are short, stable English strings.
 *
 * 1. The arguments, checked first: `proofDigest` must be 64 lowercase hex characters, `trustedKeys`
 *    an object mapping a key id to a hex ed25519 public key, or `undefined` (no key trusted);
 *    a digest that is not, `trustedKeys` that are not an object or cannot be read, a symbol or
 *    non-enumerable key, a malformed key, each throw (`proofDigest`, `trustedKeys`,
 *    `trustedKeys.<id>`).
 * 2. The shape. `a` is read once (each property read and counted exactly once) into a plain
 *    copy, and every later check runs on that copy: a closed object `{ format, kind, subject,
 *    keyId, role?, claims?, at, signature }`; a `format` other than `run-iq.attestation/1`
 *    gives the single issue `unknown format: <format>`; `kind`, `keyId` and `role` non-empty
 *    strings without lone surrogate; `subject` exactly one of `{ proofDigest }` (64 lowercase hex
 *    characters) and `{ keyId }` (a non-empty string); `at` a canonical instant; `signature` an
 *    ed25519 signature in unpadded base64url (86 characters). A `cosignature` needs
 *    `subject.proofDigest` (`cosignature needs subject.proofDigest`). `claims`, when present, is
 *    a plain JSON object checked as input values are (no lone surrogate, numbers below 2^53, at
 *    most 1000 levels, every value counted) and never interpreted; a cosignature takes none
 *    (`cosignature takes no claims`, its content not read). An object reachable from both
 *    `subject` and `claims` is read once, and both hold the same value. Each problem is named with
 *    its path (`/at must be …`, `/subject could not be read: <reason>`).
 * 3. The kind: one this version does not verify (`timestamp`, `revocation`, any later kind) makes
 *    it `invalid` (`attestation kind not supported: <kind>`): it is not a weak yes, and it is
 *    never read as an attestation of the proof. Its envelope is still checked, and its signature
 *    when its key is trusted (step 5), so every problem is listed.
 * 4. The subject: a `subject.proofDigest` other than `proofDigest` makes it `invalid`
 *    (`attestation for another proof`), and so does a `{ keyId }` subject, which is about a key
 *    and never about a proof digest (`attestation not about this proof`).
 * 5. The signature, against `canonicalize` of the attestation without `signature`: `untrusted
 *    key` (its `keyId` is not an own key of `trustedKeys`) leaves it at best `consistent`;
 *    `signature invalid` makes it `invalid`. A trusted key that is malformed was refused in
 *    step 1.
 *
 * `authentic` needs a cosignature of `proofDigest` whose signature a trusted key verifies,
 * with no issue. Every other attestation is `consistent` at best (an untrusted key) or
 * `invalid`. Its cost is linear in the size of the attestation: each property is read
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
    // The arguments are the caller's: a mistake in them throws, before the attestation is read.
    const fail = (option: string, message: string): never => {
      throw newOptionsError(option, message);
    };
    if (typeof proofDigest !== 'string' || !HEX_DIGEST.test(proofDigest)) {
      fail('proofDigest', 'the expected proof digest must be 64 lowercase hex characters');
    }
    const keys = readTrustedKeys(trustedKeys, 'trustedKeys', fail);
    // Defensive: `runCheck` opens the only budget spent today; this one keeps a later read
    // added outside it inside one budget per call (an equivalent mutant, kept on purpose).
    return withValueBudget(() => verify(a, proofDigest, keys));
  } catch (error) {
    if (isOwnOptionsError(error)) throw error;
    // Never reached by a value read under guard; a last net, still never a verdict of "valid".
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

function verify(a: unknown, proofDigest: string, keys: Map<string, Uint8Array>): ProofVerification {
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
    findings.push({ message, level: 'invalid' });
  }
  if (!('proofDigest' in read.subject)) {
    findings.push({ message: 'attestation not about this proof', level: 'invalid' });
  } else if (read.subject.proofDigest !== proofDigest) {
    findings.push({ message: 'attestation for another proof', level: 'invalid' });
  }
  findings.push(...signatureFinding(read, keys));
  const messages = findings.map((finding) => finding.message);
  if (findings.some((finding) => finding.level === 'invalid')) return invalid(messages);
  return { status: findings.length > 0 ? 'consistent' : 'authentic', issues: messages };
}

/**
 * What the signature of `a` (a copy) says under `keys` (the trusted keys, already checked: a
 * malformed one threw before this point); nothing when it holds.
 */
function signatureFinding(a: Attestation, keys: Map<string, Uint8Array>): Finding[] {
  const key = keys.get(a.keyId);
  if (key === undefined) return [{ message: 'untrusted key', level: 'warning' }];
  let message: string;
  try {
    message = attestationMessage(a);
  } catch (error) {
    // A text no string can hold once quoted: nothing that long was ever signed.
    return [{ message: `attestation too long to verify: ${reasonOf(error)}`, level: 'invalid' }];
  }
  if (!signatureMatches(message, a.signature, key)) {
    return [{ message: 'signature invalid', level: 'invalid' }];
  }
  return [];
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
  // Defensive: `verify` refuses any issue too; this keeps a copy from ever being built out of a
  // malformed read (an equivalent mutant, kept on purpose).
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
  const subject = checkSubject(fields, path, add);
  // The subject may be reachable from `claims` too: the claims walk takes this read, and the
  // same copy of it, instead of reading it a second time. It is marked under a member it holds
  // (read or failed to read); an object with no known member is not marked.
  const [member] = [...fields.values.keys(), ...fields.failed];
  if (member !== undefined) {
    markRead(reader, value, member, subject === undefined ? undefined : { ...subject });
  }
  return subject;
}

/** The subject held by `fields`, checked; `undefined` after reporting a problem. */
function checkSubject(fields: Fields, path: string, add: Add): AttestationSubject | undefined {
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
