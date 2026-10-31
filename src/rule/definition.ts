import type { JsonValue } from '../canonical.js';
import type { JsonPointer } from '../path/pointer.js';
import type { CivilDate, Instant } from '../time/civil.js';
import type { RuleException } from './exceptions.js';

export interface RuleCondition {
  dsl: string;
  value: JsonValue;
}

/**
 * The named content fields of a rule, without the extension index signature, so that
 * `Omit`/`Pick` on it keep their types. Use `RuleDefinition` for a full definition.
 *
 * The bounds are both civil dates (`2025-01-01`) or both canonical instants
 * (`2025-01-01T00:00:00.000Z`), D-13: a civil date stays civil and is read in the rule's time
 * zone. The validity window is half-open: `[effectiveFrom, effectiveUntil)`. A rule is effective
 * at `at` when `effectiveFrom <= at` and (`effectiveUntil` is null or `at < effectiveUntil`):
 * `effectiveUntil` itself is EXCLUDED, so a successor can start exactly when its predecessor
 * ends. `windowContains` implements it, crossing civil dates and instants in a time zone.
 */
export interface RuleDefinitionBase {
  id: string;
  /** Positive integer. */
  version: number;
  model: string;
  params: JsonValue;
  condition?: RuleCondition;
  priority: number;
  /** Inclusive start: a civil date, or a canonical instant. */
  effectiveFrom: CivilDate | Instant;
  /** Exclusive end, of the same form as `effectiveFrom`; `null` for no end. */
  effectiveUntil: CivilDate | Instant | null;
  /**
   * The time zone of the window: `UTC`, `±HH:MM` or an IANA name (`isTimeZone`), written by
   * `normalizeTimeZone` (`+00:00` is `UTC`). Absent: the rule set's, then the engine's default.
   */
  timeZone?: string;
  /**
   * The reference date the window is compared with (D-12): `/$dates/<name>` (a named date of
   * the input), `/$item/<path>` (a date of the current item; needs `forEach`) or
   * `/$segment/from` (needs `forEach.segments`). Absent: the decision's reference date.
   */
  effectiveOn?: JsonPointer;
  output?: string;
  dimensions: Record<string, string>;
  /** Sorted, without duplicates. */
  tags: string[];
  dominanceGroup?: string;
  /**
   * In order, never empty: an empty list is normalized away, as absent. Selector lists are
   * sorted, without duplicates. See `RuleException`.
   */
  exceptions?: RuleException[];
  sourceRef?: string;
}

/**
 * A normalized rule definition: the named fields plus plugin extension fields at the top
 * level. Extensions enter the checksum and the fingerprint. `checksum` is never part of it.
 *
 * Null at the top level: for every optional named field (`condition`, `effectiveUntil`,
 * `timeZone`, `effectiveOn`, `output`, `dimensions`, `tags`, `dominanceGroup`, `exceptions`,
 * `sourceRef`) and every
 * extension field, `null`, `undefined` and absence are the same input, so the checksum and
 * fingerprint do not depend on how a database writes empty columns. Normalization drops them,
 * or writes the default (`effectiveUntil: null`, `dimensions: {}`, `tags: []`). An empty
 * `exceptions` list is absent too. A `null`
 * value inside `dimensions` likewise means the dimension is unset and its key is dropped
 * (other non-string values throw). Below the top
 * level (inside `params`, `condition.value`, `exceptions` and extension values), and for the
 * required `params` itself, `null` is data and is kept.
 */
export interface RuleDefinition extends RuleDefinitionBase {
  [extension: string]: unknown;
}

/**
 * Named fields accepted by `normalizeRuleDefinition`, before defaults and date conversion.
 * Every optional field (and every extension) accepts `null`, `undefined` or absence, which all
 * mean the same thing at the top level: see `RuleDefinition`.
 */
export interface RuleDefinitionInputBase {
  readonly id: string;
  readonly version: number;
  readonly model: string;
  readonly params: unknown;
  readonly condition?: { readonly dsl: string; readonly value: unknown } | null | undefined;
  readonly priority: number;
  /**
   * `YYYY-MM-DD` (stays a civil date), or an instant: a `Date` or
   * `YYYY-MM-DDTHH:MM:SS[.sss]` with `Z` or `±HH:MM` (see `toReferenceDate`).
   */
  readonly effectiveFrom: Date | string;
  /**
   * Same forms as `effectiveFrom`, and the same form as it (both civil or both instants);
   * absent, `undefined` or `null` means no end.
   */
  readonly effectiveUntil?: Date | string | null | undefined;
  /** `UTC`, `±HH:MM` or an IANA name; `+00:00` and `-00:00` are written `UTC`. */
  readonly timeZone?: string | null | undefined;
  /** `/$dates/<name>`, `/$item/<path>` (with `forEach`) or `/$segment/from`. */
  readonly effectiveOn?: string | null | undefined;
  readonly output?: string | null | undefined;
  /** A `null` or `undefined` value means the dimension is unset: the key is dropped. */
  readonly dimensions?: Readonly<Record<string, string | null | undefined>> | null | undefined;
  readonly tags?: readonly string[] | null | undefined;
  readonly dominanceGroup?: string | null | undefined;
  /** A list of `RuleException`; `[]` means absent. Checked by normalization. */
  readonly exceptions?: unknown;
  readonly sourceRef?: string | null | undefined;
  /** Ignored: removed by normalization. */
  readonly checksum?: string | null | undefined;
}

export interface RuleDefinitionInput extends RuleDefinitionInputBase {
  readonly [extension: string]: unknown;
}

/** Field names with a meaning defined by the spec; every other top-level key is an extension. */
export const RESERVED_RULE_FIELDS: readonly string[] = [
  'id',
  'version',
  'model',
  'params',
  'condition',
  'priority',
  'effectiveFrom',
  'effectiveUntil',
  'timeZone',
  'effectiveOn',
  'output',
  'dimensions',
  'tags',
  'dominanceGroup',
  'exceptions',
  'sourceRef',
  'checksum',
];

/** A rule version is a positive integer (`1`, `2`, ...). */
export function isRuleVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
