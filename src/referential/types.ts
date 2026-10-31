import type { CivilDate } from '../time/civil.js';

/** The format of a referential document. */
export const REFERENTIAL_FORMAT = 'run-iq.referential/1';

/** A half-open period of civil dates, `[from, until)`; `until: null` has no end. */
export interface Period {
  from: CivilDate;
  until: CivilDate | null;
  /** The legal source of the period (the act that creates or repeals the code). */
  sourceRef?: string;
}

/**
 * One member of a group: a code, or another group (nesting). It belongs to the group during
 * `[from, until)`: `from` absent means since always, `until` absent or `null` means no end.
 */
export interface ReferentialMember {
  value: string;
  from?: CivilDate;
  until?: CivilDate | null;
  /** The legal source of the membership (an accession treaty). */
  sourceRef?: string;
}

/**
 * Dated groups of the values of one dimension (study 6.1 point 11, D-18, D-35): the European
 * Union holds FR since `1958-01-01`, GB during `[1973-01-01, 2020-02-01)`; the EEA holds the
 * Union. `validateReferential` checks one; `resolveMembership` reads it.
 *
 * - `codes`, when present, lists every code with its validity periods: a value absent from it,
 *   or not valid at the date, has an unknown membership. A code reused across nomenclature
 *   revisions has one period per use.
 * - `codeSystem` names the system of the codes (`nace-2.1`): a qualified input value
 *   `<system>:<code>` (the first `:` separates) is read in that system only.
 * - `exhaustive` is per group: a value that is not found in an exhaustive group, and that every
 *   nested group answers "not a member" for, is outside the group; otherwise it is unknown.
 * - `sourceRef` (optional, on the referential, a group, a membership or a code period) cites
 *   the legal source: content, part of the digest, never read by `resolveMembership`.
 * - A code is never also a group name; group nesting has no cycle at any date and is at most
 *   64 groups deep (`validateReferential`).
 */
export interface Referential {
  format: typeof REFERENTIAL_FORMAT;
  id: string;
  version: string;
  /** The dimension whose values the referential groups (`pays`). */
  dimension: string;
  codeSystem?: string;
  codes?: Record<string, Period[]>;
  groups: Record<string, { exhaustive: boolean; members: ReferentialMember[]; sourceRef?: string }>;
  /** The legal source of the referential as a whole. */
  sourceRef?: string;
}

/**
 * Whether a value belongs to a group at a date, in three values. `via` lists the groups crossed,
 * from the asked group down to the one that holds the value directly (`['EEE', 'UE']` for FR in
 * the EEA); it is empty when the value is the asked group itself.
 */
export type Membership =
  { result: true; via: string[] } | { result: false } | { result: 'unknown'; why: string };
