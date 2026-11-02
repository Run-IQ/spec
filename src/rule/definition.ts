import type { JsonValue } from '../canonical.js';
import type { JsonPointer } from '../path/pointer.js';
import type { CivilDate, Instant } from '../time/civil.js';
import type { DimensionSpec, DimensionSpecInput } from './dimensions.js';
import type { RuleException } from './exceptions.js';
import type { ForEach } from './forEach.js';

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
  /** Never holds `:`, which separates a rule set from a name (D-4). */
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
  /**
   * What the rule iterates over (`ForEach`): it applies once per element of a collection, per
   * group or per time segment, each instance with its subject. Absent: the rule applies once.
   */
  forEach?: ForEach;
  /**
   * The rule set (pack) of the rule, `^[a-z0-9][a-z0-9_-]*$` (D-4, no `.`). Absent for a local
   * rule: `ruleSet: 'local'` (`LOCAL_RULE_SET`) is normalized away. The names a rule cites bare
   * (`output`, selector `ids` and `outputs`) designate its own rule set (D-37).
   */
  ruleSet?: string;
  /**
   * The output the rule feeds: `name` or `<rule set>:<name>` (one `:`, D-4), never starting with
   * `$` (reserved) nor holding `.`. A bare name designates the rule's own rule set; a name
   * qualified by it is written bare. Absent: the default output (`value`).
   */
  output?: string;
  /**
   * What the rule asks of each dimension of the input, in normal form (`DimensionSpec`): a value
   * compared by equality, or `{ ref?, anyOf, except?, match? }`.
   */
  dimensions: Record<string, DimensionSpec>;
  /** Sorted, without duplicates. */
  tags: string[];
  dominanceGroup?: string;
  /**
   * In order, never empty: an empty list is normalized away, as absent. Selector lists are
   * sorted, without duplicates. See `RuleException`.
   */
  exceptions?: RuleException[];
  sourceRef?: string;
  /**
   * What a plugin or a pack adds to the rule, by name. It is the only place for a field the
   * spec does not define: an unknown top-level field is refused (`unknown rule field`), so a
   * misspelled name never loses its meaning silently. The checksum and the fingerprint cover
   * it. An empty `extensions` is absent. Inside it, `null` is data.
   */
  extensions?: Record<string, JsonValue>;
}

/**
 * A normalized rule definition. Extensions are under `extensions`, never at the top level.
 * `checksum` is never part of it.
 *
 * Null at the top level: the format has no `null` to write, so `null` is refused for
 * every optional field, `effectiveUntil` and `checksum` included (`<field> is null: omit the
 * field instead`), and so is a `null` dimension in `dimensions`: a lost column never widens a
 * rule. "No end" is written by omitting `effectiveUntil`. `undefined` and absence are the same
 * input, and normalization writes the defaults (`dimensions: {}`, `tags: []`). There are two
 * forms: what an author writes never holds `null`; the normalized form (`RuleDefinition`)
 * holds `effectiveUntil: null` as its internal encoding of "no end", and the functions that
 * read it back accept that one `null` (the list is in the README, "Rule definition"). An empty
 * `exceptions` list or `extensions` object is absent too, and so is `ruleSet: 'local'`. Below
 * the top level (inside `params`, `condition.value`, `forEach`, `exceptions` and below the
 * first level of `extensions`), and for the
 * required `params` itself, `null` is data and is kept (and refused where the format has no
 * place for it, as in `forEach`).
 */
export type RuleDefinition = RuleDefinitionBase;

/**
 * Named fields accepted by `normalizeRuleDefinition`, before defaults and date conversion.
 * Every optional field accepts `undefined` or absence, which mean the same thing; `null` is
 * refused, `effectiveUntil` and `checksum` included: see `RuleDefinition`.
 */
export interface RuleDefinitionInputBase {
  readonly id: string;
  readonly version: number;
  readonly model: string;
  readonly params: unknown;
  readonly condition?: { readonly dsl: string; readonly value: unknown } | undefined;
  readonly priority: number;
  /**
   * `YYYY-MM-DD` (stays a civil date), or an instant: a `Date` or
   * `YYYY-MM-DDTHH:MM:SS[.sss]` with `Z` or `±HH:MM` (see `toReferenceDate`).
   */
  readonly effectiveFrom: Date | string;
  /**
   * Same forms as `effectiveFrom`, and the same form as it (both civil or both instants);
   * absent or `undefined` means no end. `null` is refused as authored (omit the field); it is
   * the internal form of a normalized rule, accepted where one is read back.
   */
  readonly effectiveUntil?: Date | string | null | undefined;
  /** `UTC`, `±HH:MM` or an IANA name; `+00:00` and `-00:00` are written `UTC`. */
  readonly timeZone?: string | undefined;
  /** `/$dates/<name>`, `/$item/<path>` (with `forEach`) or `/$segment/from`. */
  readonly effectiveOn?: string | undefined;
  /** A `ForEach`; a one-level `key` list may be written as a list. Checked by normalization. */
  readonly forEach?: unknown;
  /** A rule set id; `'local'` means absent. */
  readonly ruleSet?: string | undefined;
  readonly output?: string | undefined;
  /**
   * A `DimensionSpec` per dimension, in any written order; an `undefined` value means the
   * dimension is unset: the key is dropped. A `null` is refused.
   */
  readonly dimensions?: Readonly<Record<string, DimensionSpecInput | undefined>> | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly dominanceGroup?: string | undefined;
  /** A list of `RuleException`; `[]` means absent. Checked by normalization. */
  readonly exceptions?: unknown;
  readonly sourceRef?: string | undefined;
  /** Whatever a plugin or a pack adds, by name: a plain object, covered by the checksum. */
  readonly extensions?: Readonly<Record<string, unknown>> | undefined;
  /** Ignored: removed by normalization. `null` is refused as authored, accepted read back. */
  readonly checksum?: string | null | undefined;
}

export type RuleDefinitionInput = RuleDefinitionInputBase;

/**
 * Field names with a meaning defined by the spec. Any other top-level key is refused
 * (`unknown rule field`): what a plugin adds goes under `extensions`.
 */
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
  'forEach',
  'ruleSet',
  'output',
  'dimensions',
  'tags',
  'dominanceGroup',
  'exceptions',
  'sourceRef',
  'extensions',
  'checksum',
];

/** A rule version is a positive integer (`1`, `2`, ...). */
export function isRuleVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
