import { reservedOutputNameMessage } from '../decision/output.js';
import { citeName, newSpecError, quoteText } from '../errors.js';
import { isReservedName } from '../reserved.js';
import { typeName } from '../values.js';

/**
 * The name of the rule set of the rules that belong to no pack (D-4). A rule without `ruleSet`
 * is a `local` rule; `ruleSet: 'local'` is the same rule, and normalization drops it. No pack can
 * take this id (`isPackId`).
 */
export const LOCAL_RULE_SET = 'local';

const RULE_SET_ID = /^[a-z0-9][a-z0-9_-]*$/;
/** Internal: the grammar of a rule set id, as messages write it. */
export const RULE_SET_GRAMMAR = '^[a-z0-9][a-z0-9_-]*$';

/**
 * Internal: the named issue of a rule set id holding `.`. A version is never part of the id, and
 * an id without `.` keeps every qualified name (`<rule set>:<name>`) readable by every DSL.
 */
const NO_DOT = 'must not contain ".": a version is never part of a rule set id';

/** Internal: the problem of a string that is not a rule set id, after its subject. */
function idProblem(value: string): string {
  return value.includes('.') ? NO_DOT : `must match ${RULE_SET_GRAMMAR}`;
}

/**
 * True for a rule set id (D-4, tightened): `^[a-z0-9][a-z0-9_-]*$`, `local` included. No `.`:
 * a version is never part of the id, so every qualified name stays readable by every DSL.
 * Never throws.
 */
export function isRuleSetId(value: unknown): value is string {
  return typeof value === 'string' && RULE_SET_ID.test(value);
}

/**
 * True for the id of a pack: a rule set id other than `local`, which names the rules without a
 * rule set (a pack named `local` would mix its rules with them). Never throws.
 */
export function isPackId(value: unknown): value is string {
  return packIdProblem(value) === undefined;
}

/**
 * What is wrong with `value` as a pack id, or `undefined` (see `isPackId`): `local` is reserved
 * (`pack id "local" is reserved: it names the rules without a rule set`), and an id must match
 * `^[a-z0-9][a-z0-9_-]*$` (`pack id "p.v2" must not contain ".": a version is never part of a
 * rule set id`). Never throws.
 */
export function packIdProblem(value: unknown): string | undefined {
  if (typeof value !== 'string') return `a pack id must be a string, got ${describeType(value)}`;
  if (value === LOCAL_RULE_SET) {
    return 'pack id "local" is reserved: it names the rules without a rule set';
  }
  return RULE_SET_ID.test(value) ? undefined : `pack id ${quoteText(value)} ${idProblem(value)}`;
}

/**
 * The name `name` of the rule set `ruleSet` takes outside it (D-4, D-37): a `local` name stays
 * bare (`qualifyName('local', 'x')` is `'x'`), any other is `<ruleSet>:<name>`
 * (`qualifyName('rgpd', 'profilage')` is `'rgpd:profilage'`). Throws `SpecError`
 * (`INVALID_RULE`) when `ruleSet` is not a rule set id, or `name` is not a bare name (empty, or
 * holding `:`).
 */
export function qualifyName(ruleSet: string, name: string): string {
  if (typeof ruleSet !== 'string') {
    nameError(`a rule set id must be a string, got ${describeType(ruleSet)}`);
  }
  if (!RULE_SET_ID.test(ruleSet)) {
    nameError(
      ruleSet.includes('.')
        ? `${quoteText(ruleSet)} ${NO_DOT}`
        : `${quoteText(ruleSet)} is not a rule set id (${RULE_SET_GRAMMAR})`,
    );
  }
  if (typeof name !== 'string') nameError(`a name must be a string, got ${describeType(name)}`);
  if (name === '' || name.includes(':')) {
    nameError(`${quoteText(name)} is not a bare name: it is empty or holds ":"`);
  }
  return ruleSet === LOCAL_RULE_SET ? name : `${ruleSet}:${name}`;
}

function nameError(message: string): never {
  throw newSpecError('INVALID_RULE', `qualifyName: ${message}`);
}

function describeType(value: unknown): string {
  return `a value of type ${typeName(value)}`;
}

/**
 * Internal: `name`, cited from a rule of `ruleSet`, in its full form: a qualified name as it is,
 * a bare one qualified by `ruleSet` (D-37). Throws like `qualifyName`.
 */
export function qualifiedFrom(ruleSet: string, name: string): string {
  return name.includes(':') ? name : qualifyName(ruleSet, name);
}

/**
 * Internal: `name`, cited from a rule of `ruleSet`, in its shortest form: a name qualified by
 * `ruleSet` itself is written bare, since a bare name already designates `ruleSet` (D-37). One
 * meaning, one spelling, one checksum. `name` must be valid (`citedNameProblem`).
 */
export function shortestFrom(ruleSet: string, name: string): string {
  const colon = name.indexOf(':');
  return colon >= 0 && name.slice(0, colon) === ruleSet ? name.slice(colon + 1) : name;
}

/** Internal: the rule set a valid cited `name` designates from a rule of `ruleSet`. */
export function ruleSetOf(ruleSet: string, name: string): string {
  const colon = name.indexOf(':');
  return colon >= 0 ? name.slice(0, colon) : ruleSet;
}

/**
 * Internal: the message refusing `value`, which is not a rule set id, at `path`: the named issue
 * of a `.` (a version) for a string holding one, else the grammar.
 */
export function ruleSetIdMessage(path: string, value: unknown): string {
  return typeof value === 'string' && value.includes('.')
    ? `${citeName(path)} ${NO_DOT}`
    : `${citeName(path)} must be a rule set id matching ${RULE_SET_GRAMMAR}`;
}

/**
 * Internal: what is wrong with `name` (a non-empty string) as a cited name, written bare or
 * `<rule set>:<name>` (D-4), or `undefined`. The rule set part is a rule set id other than
 * `local` (a local name is always written bare); the name part is non-empty. With `output`, the
 * name is an output name: no `.` anywhere (JSONLogic `var` would read it as a path), and no `$`
 * at the start of either part (reserved, R36). Each message starts with `<path> name`, except
 * the one of a leading `$` (ruling R36's message).
 */
export function citedNameProblem(
  name: string,
  path: string,
  kind: 'output' | 'rule',
): string | undefined {
  if (kind === 'output') {
    if (isReservedName(name)) return reservedOutputNameMessage(path);
    if (name.includes('.')) return `${citeName(path)} name must not contain "."`;
  }
  const parts = name.split(':');
  if (parts.length === 1) return undefined;
  if (parts.length > 2) {
    return `${citeName(path)} name must hold at most one ":": <rule set>:<name>`;
  }
  const [set = '', bare = ''] = parts;
  if (set === LOCAL_RULE_SET) {
    return `${citeName(path)} name must not be qualified by "local": a local name is written bare`;
  }
  if (!RULE_SET_ID.test(set)) {
    return `${citeName(path)} name must start with a rule set id before ":": ${RULE_SET_GRAMMAR}`;
  }
  if (bare === '') {
    return (
      `${citeName(path)} name must name ${kind === 'output' ? 'an output' : 'a rule'} ` +
      `after ":"`
    );
  }
  if (kind === 'output' && isReservedName(bare)) {
    return (
      `${citeName(path)} name must not start with "$" after ":": ` +
      'output names starting with "$" are reserved'
    );
  }
  return undefined;
}
