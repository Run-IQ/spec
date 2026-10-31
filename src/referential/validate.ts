import { citeName, newSpecError, quoteText, unreadableMessage } from '../errors.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { IssueList } from '../issues.js';
import type { RuleValidationIssue } from '../issues.js';
import { dimensionValueProblem } from '../rule/dimensions.js';
import { isCivilDate } from '../time/civil.js';
import type { CivilDate } from '../time/civil.js';
import { hasLoneSurrogate, isPlainObject, loneSurrogateMessage } from '../values.js';
import { readLimits, STEPS_PER_NODE } from './limits.js';
import type { Limits, ReferentialLimits } from './limits.js';
import { ALWAYS, sweepNesting } from './nesting.js';
import type { Edge, Work } from './nesting.js';
import { REFERENTIAL_FORMAT } from './types.js';
import type { Period, Referential, ReferentialMember } from './types.js';

export type { ReferentialLimits } from './limits.js';

const KEYS: readonly string[] = [
  'format',
  'id',
  'version',
  'dimension',
  'codeSystem',
  'codes',
  'groups',
  'sourceRef',
];
const GROUP_KEYS: readonly string[] = ['exhaustive', 'members', 'sourceRef'];
const MEMBER_KEYS: readonly string[] = ['value', 'from', 'until', 'sourceRef'];
const PERIOD_KEYS: readonly string[] = ['from', 'until', 'sourceRef'];

/** One period, `[from, until)`; `from` is `ALWAYS` when the period has no start. */
interface Span {
  from: CivilDate;
  until: CivilDate | null;
}

type Add = (path: string, message: string) => void;

/**
 * Checks a referential document (`Referential`) without throwing and returns every problem
 * found, each with the path of its field (`groups.UE.members[0].until`; `''` for the whole
 * value). It agrees with `schema/referential.schema.json` on JSON documents, and also checks
 * what JSON Schema cannot express:
 * - size: more than `maxNodes` nodes (default 100 000; the periods of `codes`, the groups and
 *   their members) stops the check with `referential too large: <n> nodes`, counted from the
 *   keys of `codes` and `groups` before any group is read, then from the lengths of the lists
 *   before any member is read;
 * - a period must not be empty (`until` after `from`); the periods of one code, and those of
 *   one value listed twice in a group, must not overlap;
 * - a value is never both a code and a group; with `codes`, every member is a group or a code;
 * - no cycle of groups at any date: the dates where memberships start and end are swept in
 *   order; each group-in-group membership that starts is checked by a search that alternates
 *   forward from the member and backward from the group, so it costs at most twice the smaller
 *   side (`cycle A > B > A from 2020-01-01`; `from the beginning` for memberships without
 *   `from`);
 * - nesting at most `maxDepth` groups deep (default 64, at most 1 024) at any date, measured in
 *   the same sweep from heights kept per group and recomputed only where a membership changed
 *   (`group nesting deeper than 64`);
 * - work: the sweep counts its steps (each edge read, each height marked or recomputed) and
 *   stops past `maxSteps` (default 100 per node counted, so that validity never depends on the
 *   configured `maxNodes`) with `referential too complex: more than <n> steps`, so that no
 *   document costs minutes of work;
 * - no text with a lone UTF-16 surrogate.
 *
 * Each property is read once. A property that cannot be read (a getter or a Proxy trap that
 * throws) gives `<path> could not be read: <reason>`; the value itself unreadable gives
 * `referential could not be read: <reason>`. Throws `SpecError` (`INVALID_REFERENTIAL`) only
 * for invalid options: not an object, unreadable, a limit that is not a positive integer, or
 * `maxDepth` above 1 024.
 *
 * Lists at most 100 problems, in the order found, then one last issue `further problems not
 * listed (limit 100)`; a path or message longer than 1024 code units is cut there, then `…`
 * (`IssueList`, shared by every validator of the package).
 */
export function validateReferential(
  value: unknown,
  options: ReferentialLimits = {},
): RuleValidationIssue[] {
  return check(value, readLimits(options)).issues;
}

