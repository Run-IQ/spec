import { citeName } from '../errors.js';
import { subjectContains } from '../path/subject.js';
import type { Subject } from '../path/subject.js';
import { full } from './collect.js';
import { instanceKey } from './output-values.js';
import type { ProofPending, ProofView } from './types.js';

// Internal to `@run-iq/spec`: what the pending entries of a proof say of its pending carriers
// (R18, D-8): whether each fired its exceptions, and which pending carrier holds a rule
// pending `PENDING_CARRIER`.

/**
 * The causes of a pending `ERROR` (D-8): its `detail` is `<CAUSE>: <message>`, its cause (the
 * text before the first `:`) exactly one of these. A new cause is a change of the format. The
 * one list: core imports it, and `schema/decision-proof.schema.json` is generated from it.
 */
export const ERROR_CAUSES = Object.freeze([
  'DSL_ERROR',
  'TIMEOUT',
  'DSL_NOT_FOUND',
  'INVALID_PARAMS',
  'CHECKSUM_MISMATCH',
  'INVALID_RULE',
  'MODEL_ERROR',
  'OUTPUT_MISMATCH',
  'NOT_A_COLLECTION',
  'TEMPORAL_OVERLAP',
  'INVALID_ORDER_VALUE',
  'INVALID_GROUP_VALUE',
  'TZDATA_UNKNOWN',
  // Reserved for the fuel of a sandboxed DSL (plan, phase 3): proof/1 does not change.
  'FUEL_EXHAUSTED',
] as const);

/** One cause of `ERROR_CAUSES`. */
export type ErrorCause = (typeof ERROR_CAUSES)[number];

const CAUSES: ReadonlySet<string> = new Set<string>(ERROR_CAUSES);

/** The cause of an `ERROR` `detail`: the text before its first `:`, if any. */
function causeOf(detail: string): string | undefined {
  const colon = detail.indexOf(':');
  return colon < 0 ? undefined : detail.slice(0, colon);
}

/** True when `detail` is `<CAUSE>: <message>` with a cause of `ERROR_CAUSES`. */
export function hasErrorCause(detail: string): boolean {
  const cause = causeOf(detail);
  return cause !== undefined && CAUSES.has(cause);
}

/** The causes of a pending `ERROR` after which a carrier fired: its condition held (R18). */
const FIRING_CAUSES: ReadonlySet<string> = new Set<ErrorCause>(['INVALID_PARAMS', 'MODEL_ERROR']);

/**
 * The causes of a pending `ERROR` after which a carrier did not fire: its condition failed
 * (`DSL_ERROR`, `TIMEOUT`, `DSL_NOT_FOUND`) or was never reached (`CHECKSUM_MISMATCH`,
 * `INVALID_RULE`, `TEMPORAL_OVERLAP`; `NOT_A_COLLECTION` and `INVALID_GROUP_VALUE`, its
 * instances not formed, D-2).
 */
const UNFIRING_CAUSES: ReadonlySet<string> = new Set<ErrorCause>([
  'DSL_ERROR',
  'TIMEOUT',
  'DSL_NOT_FOUND',
  'CHECKSUM_MISMATCH',
  'INVALID_RULE',
  'TEMPORAL_OVERLAP',
  'NOT_A_COLLECTION',
  'INVALID_GROUP_VALUE',
]);

/**
 * The `fired` a carrier pending for `entry` must record, when its reason fixes it: `true` for
 * `PENDING_DOMINANT` (dominance runs after the exceptions, D-22) and the causes of
 * `FIRING_CAUSES`, `false` for `PENDING_CARRIER` (a pending carrier would have reached it: it
 * fired nothing) and the causes of `UNFIRING_CAUSES`. `undefined` when the entry alone says it:
 * `UNDETERMINED`, `AMBIGUOUS_ORDER`, the causes `OUTPUT_MISMATCH`, `INVALID_ORDER_VALUE`,
 * `TZDATA_UNKNOWN` and `FUEL_EXHAUSTED` each come before or after the condition (D-33, D-9,
 * D-21: a model or a sandboxed condition reaches them), and a reason not known here (D-6:
 * reasons are open) may come from either side, which only its producer knows.
 */
