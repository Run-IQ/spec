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
 */
export interface RuleDefinition extends RuleDefinitionBase {
  [extension: string]: unknown;
}

/** Named fields accepted by `normalizeRuleDefinition`, before defaults and date conversion. */
export interface RuleDefinitionInputBase {
  readonly id: string;
  readonly version: number;
  readonly model: string;
  readonly params: unknown;
  readonly condition?: { readonly dsl: string; readonly value: unknown } | undefined;
  readonly priority: number;
  /** `Date`, `YYYY-MM-DD` (UTC midnight) or an ISO date-time with `Z` or an offset. */
  readonly effectiveFrom: Date | string;
  /** Same forms as `effectiveFrom`; absent, `undefined` or `null` means no end. */
  readonly effectiveUntil?: Date | string | null | undefined;
  readonly output?: string | undefined;
  readonly dimensions?: Readonly<Record<string, string>> | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly dominanceGroup?: string | undefined;
  readonly exceptions?: unknown;
  readonly sourceRef?: string | undefined;
  /** Ignored: removed by normalization. */
  readonly checksum?: string | undefined;
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
