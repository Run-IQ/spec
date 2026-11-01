/**
 * A builder of small proofs from their trace (`traceProof`): rules with their priorities, the
 * steps, exclusions, pending rules and exceptions of one output `value` (or of the outputs
 * given), each section sorted as the format requires except `exceptions`, kept as given.
 */
import { PROOF_FORMAT } from '../src/index.js';
import { comparePointers } from '../src/path/pointer.js';
import { unsaltedSalt } from './proof-cases.js';
import type { Content, Entry } from './proof-builders.js';

/** A rule of the trace: its qualified id, priority (0), version (1). */
export interface TraceRule {
  id: string;
  priority?: number;
  version?: number;
}

export interface Trace {
  /** The output `value` (its name may be changed): status `determined` unless given. */
  output: Entry;
  /** Further outputs, whole. */
  outputs?: Entry[];
  rules: TraceRule[];
  /** Steps: `ruleId` and `contribution` at least; version 1, model `M`, output `value`. */
  steps?: Entry[];
  skipped?: Entry[];
  pending?: Entry[];
  /** Exceptions, in the order given. */
  exceptions?: Entry[];
  items?: Entry[];
  ruleSets?: Entry[];
  /** The strata, by output name: one stratum of every output unless given. */
  strata?: string[][];
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const setOf = (id: string): string => (id.includes(':') ? id.slice(0, id.indexOf(':')) : 'local');
const bareOf = (id: string): string => id.slice(id.indexOf(':') + 1);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Instances by rule set, bare id, version, then subject (none first). */
function byInstance(a: Entry, b: Entry): number {
  const [x, y] = [text(a.ruleId), text(b.ruleId)];
  const subject = (s: unknown, t: unknown): number => {
    if (s === undefined || t === undefined) return s === t ? 0 : s === undefined ? -1 : 1;
    return comparePointers(text(s), text(t));
  };
  return (
    byText(setOf(x), setOf(y)) ||
    byText(bareOf(x), bareOf(y)) ||
    Number(a.version) - Number(b.version) ||
    subject(a.subject, b.subject)
  );
}

const salt = (section: string, list: Entry[]): Entry[] =>
  list.map((entry, i) => ({ ...entry, salt: unsaltedSalt(section, i) }));

/** The proof content of `trace`, unsealed. */
export function traceProof(trace: Trace): Content {
  const main: Entry = { name: 'value', status: 'determined', contributors: [], pending: [] };
  const outputs = [{ ...main, ...trace.output }, ...(trace.outputs ?? [])].sort((a, b) =>
    byText(text(a.name), text(b.name)),
  );
  const name = text(outputs.find((o) => o.name === (trace.output.name ?? 'value'))?.name);
  const rules = trace.rules
    .map((rule) => ({
      id: bareOf(rule.id),
      version: rule.version ?? 1,
      checksum: 'b'.repeat(64),
      ruleSet: setOf(rule.id),
      priority: rule.priority ?? 0,
    }))
    .sort((a, b) => byText(a.ruleSet, b.ruleSet) || byText(a.id, b.id) || a.version - b.version);
  const sorted = (list: Entry[] | undefined, base: Entry): Entry[] =>
    (list ?? []).map((entry) => ({ version: 1, ...base, ...entry })).sort(byInstance);
  const step = { model: 'M', output: name, status: 'determined', stratum: 0 };
  const skip = { status: 'determined', stratum: 0 };
  const waiting = { stratum: 0, reason: 'UNDETERMINED', detail: 'x', missing: [] };
  return {
    format: PROOF_FORMAT,
    requestId: 'req-1',
    evaluatedAt: null,
    sealedAt: '2026-01-01T00:00:00.000Z',
    inputDigest: 'a'.repeat(64),
    inputSalted: false,
    timeZone: 'UTC',
    ruleSets: trace.ruleSets ?? [],
    versions: { engine: '1', plugins: {}, dsls: {}, models: { M: '1' }, components: [] },
    strata: trace.strata ?? [outputs.map((output) => text(output.name))],
    rules: salt('rules', rules),
    outputs: salt('outputs', outputs),
    items: salt('items', trace.items ?? []),
    applied: salt('applied', sorted(trace.steps, step)),
    skipped: salt('skipped', sorted(trace.skipped, skip)),
    pending: salt('pending', sorted(trace.pending, waiting)),
    exceptions: salt(
      'exceptions',
      (trace.exceptions ?? []).map((entry) => ({ version: 1, ...skip, ...entry })),
    ),
    factsRead: [],
    missingFacts: [],
    readsUndeclared: [],
  };
}
