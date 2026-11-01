import { newSpecError, quoteText } from '../errors.js';
import { typeName } from '../values.js';

/**
 * How sure an output is (D-7), from the weakest doubt to the strongest:
 * - `determined`: every fact, date, dimension and output its rules read is certain;
 * - `provisional`: it rests on a fact asserted provisionally (proposed, contested or presumed),
 *   or on a rule whose reads are unknown;
 * - `conflict`: a tie was broken by `onConflict: 'first'`;
 * - `undetermined`: it has no value yet (a rule that feeds it is pending), or an `all` output
 *   that no rule reached and that declares no `empty`.
 */
export type OutputStatus = 'determined' | 'provisional' | 'conflict' | 'undetermined';

/** The output statuses from the weakest to the strongest (D-7). Frozen. */
export const OUTPUT_STATUSES: readonly OutputStatus[] = Object.freeze([
  'determined',
  'provisional',
  'conflict',
  'undetermined',
]);

/**
 * The stronger of two statuses, in the order of `OUTPUT_STATUSES`: what an output, or a rule's
 * decision, is when it rests on two things of these statuses.
 *
 * Throws `SpecError` (`INVALID_PROOF`) when either is not an output status:
 * `not an output status: "final" (expected one of determined, provisional, conflict,
 * undetermined)`.
 */
export function joinStatus(a: OutputStatus, b: OutputStatus): OutputStatus {
  return rankOf(a) >= rankOf(b) ? a : b;
}

function rankOf(status: unknown): number {
  const rank = OUTPUT_STATUSES.findIndex((item) => item === status);
  if (rank >= 0) return rank;
  const cited =
    typeof status === 'string' ? quoteText(status) : `a value of type ${typeName(status)}`;
  throw newSpecError(
    'INVALID_PROOF',
    `not an output status: ${cited} (expected one of ${OUTPUT_STATUSES.join(', ')})`,
  );
}
