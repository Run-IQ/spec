import { OUTPUT_STATUSES } from '../decision/status.js';
import { citeName, isOwnError, quoteText } from '../errors.js';
import { contextToInputPointer, parseReadPointer } from '../path/pointer.js';
import { isSubject } from '../path/subject.js';
import { isRuleVersion } from '../rule/definition.js';
import { dimensionValueProblem } from '../rule/dimensions.js';
import { citedNameProblem, isRuleSetId, packIdProblem, ruleSetIdMessage } from '../rule/ruleSet.js';
import { isCivilDate, isInstant, isTimeZone, normalizeTimeZone } from '../time/civil.js';
import { hasLoneSurrogate, loneSurrogateMessage } from '../values.js';
import { oneOf, scalarCheck, stringCheck } from './checks.js';
import type { Check } from './checks.js';

// Internal to `@run-iq/spec`: the checks of the scalar fields of a decision proof (ids, versions,
// salts, dates, pointers, subjects, statuses), from which its shapes are built (`shape.ts`).
/** 64 bytes in base64url without padding: 86 characters, the last one with 4 zero low bits. */
export const SIGNATURE_BASE64URL = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const SALT = /^[0-9a-f]{32}$/;
const CODE = /^[a-z0-9][a-z0-9_-]*$/;
export const DECLARED_BY = /^(?:engine|(?:plugin|model):[\s\S]+)$/;
/** The exclusions grouped into one entry when two instances or more of a rule have them. */
export const GROUPED_REASONS: readonly string[] = [
  'INACTIVE_DATE',
  'DIMENSION_MISMATCH',
  'TAG_MISMATCH',
  'NOT_REQUESTED',
];
export const SETTLED: readonly string[] = OUTPUT_STATUSES.filter(
  (status) => status !== 'undetermined',
);
const SUBJECT_FORM =
  'a JSON pointer whose ! segments are !group=<value> or !segment=<from>..<until>';

export const version = scalarCheck((value, path, add) => {
  if (!isRuleVersion(value)) add(path, `${citeName(path)} must be a positive integer`);
});

/** A stratum index: a safe integer, 0 or more. Whether `strata` has it is checked later. */
export const stratum = scalarCheck((value, path, add) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    add(path, `${citeName(path)} must be a non-negative integer`);
  }
});

export const salt = scalarCheck((value, path, add) => {
  if (typeof value !== 'string' || !SALT.test(value)) {
    add(path, `${citeName(path)} must be 16 bytes in lowercase hex (32 characters)`);
  }
});

export const code = stringCheck('a non-empty string', (text, path) =>
  CODE.test(text) ? undefined : `${citeName(path)} must be a code matching ${CODE.source}`,
);

/** A rule id inside its rule set: bare. */
export const ruleId = stringCheck('a non-empty string', (text, path) =>
  text.includes(':')
    ? `${citeName(path)} must not contain ":": a rule id is qualified by its rule set`
    : undefined,
);

/** A rule cited by its qualified id (D-37). */
export const citedRule = stringCheck('a non-empty string', (text, path) =>
  citedNameProblem(text, path, 'rule'),
);

/** An output cited by its qualified name. */
export const outputName = stringCheck('a non-empty string', (text, path) =>
  citedNameProblem(text, path, 'output'),
);

export const ruleSetId = scalarCheck((value, path, add) => {
  if (!isRuleSetId(value)) add(path, ruleSetIdMessage(path, value));
});

export const packId = scalarCheck((value, path, add) => {
  const problem = packIdProblem(value);
  if (problem !== undefined) add(path, `${citeName(path)}: ${problem}`);
});

export const timeZone = scalarCheck((value, path, add) => {
  if (typeof value !== 'string' || !isTimeZone(value)) {
    add(path, `${citeName(path)} must be UTC, ±HH:MM or an IANA name Area/Location`);
  } else if (normalizeTimeZone(value) !== value) {
    add(path, `${citeName(path)} must be written UTC: +00:00 and -00:00 are UTC`);
  }
});

export const evaluatedAt = scalarCheck((value, path, add) => {
  if (value !== null && !isCivilDate(value) && !isInstant(value)) {
    add(
      path,
      `${citeName(path)} must be null, a civil date YYYY-MM-DD or an instant ` +
        'YYYY-MM-DDTHH:MM:SS.sssZ',
    );
  }
});

export const instant = scalarCheck((value, path, add) => {
  if (!isInstant(value)) add(path, `${citeName(path)} must be an instant YYYY-MM-DDTHH:MM:SS.sssZ`);
});

export const subject = scalarCheck((value, path, add) => {
  if (!isSubject(value)) add(path, `${citeName(path)} must be a subject: ${SUBJECT_FORM}`);
  else if (hasLoneSurrogate(value)) add(path, loneSurrogateMessage(path));
});

/** A pointer of the evaluation context, as a rule reads it (`/$outputs/x` included). */
export const contextPointer = scalarCheck((value, path, add) => {
  const what = `${citeName(path)} must be a JSON pointer of the evaluation context`;
  if (typeof value !== 'string') return add(path, what);
  try {
    parseReadPointer(value);
  } catch (error) {
    return add(path, `${what}: ${isOwnError(error) ? error.message : 'unreadable'}`);
  }
  if (hasLoneSurrogate(value)) add(path, loneSurrogateMessage(path));
});

/** A pointer of the evaluation context to a fact of the input (`contextToInputPointer`). */
export const factPointer = scalarCheck((value, path, add) => {
  const what = `${citeName(path)} must be a pointer to an input fact`;
  if (typeof value !== 'string') return add(path, what);
  let input: string | undefined;
  try {
    input = contextToInputPointer(value);
  } catch (error) {
    return add(path, `${what}: ${isOwnError(error) ? error.message : 'unreadable'}`);
  }
  if (input === undefined) add(path, `${what}: ${quoteText(value)} is not in the input`);
  else if (hasLoneSurrogate(value)) add(path, loneSurrogateMessage(path));
});

/** The status of a rule's decision (`what`: step, exclusion, exception): never undetermined. */
export function settledStatus(what: string): Check {
  const known = oneOf(SETTLED);
  return (value, path, add) => {
    if (value === 'undetermined')
      add(path, `${citeName(path)}: ${what} status cannot be undetermined`);
    else known(value, path, add);
    return value;
  };
}

export const status = oneOf(OUTPUT_STATUSES);

export const dimensionValue = scalarCheck((value, path, add) => {
  const problem = dimensionValueProblem(value, path);
  if (problem !== undefined) add(path, problem);
});
