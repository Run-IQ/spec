import { quoteText, SpecError, unreadableMessage } from '../errors.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import type { RuleValidationIssue } from '../rule/validate.js';
import { dimensionValueProblem } from '../rule/dimensions.js';
import { isCivilDate } from '../time/civil.js';
import type { CivilDate } from '../time/civil.js';
import { hasLoneSurrogate, isPlainObject, loneSurrogateMessage } from '../values.js';
import { REFERENTIAL_FORMAT } from './types.js';
import type { Referential } from './types.js';

/** Default bound on the nodes of a referential: its code periods, groups and members. */
export const DEFAULT_MAX_REFERENTIAL_NODES = 100_000;
/** Default bound on the nesting of groups: the groups of the longest chain at any date. */
export const DEFAULT_MAX_GROUP_DEPTH = 64;

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

/** The start of a period with no `from`: before every civil date. */
const ALWAYS = '';

/** One period, `[from, until)`; `from` is `ALWAYS` when the period has no start. */
interface Span {
  from: CivilDate;
  until: CivilDate | null;
}

/** A group-in-group membership: `group` holds `member` during `span`. */
interface Edge {
  group: string;
  member: string;
  span: Span;
}

type Add = (path: string, message: string) => void;

/**
 * Checks a referential document (`Referential`) without throwing and returns every problem
 * found, each with the path of its field (`groups.UE.members[0].until`; `''` for the whole
 * value). It agrees with `schema/referential.schema.json` on JSON documents, and also checks
 * what JSON Schema cannot express:
 * - size: more than `maxNodes` nodes (default 100 000; the periods of `codes`, the groups and
 *   their members) stops the check with `referential too large: <n> nodes`, counted from the
 *   lengths of the lists before any member is read;
 * - a period must not be empty (`until` after `from`); the periods of one code, and those of
 *   one value listed twice in a group, must not overlap;
 * - a value is never both a code and a group; with `codes`, every member is a group or a code;
 * - no cycle of groups at any date: the dates where memberships start and end are swept in
 *   order; each group-in-group membership that starts is checked by a backward path search in
 *   the memberships active at that date (`cycle A > B > A from 2020-01-01`; `from the
 *   beginning` for memberships without `from`). Worst case O(E·(V+E)) for E group-in-group
 *   memberships and V groups, bounded by `maxNodes`;
 * - nesting at most `maxDepth` groups deep (default 64) at any date, measured in the same sweep
 *   (`group nesting deeper than 64`);
 * - no text with a lone UTF-16 surrogate.
 *
 * Each property is read once. A property that cannot be read (a getter or a Proxy trap that
 * throws) gives `<path> could not be read: <reason>`; the value itself unreadable gives
 * `referential could not be read: <reason>`. Throws `SpecError` (`INVALID_REFERENTIAL`) only
 * for invalid options: `maxNodes` and `maxDepth` must be positive integers.
 */
export function validateReferential(
  value: unknown,
  options: { maxNodes?: number; maxDepth?: number } = {},
): RuleValidationIssue[] {
  const maxNodes = readOption(options.maxNodes, DEFAULT_MAX_REFERENTIAL_NODES, 'maxNodes');
  const maxDepth = readOption(options.maxDepth, DEFAULT_MAX_GROUP_DEPTH, 'maxDepth');
  const issues: RuleValidationIssue[] = [];
  const add: Add = (path, message) => {
    issues.push({ path, message });
  };
  try {
    readReferential(value, maxNodes, maxDepth, add);
  } catch (error) {
    return [{ path: '', message: unreadableMessage('referential', error) }];
  }
  return issues;
}

/**
 * `sha256Hex(canonicalize(referential))`: the digest a decision cites for the referential it
 * used (`ruleSets`, `kind: 'referential'`). It does not depend on the order of keys; the order
 * of lists (members, periods) is part of the document. Throws `SpecError` (`NON_SERIALIZABLE`)
 * for a value that is not JSON.
 */
export function computeReferentialDigest(referential: Referential): string {
  return sha256Hex(canonicalize(referential));
}

function readOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SpecError('INVALID_REFERENTIAL', `${name} must be a positive integer`);
  }
  return value;
}

/** A group as read once: its raw members, read after the size check. */
interface RawGroup {
  name: string;
  members: readonly unknown[] | undefined;
  length: number;
}