function firedOf(entry: ProofPending): boolean | undefined {
  if (entry.reason === 'PENDING_DOMINANT') return true;
  if (entry.reason === 'PENDING_CARRIER') return false;
  if (entry.reason !== 'ERROR') return undefined;
  const cause = causeOf(entry.detail) ?? '';
  if (FIRING_CAUSES.has(cause)) return true;
  if (UNFIRING_CAUSES.has(cause)) return false;
  return undefined;
}

/**
 * `fired contradicts its reason: id@version[ at subject]`, in the order of `pending`: a
 * pending entry whose `fired` is not the value its reason fixes (`firedOf`).
 */
export function firedProblems(p: ProofView, problems: string[]): void {
  for (const entry of p.pending) {
    if (full(problems)) return;
    if (entry.fired === undefined) continue;
    const fixed = firedOf(entry);
    if (fixed !== undefined && fixed !== entry.fired) {
      problems.push(`fired contradicts its reason: ${citeName(instanceKey(entry))}`);
    }
  }
}

/** How the carrier a `PENDING_CARRIER` entry names holds it. */
type Hold = 'root' | 'none' | 'rootless';

/**
 * The problems of the rules pending `PENDING_CARRIER` (D-8), in the order of `pending`. Each
 * names, in its `carrier`, the pending carrier that held it: a pending instance whose `fired`
 * is `false`
 * (`pending carrier without a pending carrier: id@version[ at subject]` otherwise). A carrier
 * itself pending `PENDING_CARRIER` holds nothing by itself: following the carriers named, the
 * chain ends at a carrier pending for another reason, never on itself or in a cycle
 * (`pending carrier without a root`). A carrier never runs after its target, nor out of its
 * scope (D-21: one subject contains the other, or one has none): `pending carrier after its
 * target`, `pending carrier out of scope`. Each entry is followed once: linear in `pending`.
 *
 * While `pending` has a redacted entry (`carriersHidden`), a carrier not found, or a chain that
 * ends at one, may end at that entry (D-16, R18): `pending carrier without a pending carrier`
 * and `… without a root` are not reported; a carrier found is still checked.
 */
export function pendingCarrierProblems(
  p: ProofView,
  waiting: ReadonlyMap<string, ProofPending>,
  problems: string[],
  carriersHidden: () => boolean = () => false,
): void {
  const holds = new Map<ProofPending, Hold | 'open'>();
  const follow = (start: ProofPending): void => {
    const path: ProofPending[] = [];
    let entry = start;
    let last: Hold;
    for (;;) {
      const known = holds.get(entry);
      if (known !== undefined) {
        last = known === 'root' ? 'root' : 'rootless';
        break;
      }
      holds.set(entry, 'open');
      path.push(entry);
      const link = entry.carrier;
      const carrier = link === undefined ? undefined : waiting.get(instanceKey(link));
      if (carrier === undefined || carrier.fired !== false) {
        holds.set(entry, 'none');
        path.pop();
        last = 'rootless';
        break;
      }
      if (carrier.reason !== 'PENDING_CARRIER') {
        holds.set(entry, 'root');
        path.pop();
        last = 'root';
        break;
      }
      entry = carrier;
    }
    for (const passed of path) holds.set(passed, last);
  };
  for (const entry of p.pending) {
    if (full(problems)) return;
    if (entry.reason !== 'PENDING_CARRIER') continue;
    if (!holds.has(entry)) follow(entry);
    const hold = holds.get(entry);
    const at = citeName(instanceKey(entry));
    const problem =
      hold === 'none'
        ? `pending carrier without a pending carrier: ${at}`
        : hold === 'rootless'
          ? `pending carrier without a root: ${at}`
          : undefined;
    // The carrier or the root may be the redacted entry.
    if (problem !== undefined && !carriersHidden()) problems.push(problem);
    const carrier =
      entry.carrier === undefined ? undefined : waiting.get(instanceKey(entry.carrier));
    if (carrier === undefined) continue;
    if (carrier.stratum > entry.stratum) problems.push(`pending carrier after its target: ${at}`);
    if (!inScope(carrier.subject, entry.subject)) {
      problems.push(`pending carrier out of scope: ${at}`);
    }
  }
}

/**
 * True when a carrier at `carrier` may reach a target at `target` (D-21): one has no subject,
 * or one contains the other.
 */
export function inScope(carrier: Subject | undefined, target: Subject | undefined): boolean {
  if (carrier === undefined || target === undefined) return true;
  return subjectContains(carrier, target) || subjectContains(target, carrier);
}
