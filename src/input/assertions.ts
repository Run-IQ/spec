import { canonicalSha256Hex } from '../canonical.js';
import { citeName, isOwnError, newSpecError, quoteText, unreadableMessage } from '../errors.js';
import { parsePointer, parseReadPointer } from '../path/pointer.js';
import type { JsonPointer } from '../path/pointer.js';
import { isSubject } from '../path/subject.js';
import { citedNameProblem } from '../rule/ruleSet.js';
import { isCivilDate, isInstant } from '../time/civil.js';
import { ownCopy, withValueBudget } from '../values.js';
import {
  checkText,
  childPointer,
  expectPlainObject,
  readFields,
  requireFields,
  runCheck,
} from './read.js';
import type { Add, Reader } from './read.js';
import { ASSERTION_METHODS, ASSERTION_STATUSES } from './types.js';
import type { AssertionMethod, AssertionStatus, FactAssertion } from './types.js';

const ASSERTION_KEYS: readonly string[] = [
  'by',
  'method',
  'at',
  'status',
  'basis',
  'evidenceDigest',
  'confidence',
  'complete',
  'source',
];
const REQUIRED_KEYS: readonly string[] = ['by', 'method', 'at', 'status'];
const SOURCE_KEYS: readonly string[] = ['proofDigest', 'output', 'subject'];
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Internal: how messages write the two date forms of the input. */
export const DATE_FORMS = 'a civil date YYYY-MM-DD or an instant YYYY-MM-DDTHH:MM:SS.sssZ';

/**
 * The assertion that governs the value at the context pointer `pointer`: the one keyed by the
 * longest pointer whose segments start `pointer`'s (the pointer itself included), so a more
 * precise assertion overrides a broader one: with `/societe` → A and `/societe/ca` → B,
 * `/societe/ca/2025` is governed by B and `/societe/effectif` by A. An assertion at `''`
 * covers everything. Segments are compared, never text: `/societe` does not cover
 * `/societecorp`. `undefined` when none covers it.
 *
 * Only own keys count. `assertions` is expected valid (`validateProofInput`): a key that is not
 * a pointer never covers anything. Throws `SpecError` (`INVALID_PATH`) when `pointer` is not a
 * JSON pointer or holds a `-` segment (as an assertion key cannot: it names nothing), and
 * `SpecError` (`INVALID_INPUT`, `assertions could not be read: …`) when
 * `assertions` cannot be read (a getter or a Proxy trap that throws), never a raw error.
 *
 * Cost: `pointer` is parsed once (linear in its length), the own keys of `assertions` are listed
 * once, and each key is compared once with `pointer` (linear in the total length of the keys);
 * no prefix of `pointer` is built, so a pointer of 40 000 segments costs no more than its text.
 * The value of a covering key is read longest first, until one is not `undefined`.
 */
export function governingAssertion(
  assertions: Readonly<Record<JsonPointer, FactAssertion>>,
  pointer: JsonPointer,
): { pointer: JsonPointer; assertion: FactAssertion } | undefined {
  parseReadPointer(pointer);
  const keys = guarded('assertions', () => Reflect.ownKeys(assertions));
  // A valid pointer has one written form, so a key covers `pointer` exactly when its text
  // starts `pointer`'s at a segment boundary: no prefix of `pointer` is ever built.
  const covering = keys
    .filter((key): key is string => typeof key === 'string' && covers(key, pointer))
    .sort((a, b) => b.length - a.length);
  for (const key of covering) {
    const found = guarded('assertions', () => assertions[key]);
    if (found !== undefined) return { pointer: key, assertion: found };
  }
  return undefined;
}

/** True when the pointer `key` names `pointer` or one of its ancestors (segment-wise). */
function covers(key: string, pointer: string): boolean {
  if (!pointer.startsWith(key)) return false;
  return pointer.length === key.length || pointer.charCodeAt(key.length) === SLASH;
}

const SLASH = 0x2f;

/**
 * True when a decision resting on `assertion` can only be provisional (D-7): its status is
 * `proposed` or `contested`, or its method is `presumed` (a presumption holds until proven
 * otherwise, even once validated). Reads `status` and `method` once each; throws `SpecError`
 * (`INVALID_INPUT`, `assertion could not be read: …`) when they cannot be read.
 */
export function isProvisionalAssertion(assertion: FactAssertion): boolean {
  const { status, method } = guarded('assertion', () => ({
    status: assertion.status,
    method: assertion.method,
  }));
  return status === 'proposed' || status === 'contested' || method === 'presumed';
}