function readReferential(value: unknown, maxNodes: number, maxDepth: number, add: Add): void {
  if (!isPlainObject(value)) {
    add('', 'a referential must be a plain object');
    return;
  }
  const fields = readFields(value, '', KEYS, 'referential has an unknown key', add);
  if (fields === undefined) return;

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

  // Size first, from the lengths of the lists: no member is read before it.
  const codes = fields.codes === undefined ? undefined : readCodeLists(fields.codes, add);
  const groups = readGroups(fields.groups, add);
  let nodes = 0;
  for (const periods of codes?.values() ?? []) nodes += periods?.length ?? 0;
  for (const group of groups ?? []) nodes += 1 + group.length;
  if (nodes > maxNodes) {
    add('', `referential too large: ${nodes} nodes`);
    return;
  }

  const codeNames = new Set<string>();
  if (codes !== undefined) {
    for (const [code, periods] of codes) {
      codeNames.add(code);
      if (periods !== undefined) checkPeriods(periods, `codes.${code}`, add);
    }
  }
  if (groups === undefined) return;
  const groupNames = new Set(groups.map((g) => g.name));
  for (const name of groupNames) {
    if (codeNames.has(name)) add(`groups.${name}`, `${name} is both a code and a group`);
  }

  const edges: Edge[] = [];
  let membersValid = true;
  for (const group of groups) {
    if (group.members === undefined) continue;
    const ok = checkMembers(
      group,
      codes === undefined ? undefined : codeNames,
      groupNames,
      edges,
      add,
    );
    membersValid &&= ok;
  }
  if (membersValid) checkNesting(edges, maxDepth, add);
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
    add(path, `${path} must be a non-empty string`);
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

/** The codes and their period lists (`undefined` for an unreadable or refused list). */
function readCodeLists(value: unknown, add: Add): Map<string, readonly unknown[] | undefined> {
  const codes = new Map<string, readonly unknown[] | undefined>();
  if (!isPlainObject(value)) {
    add('codes', 'codes must be an object of period lists');
    return codes;
  }
  for (const code of Object.keys(value)) {
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
      add(path, `${path} must be an array of periods`);
      codes.set(code, undefined);
    } else if (periods.length === 0) {
      add(path, `${path} must list at least one period`);
      codes.set(code, undefined);
    } else {
      codes.set(code, periods);
    }
  }
  return codes;
}