/**
 * The normal form of a referential, so that one meaning has one form and one digest:
 * - the members of each group sorted by `value`, then `from` (absent first), `until` (absent
 *   last) and `sourceRef` (absent first), in UTF-16 code units; the periods of each code sorted
 *   the same way by `from`, `until` and `sourceRef`;
 * - `until: null` written as an absent `until` (no end), on members and code periods;
 * - an entry listed twice, identical once normalized, kept once;
 * - two periods of one value (or one code) that meet (`until` of one is `from` of the next)
 *   and have the same `sourceRef` merged into one; with different sources the boundary stays,
 *   since the source is content.
 *
 * Reads each property of `referential` once and returns a copy that shares nothing with it.
 * Throws `SpecError` (`INVALID_REFERENTIAL`) with the first issue of `validateReferential` when
 * the referential is not valid (with the same `options`).
 */
export function normalizeReferential(
  referential: unknown,
  options: ReferentialLimits = {},
): Referential {
  const { issues, normal } = check(referential, readLimits(options));
  const [first] = issues;
  if (first !== undefined || normal === undefined) {
    throw newSpecError('INVALID_REFERENTIAL', first?.message ?? 'invalid referential');
  }
  return normal;
}

/**
 * `sha256Hex(canonicalize(normalizeReferential(referential, options)))`: the digest a decision
 * cites for the referential it used (`ruleSets`, `kind: 'referential'`). The same meaning
 * gives the same digest, whatever the order of keys, members and periods, and whether an open
 * end is written `until: null` or left out. Throws `SpecError` (`INVALID_REFERENTIAL`) for an
 * invalid referential.
 */
export function computeReferentialDigest(
  referential: Referential,
  options: ReferentialLimits = {},
): string {
  return sha256Hex(canonicalize(normalizeReferential(referential, options)));
}

/**
 * Internal (not exported from the package): the steps the cycle and depth sweep took on
 * `value`, so that tests bound the work without a clock.
 */
export function referentialCheckSteps(value: unknown, options: ReferentialLimits = {}): number {
  return check(value, readLimits(options)).steps;
}

function check(
  value: unknown,
  limits: Limits,
): { issues: RuleValidationIssue[]; normal: Referential | undefined; steps: number } {
  // The budget is set once the nodes are counted (`readReferential`).
  const work: Work = { steps: 0, limit: 0 };
  const issues = new IssueList();
  const add: Add = (path, message) => {
    issues.add(path, message);
  };
  let normal: Referential | undefined;
  try {
    normal = readReferential(value, limits, add, work);
  } catch (error) {
    return {
      issues: [{ path: '', message: unreadableMessage('referential', error) }],
      normal: undefined,
      steps: work.steps,
    };
  }
  return {
    issues: issues.toArray(),
    normal: issues.length === 0 ? normal : undefined,
    steps: work.steps,
  };
}

/** A group as read once: its raw members, read after the size check. */
interface RawGroup {
  name: string;
  exhaustive: boolean;
  sourceRef: string | undefined;
  members: readonly unknown[] | undefined;
  length: number;
}

/**
 * Checks the referential and builds its normal form as it reads it; the form is complete only
 * when no issue was added.
 */