/**
 * `read()`, with any raw error it throws (a getter or a Proxy trap) turned into `SpecError`
 * (`INVALID_INPUT`, `<subject> could not be read: <reason>`).
 */
function guarded<T>(subject: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (isOwnError(error)) throw error;
    throw newSpecError('INVALID_INPUT', unreadableMessage(subject, error));
  }
}

/**
 * `sha256Hex(canonicalize(assertion))`: the digest a proof cites for the assertion that
 * governed a fact it read. Key order does not change it. `assertion` is read once and checked as
 * `validateProofInput` checks an assertion; throws `SpecError` (`INVALID_INPUT`) naming the
 * first problem (`invalid assertion: /method must be one of …`), never a raw error.
 */
export function computeAssertionDigest(assertion: FactAssertion): string {
  return withValueBudget(() => assertionDigest(assertion));
}

function assertionDigest(assertion: FactAssertion): string {
  let snapshot: FactAssertion | undefined;
  const { issues } = runCheck(
    (reader) => {
      snapshot = readAssertion(assertion, '', reader);
    },
    (error) => ({ path: '', message: unreadableMessage('assertion', error) }),
  );
  const [first] = issues;
  if (first !== undefined || snapshot === undefined) {
    throw newSpecError('INVALID_INPUT', `invalid assertion: ${first?.message ?? 'unreadable'}`);
  }
  const read = snapshot;
  // The copy's values were counted when they were read from `assertion`.
  return ownCopy(() => canonicalSha256Hex(read));
}

/**
 * Internal: the problem with `key` as a key of `meta.assertions`, or `undefined`: a JSON
 * pointer of the evaluation context, without a `-` segment (not an index), naming a fact
 * (`/revenue/total`), the named dates or one of them (`/$dates`, `/$dates/<name>`), the
 * dimensions or one of them (`/$dimensions`, `/$dimensions/<name>`; a name is never empty and
 * never starts with `$`), or everything (`''`). `key` holds no lone surrogate (checked before).
 */
export function assertionKeyProblem(key: string): string | undefined {
  const quoted = quoteText(key);
  let segments: string[];
  try {
    segments = parsePointer(key);
  } catch {
    return `assertion key ${quoted} must be a JSON pointer`;
  }
  if (segments.includes('-')) {
    return `assertion key ${quoted} must not hold "-": it is not an index`;
  }
  const [head, ...rest] = segments;
  if (head === undefined || !head.startsWith('$')) return undefined;
  const name = rest[0];
  // A date or dimension name is never empty and never starts with `$` (ruling 9G round 2).
  const named =
    (head === '$dates' || head === '$dimensions') &&
    (name === undefined || (rest.length === 1 && name !== '' && !name.startsWith('$')));
  return named
    ? undefined
    : `assertion key ${quoted} must name a fact, /$dates/<name> or /$dimensions/<name>`;
}

/**
 * Internal: reads the assertion at `path` once and checks it; returns its plain copy when it
 * has no problem, else `undefined` after reporting every problem.
 */
