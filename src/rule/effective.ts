import { SpecError } from '../errors.js';
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
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new SpecError('INVALID_DATE', 'at must be a valid Date');
  }
  const time = at.getTime();
  const from = parseRuleDate(rule.effectiveFrom, 'effectiveFrom').getTime();
  if (time < from) return false;
  if (rule.effectiveUntil == null) return true;
  return time < parseRuleDate(rule.effectiveUntil, 'effectiveUntil').getTime();
}