function readReferential(
  value: unknown,
  limits: Limits,
  add: Add,
  work: Work,
): Referential | undefined {
  if (!isPlainObject(value)) {
    add('', 'a referential must be a plain object');
    return undefined;
  }
  const fields = readFields(value, '', KEYS, 'referential has an unknown key', add);
  if (fields === undefined) return undefined;

  if (fields.format !== REFERENTIAL_FORMAT) {
    add('format', `format must be ${quoteText(REFERENTIAL_FORMAT)}`);
  }
  for (const key of ['id', 'version', 'dimension'] as const) {
    checkText(fields[key], key, add);
  }
  checkSourceRef(fields, '', add);
  if (fields.codeSystem !== undefined) {
    if (
      checkText(fields.codeSystem, 'codeSystem', add) &&
      String(fields.codeSystem).includes(':')
    ) {
      add('codeSystem', 'codeSystem must not hold ":"');
    }
  }

  // Size first: from the keys (each code has a period, each group is a node) before any code
  // or group is read, then from the lengths of the lists before any member is read.
  const codeKeys = fields.codes === undefined ? [] : ownKeys(fields.codes, 'codes', add);
  const groupKeys = ownKeys(fields.groups, 'groups', add);
  if (codeKeys === undefined || groupKeys === undefined) return undefined;
  if (codeKeys.length + groupKeys.length > limits.maxNodes) {
    add('', `referential too large: ${codeKeys.length + groupKeys.length} nodes`);
    return undefined;
  }
  const codes = fields.codes === undefined ? undefined : readCodeLists(fields.codes, codeKeys, add);
  const groups = readGroups(fields.groups, groupKeys, add);
  let nodes = 0;
  for (const periods of codes?.values() ?? []) nodes += periods?.length ?? 0;
  for (const group of groups ?? []) nodes += 1 + group.length;
  if (nodes > limits.maxNodes) {
    add('', `referential too large: ${nodes} nodes`);
    return undefined;
  }
  work.limit = limits.maxSteps ?? STEPS_PER_NODE * Math.max(nodes, 1);

  const codeNames = new Set<string>();
  const normalCodes: Record<string, Period[]> = {};
  if (codes !== undefined) {
    for (const [code, periods] of codes) {
      codeNames.add(code);
      if (periods !== undefined) {
        defineField(normalCodes, code, checkPeriods(periods, `codes.${code}`, add));
      }
    }
  }
  if (groups === undefined) return undefined;
  const groupNames = new Set(groups.map((g) => g.name));
  for (const name of groupNames) {
    if (codeNames.has(name)) add(`groups.${name}`, `${citeName(name)} is both a code and a group`);
  }

  const edges: Edge[] = [];
  let membersValid = true;
  const normalGroups: Referential['groups'] = {};
  for (const group of groups) {
    const members =
      group.members === undefined
        ? undefined
        : checkMembers(group, codes === undefined ? undefined : codeNames, groupNames, edges, add);
    if (members === undefined) {
      membersValid = false;
      continue;
    }
    const normalGroup: Referential['groups'][string] = { exhaustive: group.exhaustive, members };
    if (group.sourceRef !== undefined) normalGroup.sourceRef = group.sourceRef;
    defineField(normalGroups, group.name, normalGroup);
  }
  if (membersValid) {
    const found = sweepNesting(edges, limits.maxDepth, work);
    if (found.cycle !== undefined) add('groups', found.cycle);
    if (found.tooDeep) add('groups', `group nesting deeper than ${limits.maxDepth}`);
    if (found.tooComplex) {
      add('groups', `referential too complex: more than ${work.limit} steps`);
    }
  }

  const normal: Referential = {
    format: REFERENTIAL_FORMAT,
    id: String(fields.id),
    version: String(fields.version),
    dimension: String(fields.dimension),
    groups: normalGroups,
  };
  if (typeof fields.codeSystem === 'string') normal.codeSystem = fields.codeSystem;
  if (codes !== undefined) normal.codes = normalCodes;
  if (typeof fields.sourceRef === 'string') normal.sourceRef = fields.sourceRef;
  return normal;
}

/** Plain assignment would turn a `__proto__` key into a prototype change. */
function defineField<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Code-unit order, `undefined` first. */
function compareText(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return a < b ? -1 : 1;
}

/** The order of normal entries: `from` (absent first), `until` (absent last), `sourceRef`. */
function compareSpans(
  a: { from?: string; until?: string | null; sourceRef?: string },
  b: { from?: string; until?: string | null; sourceRef?: string },
): number {
  return (
    compareText(a.from, b.from) ||
    compareText(a.until ?? '~', b.until ?? '~') ||
    compareText(a.sourceRef, b.sourceRef)
  );
}

/** `entries` sorted by `compare`, an entry equal (by `canonicalize`) to its neighbour dropped. */
function sortedUnique<T>(entries: readonly T[], compare: (a: T, b: T) => number): T[] {
  const out: T[] = [];
  let last: string | undefined;
  for (const entry of [...entries].sort(compare)) {
    const key = canonicalize(entry);
    if (key !== last) out.push(entry);
    last = key;
  }
  return out;
}

/**
 * Reads the own keys of `value` once each, into a plain record. An unknown key is reported.
 * A property that cannot be read is reported and gives `undefined`: the caller checks nothing
 * more of that record, so a getter that throws gives one issue, not a cascade.
 */
function readFields(
  value: Record<string, unknown>,
  prefix: string,
  known: readonly string[],
  unknownMessage: string,
  add: Add,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let readable = true;
  for (const key of Object.keys(value)) {
    const path = `${prefix}${key}`;
    if (!known.includes(key)) {
      add(path, `${unknownMessage} ${quoteText(key)}`);
      continue;
    }
    try {
      // Known keys only: `__proto__` is never one, so plain assignment stays data.
      out[key] = value[key];
    } catch (error) {
      add(path, unreadableMessage(path, error));
      readable = false;
    }
  }
  return readable ? out : undefined;
}