export function readAssertion(
  value: unknown,
  path: string,
  reader: Reader,
): FactAssertion | undefined {
  const label = path === '' ? 'assertion' : path;
  let valid = true;
  const add: Add = (at, message) => {
    valid = false;
    reader.add(at, message);
  };
  const shape =
    'an assertion { by, method, at, status, basis?, evidenceDigest?, confidence?, complete?, ' +
    'source? }';
  if (!expectPlainObject(value, path, shape, add, label)) return undefined;
  const fields = readFields(value, path, label, ASSERTION_KEYS, reader, { add });
  if (fields === undefined || fields.failed.size > 0) valid = false;
  if (fields === undefined) return undefined;
  requireFields(fields, path, REQUIRED_KEYS, add);
  const field = (key: string): unknown => fields.values.get(key);
  const has = (key: string): boolean => fields.values.has(key);
  const at = (key: string): string => childPointer(path, key);

  if (has('by')) checkText(field('by'), at('by'), add);
  const method = field('method');
  if (has('method') && !isAssertionMethod(method)) {
    add(at('method'), `${citeName(at('method'))} must be one of ${ASSERTION_METHODS.join(', ')}`);
  }
  const when = field('at');
  if (has('at') && !isCivilDate(when) && !isInstant(when)) {
    add(at('at'), `${citeName(at('at'))} must be ${DATE_FORMS}`);
  }
  const status = field('status');
  if (has('status') && !isAssertionStatus(status)) {
    add(at('status'), `${citeName(at('status'))} must be one of ${ASSERTION_STATUSES.join(', ')}`);
  }
  if (has('basis')) checkText(field('basis'), at('basis'), add);
  const evidence = field('evidenceDigest');
  if (has('evidenceDigest') && !isSha256(evidence)) {
    add(
      at('evidenceDigest'),
      `${citeName(at('evidenceDigest'))} must be a lowercase sha256 hex string`,
    );
  }
  const confidence = field('confidence');
  if (
    has('confidence') &&
    !(typeof confidence === 'number' && confidence >= 0 && confidence <= 1)
  ) {
    add(at('confidence'), `${citeName(at('confidence'))} must be a number from 0 to 1`);
  }
  const complete = field('complete');
  if (has('complete') && complete !== false) {
    add(
      at('complete'),
      `${citeName(at('complete'))} must be false: a list is complete by default: omit complete`,
    );
  }
  const source = readSourceField(fields.values, method, at('source'), add, reader);
  const by = field('by');
  const basis = field('basis');
  if (
    !valid ||
    typeof by !== 'string' ||
    !isAssertionMethod(method) ||
    !(isCivilDate(when) || isInstant(when)) ||
    !isAssertionStatus(status)
  ) {
    return undefined;
  }
  const snapshot: FactAssertion = { by, method, at: when, status };
  if (typeof basis === 'string') snapshot.basis = basis;
  if (typeof evidence === 'string') snapshot.evidenceDigest = evidence;
  if (typeof confidence === 'number') snapshot.confidence = confidence;
  if (complete === false) snapshot.complete = false;
  if (source !== undefined) snapshot.source = source;
  return snapshot;
}

function isAssertionMethod(value: unknown): value is AssertionMethod {
  return ASSERTION_METHODS.some((method) => method === value);
}

function isAssertionStatus(value: unknown): value is AssertionStatus {
  return ASSERTION_STATUSES.some((status) => status === value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/**
 * Checks `source` against `method`: required with `decision`, refused with any other valid
 * method; its shape is checked whenever it is present. Returns its copy when valid.
 */
function readSourceField(
  fields: ReadonlyMap<string, unknown>,
  method: unknown,
  path: string,
  add: Add,
  reader: Reader,
): FactAssertion['source'] {
  const present = fields.has('source');
  if (method === 'decision' && !present) {
    add(path, `${citeName(path)} is required with method "decision"`);
    return undefined;
  }
  if (!present) return undefined;
  if (method !== 'decision' && isAssertionMethod(method)) {
    add(path, `${citeName(path)} is only allowed with method "decision"`);
    return undefined;
  }
  return readSource(fields.get('source'), path, add, reader);
}

function readSource(
  value: unknown,
  path: string,
  add: Add,
  reader: Reader,
): FactAssertion['source'] {
  if (!expectPlainObject(value, path, 'an object { proofDigest, output, subject? }', add)) {
    return undefined;
  }
  const fields = readFields(value, path, path, SOURCE_KEYS, reader, { add });
  if (fields === undefined) return undefined;
  let valid = fields.failed.size === 0;
  const fail: Add = (at, message) => {
    valid = false;
    add(at, message);
  };
  requireFields(fields, path, ['proofDigest', 'output'], fail);
  const digest = fields.values.get('proofDigest');
  const digestPath = childPointer(path, 'proofDigest');
  if (fields.values.has('proofDigest') && !isSha256(digest)) {
    fail(digestPath, `${citeName(digestPath)} must be a lowercase sha256 hex string`);
  }
  const output = fields.values.get('output');
  const outputPath = childPointer(path, 'output');
  if (fields.values.has('output') && checkText(output, outputPath, fail)) {
    const problem = citedNameProblem(output, outputPath, 'output');
    if (problem !== undefined) fail(outputPath, problem);
  }
  const subject = fields.values.get('subject');
  const subjectPath = childPointer(path, 'subject');
  if (fields.values.has('subject') && !isSubject(subject)) {
    fail(
      subjectPath,
      `${citeName(subjectPath)} must be a subject: a JSON pointer whose reserved segments are ` +
        `well ` +
        'formed',
    );
  }
  if (!valid || !isSha256(digest) || typeof output !== 'string') return undefined;
  const source: NonNullable<FactAssertion['source']> = { proofDigest: digest, output };
  if (typeof subject === 'string') source.subject = subject;
  return source;
}