/** The groups, each read once with the length of its member list; `undefined` if refused. */
function readGroups(value: unknown, add: Add): RawGroup[] | undefined {
  if (!isPlainObject(value)) {
    add('groups', 'groups must be an object of groups');
    return undefined;
  }
  const groups: RawGroup[] = [];
  for (const name of Object.keys(value)) {
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
  if (!isPlainObject(value)) {
    add(path, `${path} must be an object { exhaustive, members }`);
    return { name, members: undefined, length: 0 };
  }
  const fields = readFields(value, `${path}.`, GROUP_KEYS, `${path} has an unknown key`, add);
  if (fields === undefined) return { name, members: undefined, length: 0 };
  checkSourceRef(fields, `${path}.`, add);
  if (typeof fields.exhaustive !== 'boolean') {
    add(`${path}.exhaustive`, `${path}.exhaustive must be a boolean`);
  }
  const members = fields.members;
  if (!Array.isArray(members)) {
    add(`${path}.members`, `${path}.members must be an array of members`);
    return { name, members: undefined, length: 0 };
  }
  const list: readonly unknown[] = members;
  return { name, members: list, length: list.length };
}

/** A period `{ from, until }` (`until` required, `null` for no end), or `undefined`. */
function checkPeriods(periods: readonly unknown[], path: string, add: Add): void {
  const spans: Span[] = [];
  const length = periods.length;
  for (let i = 0; i < length; i++) {
    const at = `${path}[${i}]`;
    try {
      const span = readPeriod(periods[i], at, add);
      if (span !== undefined) spans.push(span);
    } catch (error) {
      add(at, unreadableMessage(at, error));
    }
  }
  const overlap = firstOverlap(spans);
  if (overlap !== undefined) add(path, `${path} has overlapping periods from ${overlap}`);
}

function readPeriod(value: unknown, path: string, add: Add): Span | undefined {
  if (!isPlainObject(value)) {
    add(path, `${path} must be a period { from, until }`);
    return undefined;
  }
  const fields = readFields(value, `${path}.`, PERIOD_KEYS, `${path} has an unknown key`, add);
  if (fields === undefined) return undefined;
  checkSourceRef(fields, `${path}.`, add);
  const from = fields.from;
  const until = fields.until;
  let valid = true;
  if (!isCivilDate(from)) {
    add(`${path}.from`, `${path}.from must be a civil date YYYY-MM-DD`);
    valid = false;
  }
  if (until !== null && !isCivilDate(until)) {
    add(`${path}.until`, `${path}.until must be a civil date YYYY-MM-DD or null`);
    valid = false;
  }
  if (!valid || !isCivilDate(from) || (until !== null && !isCivilDate(until))) return undefined;
  return checkSpan(from, until, path, add);
}

/** The span, or `undefined` after reporting an empty one. */
function checkSpan(
  from: CivilDate,
  until: CivilDate | null,
  path: string,
  add: Add,
): Span | undefined {
  if (until !== null && until <= from) {
    add(`${path}.until`, `${path}.until must be after from ${from}: the period is empty`);
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
 * Checks the members of one group and records its group-in-group memberships in `edges`.
 * Returns false when a member could not be read or was refused, so that nesting is not
 * measured on a partial graph.
 */
function checkMembers(
  group: RawGroup,
  codes: ReadonlySet<string> | undefined,
  groupNames: ReadonlySet<string>,
  edges: Edge[],
  add: Add,
): boolean {
  const path = `groups.${group.name}.members`;
  const byValue = new Map<string, Span[]>();
  let valid = true;
  const members = group.members ?? [];
  for (let i = 0; i < group.length; i++) {
    const at = `${path}[${i}]`;
    let member: { value: string; span: Span } | undefined;
    try {
      member = readMember(members[i], at, codes, groupNames, add);
    } catch (error) {
      add(at, unreadableMessage(at, error));
    }
    if (member === undefined) {
      valid = false;
      continue;
    }
    const spans = byValue.get(member.value) ?? [];
    spans.push(member.span);
    byValue.set(member.value, spans);
    if (groupNames.has(member.value)) {
      edges.push({ group: group.name, member: member.value, span: member.span });
    }
  }
  for (const [value, spans] of byValue) {
    const overlap = spans.length > 1 ? firstOverlap(spans) : undefined;
    if (overlap !== undefined) {
      const when = overlap === ALWAYS ? 'from the beginning' : `from ${overlap}`;
      add(path, `${path} lists ${value} twice ${when}`);
    }
  }
  return valid;
}

function readMember(
  value: unknown,
  path: string,
  codes: ReadonlySet<string> | undefined,
  groupNames: ReadonlySet<string>,
  add: Add,
): { value: string; span: Span } | undefined {
  if (!isPlainObject(value)) {
    add(path, `${path} must be a member { value, from?, until? }`);
    return undefined;
  }
  const fields = readFields(value, `${path}.`, MEMBER_KEYS, `${path} has an unknown key`, add);
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
    add(valuePath, `${valuePath} must not hold ":"`);
    valid = false;
  } else if (
    typeof member === 'string' &&
    codes !== undefined &&
    !codes.has(member) &&
    !groupNames.has(member)
  ) {
    add(valuePath, `${valuePath} ${member} is neither a group nor a code of codes`);
    valid = false;
  }
  const from = fields.from;
  const until = fields.until;
  if (from !== undefined && !isCivilDate(from)) {
    add(`${path}.from`, `${path}.from must be a civil date YYYY-MM-DD`);
    valid = false;
  }
  if (until !== undefined && until !== null && !isCivilDate(until)) {
    add(`${path}.until`, `${path}.until must be a civil date YYYY-MM-DD or null`);
    valid = false;
  }
  if (!valid || typeof member !== 'string') return undefined;
  const start = isCivilDate(from) ? from : ALWAYS;
  const end = isCivilDate(until) ? until : null;
  const span = checkSpan(start, end, path, add);
  return span === undefined ? undefined : { value: member, span };
}

/**
 * Sweeps the dates where group-in-group memberships start and end, in order. At each date the
 * memberships that end are removed first (`until` is excluded), then those that start are
 * added one by one: a backward path search from the member to the group finds a cycle, and the
 * longest chain through the new membership measures the nesting. Reports the first cycle
 * found and the first excess of depth.
 */
function checkNesting(edges: readonly Edge[], maxDepth: number, add: Add): void {
  const starts = new Map<CivilDate, Edge[]>();
  const ends = new Map<CivilDate, Edge[]>();
  for (const edge of edges) {
    pushTo(starts, edge.span.from, edge);
    if (edge.span.until !== null) pushTo(ends, edge.span.until, edge);
  }
  const dates = [...new Set([...starts.keys(), ...ends.keys()])].sort();
  const down = new Graph();
  const up = new Graph();
  const added = new Set<Edge>();
  let cycleFound = false;
  let tooDeep = false;
  for (const date of dates) {
    for (const edge of ends.get(date) ?? []) {
      if (!added.delete(edge)) continue;
      down.remove(edge.group, edge.member);
      up.remove(edge.member, edge.group);
    }
    const starting = (starts.get(date) ?? []).sort(compareEdges);
    for (const edge of starting) {
      const back = down.path(edge.member, edge.group);
      if (back !== undefined) {
        if (!cycleFound) add('groups', cycleMessage([edge.group, ...back], date));
        cycleFound = true;
        continue;
      }
      down.add(edge.group, edge.member);
      up.add(edge.member, edge.group);
      added.add(edge);
      if (!tooDeep) {
        const depth =
          up.longest(edge.group, maxDepth + 1) + down.longest(edge.member, maxDepth + 1);
        if (depth > maxDepth) {
          add('groups', `group nesting deeper than ${maxDepth}`);
          tooDeep = true;
        }
      }
    }
  }
}

function pushTo(map: Map<CivilDate, Edge[]>, key: CivilDate, edge: Edge): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

function compareEdges(a: Edge, b: Edge): number {
  if (a.group !== b.group) return a.group < b.group ? -1 : 1;
  if (a.member !== b.member) return a.member < b.member ? -1 : 1;
  return 0;
}

/** `cycle A > B > A from <date>`, the cycle written from its smallest group name. */
function cycleMessage(cycle: readonly string[], date: CivilDate): string {
  let start = 0;
  cycle.forEach((name, i) => {
    if (name < (cycle[start] ?? name)) start = i;
  });
  const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
  const when = date === ALWAYS ? 'from the beginning' : `from ${date}`;
  return `cycle ${[...rotated, rotated[0] ?? ''].join(' > ')} ${when}`;
}

/** A directed multigraph of group names, with counted edges. */
class Graph {
  private readonly next = new Map<string, Map<string, number>>();

  add(from: string, to: string): void {
    const targets = this.next.get(from) ?? new Map<string, number>();
    targets.set(to, (targets.get(to) ?? 0) + 1);
    this.next.set(from, targets);
  }

  remove(from: string, to: string): void {
    const targets = this.next.get(from);
    const count = targets?.get(to) ?? 0;
    if (count > 1) targets?.set(to, count - 1);
    else targets?.delete(to);
  }

  /**
   * The nodes of a path from `from` to `to`, `from` included and `to` excluded
   * (`[from, …]`), or `undefined` when there is none. Breadth-first, iterative.
   */
  path(from: string, to: string): string[] | undefined {
    const parent = new Map<string, string | null>([[from, null]]);
    const queue = [from];
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head] ?? '';
      if (node === to) {
        const path: string[] = [];
        for (let at = parent.get(node); at !== null && at !== undefined; at = parent.get(at)) {
          path.unshift(at);
        }
        return path;
      }
      for (const target of [...(this.next.get(node)?.keys() ?? [])].sort()) {
        if (!parent.has(target)) {
          parent.set(target, node);
          queue.push(target);
        }
      }
    }
    return undefined;
  }

  /**
   * The number of nodes of the longest path starting at `from`, capped at `cap`: the search
   * never goes deeper than `cap`, so it never overflows the stack. Exact values are memoized;
   * a capped one is not. The graph is acyclic: a membership that would close a cycle is never
   * added.
   */
  longest(from: string, cap: number): number {
    const exact = new Map<string, number>();
    const walk = (node: string, budget: number): number => {
      const known = exact.get(node);
      if (known !== undefined) return Math.min(known, budget);
      if (budget <= 1) return 1;
      let best = 1;
      for (const target of this.next.get(node)?.keys() ?? []) {
        best = Math.max(best, 1 + walk(target, budget - 1));
        if (best >= budget) return budget;
      }
      exact.set(node, best);
      return best;
    };
    return walk(from, cap);
  }
}
