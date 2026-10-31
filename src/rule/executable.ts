import type { CivilDate } from '../time/civil.js';
import type { RuleDefinitionBase } from './definition.js';

/**
 * The named fields of a rule ready for evaluation, without the extension index signature, so
 * that `Omit`/`Pick` keep their types. Same content as `RuleDefinitionBase`, with:
 * - `effectiveFrom` / `effectiveUntil`: a civil date stays a `YYYY-MM-DD` string, an instant
 *   becomes a `Date` (half-open window, see `windowContains`);
 * - `params` and `condition.value` as `unknown`, so a plugin can narrow them;
 * - `checksum`: `computeRuleChecksum` of the definition.
 */
export interface ExecutableRuleBase extends Readonly<
  Omit<
    RuleDefinitionBase,
    'params' | 'condition' | 'effectiveFrom' | 'effectiveUntil' | 'dimensions' | 'tags'
  >
> {
  readonly params: unknown;
  readonly condition?: { readonly dsl: string; readonly value: unknown };
  /** Inclusive start: a civil date, or an instant as a `Date`. */
  readonly effectiveFrom: CivilDate | Date;
  /** Exclusive end, of the same form as `effectiveFrom`; `null` for no end. */
  readonly effectiveUntil: CivilDate | Date | null;
  /** Always present, `{}` when the rule has no dimension. */
  readonly dimensions: Readonly<Record<string, string>>;
  /** Sorted, without duplicates. */
  readonly tags: readonly string[];
  readonly checksum: string;
}

/**
 * A rule ready for evaluation: the named fields plus plugin extension fields at the top level.
 * A plugin narrows it by extension, for example
 * `interface FiscalRule extends ExecutableRule { params: FiscalParams }`.
 */
export interface ExecutableRule extends ExecutableRuleBase {
  readonly [extension: string]: unknown;
}