/**
 * Checks the optional `sourceRef` of a record read by `readFields` (the legal source of the
 * referential, a group, a membership or a code period): absent, or a non-empty string.
 */
function checkSourceRef(fields: Record<string, unknown>, prefix: string, add: Add): void {
  if (Object.hasOwn(fields, 'sourceRef') && fields.sourceRef !== undefined) {
    checkText(fields.sourceRef, `${prefix}sourceRef`, add);
  }
}

/** True for a non-empty string without lone surrogate; reports any other value at `path`. */
function checkText(value: unknown, path: string, add: Add): boolean {
  if (typeof value !== 'string' || value === '') {
    add(path, `${citeName(path)} must be a non-empty string`);
    return false;
  }
  if (hasLoneSurrogate(value)) {
    add(path, loneSurrogateMessage(path));
    return false;
  }
  return true;
}

/**
 * The problem with `name` as a code or a group name, or `undefined`: a non-empty value
 * without `:`, which separates a code system from a code.
 */
function nameProblem(name: string, kind: 'code' | 'group name'): string | undefined {
  if (name === '') return `${kind} must not be empty`;
  if (hasLoneSurrogate(name)) return `${kind} ${quoteText(name)} contains a lone UTF-16 surrogate`;
  if (name.includes(':')) return `${kind} ${quoteText(name)} must not hold ":"`;
  return undefined;
}

/**
 * The own keys of `codes` or `groups`, read once: `[]` when the value is not an object (its
 * reader reports it), `undefined` after reporting keys that cannot be read.
 */
function ownKeys(value: unknown, path: string, add: Add): string[] | undefined {
  try {
    return isPlainObject(value) ? Object.keys(value) : [];
  } catch (error) {
    add(path, unreadableMessage(path, error));
    return undefined;
  }
}

/** The codes and their period lists (`undefined` for an unreadable or refused list). */
function readCodeLists(
  value: unknown,
  keys: readonly string[],
  add: Add,
): Map<string, readonly unknown[] | undefined> {
  const codes = new Map<string, readonly unknown[] | undefined>();
  if (!isPlainObject(value)) {
    add('codes', 'codes must be an object of period lists');
    return codes;
  }
  for (const code of keys) {
    const path = `codes.${code}`;
    const problem = nameProblem(code, 'code');
    if (problem !== undefined) {
      add('codes', problem);
      continue;
    }
    let periods: unknown;
    try {
      periods = value[code];
    } catch (error) {
      add(path, unreadableMessage(path, error));
      codes.set(code, undefined);
      continue;
    }
    if (!Array.isArray(periods)) {
      add(path, `${citeName(path)} must be an array of periods`);
      codes.set(code, undefined);
    } else if (periods.length === 0) {
      add(path, `${citeName(path)} must list at least one period`);
      codes.set(code, undefined);
    } else {
      codes.set(code, periods);
    }
  }
  return codes;
}

/** The groups, each read once with the length of its member list; `undefined` if refused. */
function readGroups(value: unknown, keys: readonly string[], add: Add): RawGroup[] | undefined {
  if (!isPlainObject(value)) {
    add('groups', 'groups must be an object of groups');
    return undefined;
  }
  const groups: RawGroup[] = [];
  for (const name of keys) {
    const path = `groups.${name}`;
    const problem = nameProblem(name, 'group name');
    if (problem !== undefined) {
      add('groups', problem);
      continue;
    }
    try {
      groups.push(readGroup(value[name], name, path, add));
    } catch (error) {
      add(path, unreadableMessage(path, error));
    }
  }
  return groups;
}

