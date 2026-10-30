import type { JsonValue } from '../canonical.js';

export interface RuleCondition {
  dsl: string;
  value: JsonValue;
}

/**
 * The named content fields of a rule, without the extension index signature, so that
 * `Omit`/`Pick` on it keep their types. Use `RuleDefinition` for a full definition.
 *
 * Dates are full UTC ISO 8601 strings (`2025-01-01T00:00:00.000Z`).
 * The validity window is half-open: `[effectiveFrom, effectiveUntil)`. A rule is effective at
 * `at` when `effectiveFrom <= at` and (`effectiveUntil` is null or `at < effectiveUntil`):
 * `effectiveUntil` itself is EXCLUDED, so a successor can start exactly when its predecessor
 * ends. `isEffectiveAt` implements it.
 */
export interface RuleDefinitionBase {
  id: string;
  version: number;
  model: string;
  params: JsonValue;
  condition?: RuleCondition;
  priority: number;
  /** Inclusive start, full UTC ISO string. */
  effectiveFrom: string;
  /** Exclusive end, full UTC ISO string; `null` for no end. */
  effectiveUntil: string | null;
  output?: string;
  dimensions: Record<string, string>;
  /** Sorted, without duplicates. */
  tags: string[];
  dominanceGroup?: string;
  exceptions?: JsonValue;
  sourceRef?: string;
}

/**
 * A normalized rule definition: the named fields plus plugin extension fields at the top
 * level. Extensions enter the checksum and the fingerprint. `checksum` is never part of it.
 *
 * Null at the top level: for every optional named field (`condition`, `effectiveUntil`,
 * `output`, `dimensions`, `tags`, `dominanceGroup`, `exceptions`, `sourceRef`) and every
 * extension field, `null`, `undefined` and absence are the same input, so the checksum and
 * fingerprint do not depend on how a database writes empty columns. Normalization drops them,
 * or writes the default (`effectiveUntil: null`, `dimensions: {}`, `tags: []`). A `null`
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
  /** `Date`, `YYYY-MM-DD` (UTC midnight) or an ISO date-time with `Z` or an offset. */
  readonly effectiveFrom: Date | string;
  /** Same forms as `effectiveFrom`; absent, `undefined` or `null` means no end. */
  readonly effectiveUntil?: Date | string | null | undefined;
  readonly output?: string | null | undefined;
  /** A `null` or `undefined` value means the dimension is unset: the key is dropped. */
  readonly dimensions?: Readonly<Record<string, string | null | undefined>> | null | undefined;
  readonly tags?: readonly string[] | null | undefined;
  readonly dominanceGroup?: string | null | undefined;
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
  'output',
  'dimensions',
  'tags',
  'dominanceGroup',
  'exceptions',
  'sourceRef',
  'checksum',
];
