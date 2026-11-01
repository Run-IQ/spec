import type { JsonValue } from '../canonical.js';
import { newSpecError, quoteText } from '../errors.js';
import { typeName, withValueBudget } from '../values.js';
import { compareCanonicalDecimals } from './decimal.js';
import { matchesValue, validDeclaration } from './output.js';
import { article } from './read-declaration.js';
import type { OutputDeclaration, OutputType } from './output.js';

/** The output types whose values have an order. */
const ORDERED: readonly OutputType[] = ['number', 'decimal', 'enum', 'date', 'dateTime'];

/**
 * -1, 0 or 1 as the value `a` comes before, with, or after the value `b` of the output
 * `declaration` declares: what `max` and `min` choose by, and what bounds compare with.
 * - `number`: numerically (`-0` and `0` are equal);
 * - `decimal`: by exact value, for any number of digits (`"9"` before `"10"`);
 * - `enum`: by rank in `values` (with `['minimal', 'limited', 'high']`, `'limited'` before
 *   `'high'`);
 * - `date` and `dateTime`: in time.
 *
 * Throws `SpecError` (`INVALID_RULE`) for a declaration `validateOutputDeclaration` refuses
 * (`invalid output declaration: …`); for a type without order (`a string output has no
 * order: …`); and for a value that is not one of the output, on either side
 * (`valueMatchesOutputType`: `cannot compare "medium": not a value of this enum output`).
 */
export function compareOutputValues(
  a: JsonValue,
  b: JsonValue,
  declaration: OutputDeclaration,
): -1 | 0 | 1 {
  const normal = withValueBudget(() => validDeclaration(declaration));
  const { type, values = [] } = normal;
  if (!ORDERED.includes(type)) {
    throw newSpecError(
      'INVALID_RULE',
      `${article(type)} ${type} output has no order: ` +
        'only number, decimal, enum, date and dateTime do',
    );
  }
  for (const value of [a, b]) {
    if (!matchesValue(value, normal)) {
      const cited =
        typeof value === 'string' ? quoteText(value) : `a value of type ${typeName(value)}`;
      throw newSpecError(
        'INVALID_RULE',
        `cannot compare ${cited}: not a value of this ${type} output`,
      );
    }
  }
  // `matchesValue` holds: a and b are numbers for a number, strings for every other type.
  switch (type) {
    case 'decimal':
      return compareCanonicalDecimals(String(a), String(b));
    case 'enum':
      return order(values.indexOf(String(a)), values.indexOf(String(b)));
    case 'number':
      return order(Number(a), Number(b));
    default:
      // A civil date and a canonical instant are fixed-width texts: their order is that of time.
      return order(String(a), String(b));
  }
}

/** -1, 0 or 1 as `x` is less than, equal to (`-0` equals `0`) or greater than `y`. */
function order<T extends number | string>(x: T, y: T): -1 | 0 | 1 {
  if (x < y) return -1;
  return x > y ? 1 : 0;
}
