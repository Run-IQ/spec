import type { JsonValue } from '../canonical.js';
import type { CivilDate } from '../time/civil.js';
import type { RuleDefinitionBase } from './definition.js';
import type { DimensionSpec } from './dimensions.js';

/**
 * The named fields of a rule ready for evaluation, so that `Omit`/`Pick` keep their types. Same content as `RuleDefinitionBase`, with:
 * - `effectiveFrom` / `effectiveUntil`: a civil date stays a `YYYY-MM-DD` string, an instant
 *   becomes a `Date` (half-open window, see `windowContains`);
 * - `params` and `condition.value` as `unknown`, so a plugin can narrow them;
 * - `extensions`: read only, as the rest;
 * - `checksum`: `computeRuleChecksum` of the definition.
 */
export interface ExecutableRuleBase extends Readonly<
  Omit<
    RuleDefinitionBase,
    | 'params'
    | 'condition'
    | 'effectiveFrom'
    | 'effectiveUntil'
    | 'dimensions'
    | 'tags'
    | 'extensions'
  >
> {
  readonly params: unknown;
  readonly condition?: { readonly dsl: string; readonly value: unknown };
  /** Inclusive start: a civil date, or an instant as a `Date`. */
  readonly effectiveFrom: CivilDate | Date;
  /** Exclusive end, of the same form as `effectiveFrom`; `null` for no end. */
  readonly effectiveUntil: CivilDate | Date | null;
  /** Always present, `{}` when the rule has no dimension; each spec in normal form. */
  readonly dimensions: Readonly<Record<string, DimensionSpec>>;
  /** Sorted, without duplicates. */
  readonly tags: readonly string[];
  /** What a plugin or a pack adds, by name; absent when there is none. */
  readonly extensions?: Readonly<Record<string, JsonValue>>;
  readonly checksum: string;
}

/**
 * A rule ready for evaluation: the named fields, and the plugin extensions under `extensions`.
 * A plugin narrows it, for example
 * `interface FiscalRule extends ExecutableRule { params: FiscalParams }`.
 */
export type ExecutableRule = ExecutableRuleBase;