function readGroup(value: unknown, name: string, path: string, add: Add): RawGroup {
  const refused = { name, exhaustive: false, sourceRef: undefined, members: undefined, length: 0 };
  if (!isPlainObject(value)) {
    add(path, `${citeName(path)} must be an object { exhaustive, members }`);
    return refused;
  }
  const fields = readFields(
    value,
    `${path}.`,
    GROUP_KEYS,
    `${citeName(path)} has an unknown key`,
    add,
  );
  if (fields === undefined) return refused;
  checkSourceRef(fields, `${path}.`, add);
  const exhaustive = fields.exhaustive;
  if (typeof exhaustive !== 'boolean') {
    add(`${path}.exhaustive`, `${citeName(path)}.exhaustive must be a boolean`);
  }
  const members = fields.members;
  if (!Array.isArray(members)) {
    add(`${path}.members`, `${citeName(path)}.members must be an array of members`);
    return refused;
  }
  const list: readonly unknown[] = members;
  let length: number;
  try {
    length = list.length;
  } catch (error) {
    add(`${path}.members`, unreadableMessage(`${path}.members`, error));
    return refused;
  }
  return {
    name,
    exhaustive: exhaustive === true,
    sourceRef: typeof fields.sourceRef === 'string' ? fields.sourceRef : undefined,
    members: list,
    length,
  };
}

/**
 * Checks the periods of one code and returns them in normal form: sorted, `until: null`
 * dropped, identical ones kept once. Identical periods are one period, not an overlap.
 */
function checkPeriods(periods: readonly unknown[], path: string, add: Add): Period[] {
  const read: Period[] = [];
  const length = periods.length;
  for (let i = 0; i < length; i++) {
    const at = `${path}[${i}]`;
    try {
      const period = readPeriod(periods[i], at, add);
      if (period !== undefined) read.push(period);
    } catch (error) {
      add(at, unreadableMessage(at, error));
    }
  }
  const normal = sortedUnique(read, compareSpans);
  const overlap = firstOverlap(normal.map((p) => ({ from: p.from, until: p.until ?? null })));
  if (overlap !== undefined) add(path, `${citeName(path)} has overlapping periods from ${overlap}`);
  return mergeAdjacent(normal);
}

function readPeriod(value: unknown, path: string, add: Add): Period | undefined {
  if (!isPlainObject(value)) {
    add(path, `${citeName(path)} must be a period { from, until }`);
    return undefined;
  }
  const fields = readFields(
    value,
    `${path}.`,
    PERIOD_KEYS,
    `${citeName(path)} has an unknown key`,
    add,
  );
  if (fields === undefined) return undefined;
  checkSourceRef(fields, `${path}.`, add);
  const from = fields.from;
  const until = fields.until;
  let valid = true;
  if (!isCivilDate(from)) {
    add(`${path}.from`, `${citeName(path)}.from must be a civil date YYYY-MM-DD`);
    valid = false;
  }
  if (until != null && !isCivilDate(until)) {
    add(`${path}.until`, `${citeName(path)}.until must be a civil date YYYY-MM-DD or null`);
    valid = false;
  }
  if (!valid || !isCivilDate(from)) return undefined;
  const end = isCivilDate(until) ? until : null;
  if (checkSpan(from, end, path, add) === undefined) return undefined;
  const period: Period = { from };
  if (end !== null) period.until = end;
  if (typeof fields.sourceRef === 'string') period.sourceRef = fields.sourceRef;
  return period;
}

/** The span, or `undefined` after reporting an empty one. */
function checkSpan(
  from: CivilDate,
  until: CivilDate | null,
  path: string,
  add: Add,
): Span | undefined {
  if (until !== null && until <= from) {
    add(`${path}.until`, `${citeName(path)}.until must be after from ${from}: the period is empty`);
    return undefined;
  }
  return { from, until };
}

/** The start of the first overlap between two spans, or `undefined`. */
function firstOverlap(spans: readonly Span[]): CivilDate | undefined {
  const sorted = [...spans].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  let end: CivilDate | null | undefined;
  let found: CivilDate | undefined;
  for (const span of sorted) {
    if (end !== undefined && (end === null || span.from < end)) {
      if (found === undefined || span.from < found) found = span.from;
    }
    if (end === undefined || (end !== null && (span.until === null || span.until > end))) {
      end = span.until;
    }
  }
  return found;
}

/**
 * Checks the members of one group, records its group-in-group memberships in `edges` and
 * returns the members in normal form (sorted, `until: null` dropped, identical ones kept once:
 * an identical repetition is one membership, not an overlap). Returns `undefined` when a member
 * could not be read or was refused, so that nesting is not measured on a partial graph.
 */
