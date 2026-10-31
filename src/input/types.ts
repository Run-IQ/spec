import type { JsonValue } from '../canonical.js';
import type { JsonPointer } from '../path/pointer.js';
import type { Subject } from '../path/subject.js';
import type { CivilDate, Instant } from '../time/civil.js';

/**
 * How a fact was established:
 * - `human`: a person stated or checked it; `ai`: an AI system produced it;
 * - `document`: read from a document (`evidenceDigest` can hold its digest);
 * - `presumed`: a legal presumption, which a contrary proof can overturn;
 * - `declared`: declared by the person concerned; `measured`: measured by an instrument;
 * - `estimated`: estimated; `derived`: computed from other facts;
 * - `decision`: the output of another decision, cited by `source`.
 */
export type AssertionMethod =
  | 'human'
  | 'ai'
  | 'document'
  | 'presumed'
  | 'declared'
  | 'measured'
  | 'estimated'
  | 'derived'
  | 'decision';

/** Where the fact stands: `proposed` (not yet checked), `validated` or `contested`. */
export type AssertionStatus = 'proposed' | 'validated' | 'contested';

/**
 * Who established a fact, how, when, and how firmly. An assertion is keyed in
 * `ProofInput.meta.assertions` by the context pointer of what it covers (`/revenue`,
 * `/$dates/facture`, `/$dimensions/pays`, `''` for everything); it covers that value and its
 * descendants, unless a more precise assertion covers them (`governingAssertion`).
 *
 * - `by`: who asserted it (an opaque identifier, never a person's data);
 * - `at`: when, a civil date or an instant (`YYYY-MM-DDTHH:MM:SS.sssZ`);
 * - `basis`: the ground, a legal reference or a reason;
 * - `evidenceDigest`: the lowercase sha256 hex of the evidence, kept elsewhere;
 * - `confidence`: from 0 to 1, as the asserter rated it;
 * - `complete`: on a collection, whether it lists every element (`false`: an unknown element
 *   may be missing);
 * - `source`: with `method: 'decision'` only, and required with it: the proof digest of the
 *   decision, the output it gave (qualified by its rule set unless `local`) and the subject of
 *   the element, for an output per element.
 */
export interface FactAssertion {
  by: string;
  method: AssertionMethod;
  at: CivilDate | Instant;
  status: AssertionStatus;
  basis?: string;
  evidenceDigest?: string;
  confidence?: number;
  complete?: boolean;
  source?: { proofDigest: string; output: string; subject?: Subject };
}

/**
 * One period of a temporal fact: `value` holds over the civil days `[from, until)`; `until:
 * null` has no end. A temporal fact is a `TemporalValue[]`, its periods sorted by `from` and
 * never overlapping; a gap between two periods is a time without a value
 * (`validateTemporalFact`).
 */
export interface TemporalValue {
  from: CivilDate;
  until: CivilDate | null;
  value: JsonValue;
}

/**
 * What a decision's input digest covers: the facts and the evaluation metadata, in their one
 * canonical form (`core` normalizes the caller's input into it). The format is closed: no other
 * key, every field present (`validateProofInput`, `schema/proof-input.schema.json`). A proof
 * holds only its digest (`computeInputDigest`), never the input itself.
 *
 * - `data`: the facts, plain JSON; a root key starting with `$` is reserved (D-3); no number of
 *   absolute value 2^53 or more (D-5); no text or key with a lone UTF-16 surrogate;
 * - `meta.dates`: the named dates, each a civil date `YYYY-MM-DD` or an instant
 *   `YYYY-MM-DDTHH:MM:SS.sssZ` (never an offset); `effective` is the reference date of the
 *   decision, absent when the caller gave none;
 * - `meta.tags`: the scope the caller chose, sorted by UTF-16 code unit without duplicates;
 * - `meta.dimensions`: a value, or a list of at least two values sorted without duplicates (one
 *   value is written as a string); no name starting with `$`;
 * - `meta.context`: free JSON the rules do not read (same number and text rules as `data`);
 * - `meta.assertions`: the provenance of facts, dates and dimensions, by context pointer.
 */
export interface ProofInput {
  data: { [k: string]: JsonValue };
  meta: {
    tenantId: string;
    dates: Record<string, CivilDate | Instant>;
    tags: string[];
    dimensions: Record<string, string | string[]>;
    context: { [k: string]: JsonValue };
    assertions: Record<JsonPointer, FactAssertion>;
  };
}

/** Internal: the assertion methods, in the order messages list them. */
export const ASSERTION_METHODS: readonly AssertionMethod[] = Object.freeze([
  'human',
  'ai',
  'document',
  'presumed',
  'declared',
  'measured',
  'estimated',
  'derived',
  'decision',
]);

/** Internal: the assertion statuses, in the order messages list them. */
export const ASSERTION_STATUSES: readonly AssertionStatus[] = Object.freeze([
  'proposed',
  'validated',
  'contested',
]);
