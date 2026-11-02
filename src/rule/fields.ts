import { citeName } from '../errors.js';
import { RESERVED_RULE_FIELDS } from './definition.js';

/** The reserved names by their lowercase form, in the order of `RESERVED_RULE_FIELDS`. */
const LOWERCASE: ReadonlyArray<readonly [string, string]> = RESERVED_RULE_FIELDS.map((name) => [
  name,
  name.toLowerCase(),
]);

/**
 * Internal: whether `a` and `b` differ by at most one edit: a letter more, a letter less, a
 * letter changed, or two neighbouring letters swapped. Equal texts differ by none.
 */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  return longer.slice(i + 1) === shorter.slice(i);
}

/**
 * Internal: the first reserved field `key` is within one edit of, case ignored (so a name that
 * differs by case only, `dominancegroup`, is found); `undefined` when none.
 */
function misspellingOf(key: string): string | undefined {
  const lower = key.toLowerCase();
  return LOWERCASE.find(([, reserved]) => oneEditApart(reserved, lower))?.[0];
}

/**
 * Internal: the message refusing the top-level key `key` of a rule, which is not a reserved
 * field: `unknown rule field: dominancegroup (did you mean dominanceGroup?)`. Extensions live
 * under `extensions`, so a key outside the reserved fields is a mistake, never an extension.
 */
export function unknownRuleFieldMessage(key: string): string {
  const wanted = misspellingOf(key);
  const suffix = wanted === undefined ? '' : ` (did you mean ${wanted}?)`;
  return `unknown rule field: ${citeName(key)}${suffix}`;
}

/** Internal: the message refusing a `null` where the field must be omitted instead. */
export function nullFieldMessage(path: string): string {
  return `${citeName(path)} is null: omit the field instead`;
}

/** Internal: the message refusing an `extensions` that is not an object. */
export const EXTENSIONS_NOT_OBJECT = 'extensions must be an object';
