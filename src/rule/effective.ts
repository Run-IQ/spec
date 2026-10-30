import { SpecError } from '../errors.js';
import { dateTimeOf } from '../values.js';
import { parseRuleDate } from './date.js';

/**
 * Half-open validity window `[effectiveFrom, effectiveUntil)`: true when
 * `from <= at && (until == null || at < until)`. `effectiveUntil` is EXCLUDED.
 * Dates accept the same forms as `normalizeRuleDefinition`; an invalid one throws
 * `SpecError` (`INVALID_DATE`).
 */
export function isEffectiveAt(
  rule: {
    readonly effectiveFrom: Date | string;
    readonly effectiveUntil?: Date | string | null | undefined;
  },
  at: Date,
): boolean {
  const time = dateTimeOf(at);
  if (time === undefined || Number.isNaN(time)) {
    throw new SpecError('INVALID_DATE', 'at must be a valid Date');
  }
  const from = parseRuleDate(rule.effectiveFrom, 'effectiveFrom').getTime();
  if (time < from) return false;
  if (rule.effectiveUntil == null) return true;
  return time < parseRuleDate(rule.effectiveUntil, 'effectiveUntil').getTime();
}