function checkMembers(
  group: RawGroup,
  codes: ReadonlySet<string> | undefined,
  groupNames: ReadonlySet<string>,
  edges: Edge[],
  add: Add,
): ReferentialMember[] | undefined {
  const path = `groups.${group.name}.members`;
  const read: ReferentialMember[] = [];
  let valid = true;
  const members = group.members ?? [];
  for (let i = 0; i < group.length; i++) {
    const at = `${path}[${i}]`;
    let member: ReferentialMember | undefined;
    try {
      member = readMember(members[i], at, codes, groupNames, add);
    } catch (error) {
      add(at, unreadableMessage(at, error));
    }
    if (member === undefined) valid = false;
    else read.push(member);
  }
  const normal = sortedUnique(read, (a, b) => compareText(a.value, b.value) || compareSpans(a, b));
  const byValue = new Map<string, Span[]>();
  for (const member of normal) {
    const span = { from: member.from ?? ALWAYS, until: member.until ?? null };
    const spans = byValue.get(member.value) ?? [];
    spans.push(span);
    byValue.set(member.value, spans);
    if (groupNames.has(member.value)) {
      edges.push({ group: group.name, member: member.value, ...span });
    }
  }
  for (const [value, spans] of byValue) {
    const overlap = spans.length > 1 ? firstOverlap(spans) : undefined;
    if (overlap !== undefined) {
      const when = overlap === ALWAYS ? 'from the beginning' : `from ${overlap}`;
      add(path, `${citeName(path)} lists ${citeName(value)} twice ${when}`);
    }
  }
  return valid ? mergeAdjacent(normal) : undefined;
}

/**
 * Sorted entries with two neighbours of one value that meet (`until` of the first is `from`
 * of the second) and have the same `sourceRef` merged into one: one meaning, one form.
 */
function mergeAdjacent<T extends { value?: string; from?: string; until?: string | null }>(
  sorted: readonly (T & { sourceRef?: string })[],
): T[] {
  const out: (T & { sourceRef?: string })[] = [];
  for (const entry of sorted) {
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      last.value === entry.value &&
      last.sourceRef === entry.sourceRef &&
      last.until != null &&
      last.until === entry.from
    ) {
      const merged = { ...last };
      if (entry.until == null) delete merged.until;
      else merged.until = entry.until;
      out[out.length - 1] = merged;
    } else {
      out.push(entry);
    }
  }
  return out;
}

function readMember(
  value: unknown,
  path: string,
  codes: ReadonlySet<string> | undefined,
  groupNames: ReadonlySet<string>,
  add: Add,
): ReferentialMember | undefined {
  if (!isPlainObject(value)) {
    add(path, `${citeName(path)} must be a member { value, from?, until? }`);
    return undefined;
  }
  const fields = readFields(
    value,
    `${path}.`,
    MEMBER_KEYS,
    `${citeName(path)} has an unknown key`,
    add,
  );
  if (fields === undefined) return undefined;
  checkSourceRef(fields, `${path}.`, add);
  let valid = true;
  const member = fields.value;
  const valuePath = `${path}.value`;
  const problem = dimensionValueProblem(member, valuePath);
  if (problem !== undefined) {
    add(valuePath, problem);
    valid = false;
  } else if (typeof member === 'string' && member.includes(':')) {
    add(valuePath, `${citeName(valuePath)} must not hold ":"`);
    valid = false;
  } else if (
    typeof member === 'string' &&
    codes !== undefined &&
    !codes.has(member) &&
    !groupNames.has(member)
  ) {
    add(
      valuePath,
      `${citeName(valuePath)} ${citeName(member)} is neither a group nor a code of codes`,
    );
    valid = false;
  }
  const from = fields.from;
  const until = fields.until;
  if (from !== undefined && !isCivilDate(from)) {
    add(`${path}.from`, `${citeName(path)}.from must be a civil date YYYY-MM-DD`);
    valid = false;
  }
  if (until !== undefined && until !== null && !isCivilDate(until)) {
    add(`${path}.until`, `${citeName(path)}.until must be a civil date YYYY-MM-DD or null`);
    valid = false;
  }
  if (!valid || typeof member !== 'string') return undefined;
  const start = isCivilDate(from) ? from : undefined;
  const end = isCivilDate(until) ? until : undefined;
  if (checkSpan(start ?? ALWAYS, end ?? null, path, add) === undefined) return undefined;
  const normal: ReferentialMember = { value: member };
  if (start !== undefined) normal.from = start;
  if (end !== undefined) normal.until = end;
  if (typeof fields.sourceRef === 'string') normal.sourceRef = fields.sourceRef;
  return normal;
}
