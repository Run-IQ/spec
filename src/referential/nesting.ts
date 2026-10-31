import { citeName } from '../errors.js';
import type { CivilDate } from '../time/civil.js';

/** The start of a period with no `from`: before every civil date. */
export const ALWAYS = '';

/** A group-in-group membership: `group` holds `member` during `[from, until)`. */
export interface Edge {
  group: string;
  member: string;
  from: CivilDate;
  until: CivilDate | null;
}

/** Counts the elementary steps of the sweep; `limit` is the budget. */
export interface Work {
  steps: number;
  limit: number;
}

/** What the sweep found: the first cycle, the first excess of depth, or a spent budget. */
export interface NestingProblems {
  cycle?: string;
  tooDeep?: boolean;
  tooComplex?: boolean;
}

/** Thrown inside the sweep when the step budget is spent. */
class BudgetSpent {}

/**
 * Sweeps the dates where group-in-group memberships start and end, in order. At each date the
 * memberships that end are removed first (`until` is excluded), then those that start are added
 * one by one, in (group, member) order, and then the depth is measured:
 * - a cycle is found by a search that alternates one edge forward from the member and one edge
 *   backward from the group, and stops as soon as either side is exhausted: it costs at most
 *   twice the smaller of the two sides (descendants of the member, ancestors of the group);
 * - the longest chain through the new membership is the longest chain above the group plus
 *   the longest chain below the member. Both heights are cached per group; a change of
 *   membership marks the heights it may change as stale (the heights above for the groups
 *   below, the heights below for the groups above), stopping at groups already stale; a stale
 *   height is recomputed on demand, iteratively.
 *
 * Every edge read, mark and recomputation counts one step against `work.limit`; spending it
 * ends the sweep with `tooComplex`. Reports the first cycle and the first excess of depth.
 */
export function sweepNesting(
  edges: readonly Edge[],
  maxDepth: number,
  work: Work,
): NestingProblems {
  const problems: NestingProblems = {};
  try {
    sweep(edges, maxDepth, work, problems);
  } catch (error) {
    if (!(error instanceof BudgetSpent)) throw error;
    problems.tooComplex = true;
  }
  return problems;
}

function sweep(
  edges: readonly Edge[],
  maxDepth: number,
  work: Work,
  problems: NestingProblems,
): void {
  const starts = new Map<CivilDate, Edge[]>();
  const ends = new Map<CivilDate, Edge[]>();
  for (const edge of edges) {
    pushTo(starts, edge.from, edge);
    if (edge.until !== null) pushTo(ends, edge.until, edge);
  }
  const dates = [...new Set([...starts.keys(), ...ends.keys()])].sort();
  const graph = new Graph(work);
  const added = new Set<Edge>();
  for (const date of dates) {
    for (const edge of ends.get(date) ?? []) {
      graph.step();
      if (added.delete(edge)) graph.remove(edge.group, edge.member);
    }
    const starting: Edge[] = [];
    for (const edge of (starts.get(date) ?? []).sort(compareEdges)) {
      graph.step();
      const cycle = graph.cycle(edge.group, edge.member);
      if (cycle !== undefined) {
        problems.cycle ??= cycleMessage(cycle, date);
        continue;
      }
      graph.add(edge.group, edge.member);
      added.add(edge);
      starting.push(edge);
    }
    // Depth once every membership of the date is in: a new longest chain goes through one of
    // them, and each height is marked and recomputed at most once per date.
    for (const edge of problems.tooDeep ? [] : starting) {
      if (graph.above(edge.group) + graph.below(edge.member) > maxDepth) {
        problems.tooDeep = true;
        break;
      }
    }
    if (problems.cycle !== undefined && problems.tooDeep) return;
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
  return `cycle ${citeName([...rotated, rotated[0] ?? ''].join(' > '))} ${when}`;
}

/** Adjacency of one direction: node -> neighbour -> number of active memberships. */
type Adjacency = Map<string, Map<string, number>>;

/** One side of the alternating search: its queue, and the neighbours left of its head. */
interface Side {
  next: Adjacency;
  /** Each reached node -> the node it was reached from (`null` for the start). */
  from: Map<string, string | null>;
  queue: string[];
  head: number;
  pending: Iterator<string> | undefined;
}

/** The active memberships of one date, with cached heights. */
class Graph {
  private readonly children: Adjacency = new Map();
  private readonly parents: Adjacency = new Map();
  /** Groups on the longest chain going down from a group, itself included; exact unless stale. */
  private readonly heightBelow = new Map<string, number>();
  private readonly staleBelow = new Set<string>();
  /** Groups on the longest chain going up to a group, itself included; exact unless stale. */
  private readonly heightAbove = new Map<string, number>();
  private readonly staleAbove = new Set<string>();

  constructor(private readonly work: Work) {}

  step(): void {
    this.work.steps++;
    if (this.work.steps > this.work.limit) throw new BudgetSpent();
  }

  add(group: string, member: string): void {
    if (link(this.children, group, member) && link(this.parents, member, group)) {
      this.changed(group, member);
    }
  }

  remove(group: string, member: string): void {
    if (unlink(this.children, group, member) && unlink(this.parents, member, group)) {
      this.changed(group, member);
    }
  }

  /** `group` gained or lost `member`: heights below `group` and its ancestors, above `member`
   * and its descendants, may change. */
  private changed(group: string, member: string): void {
    this.mark(group, this.parents, this.staleBelow);
    this.mark(member, this.children, this.staleAbove);
  }

  /** Marks `start` and everything reached through `next` stale, stopping at stale nodes. */
  private mark(start: string, next: Adjacency, stale: Set<string>): void {
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head] ?? '';
      this.step();
      if (stale.has(node)) continue;
      stale.add(node);
      for (const neighbour of next.get(node)?.keys() ?? []) {
        this.step();
        if (!stale.has(neighbour)) queue.push(neighbour);
      }
    }
  }

  /** Groups on the longest chain going down from `node`, `node` included. */
  below(node: string): number {
    return this.height(node, this.children, this.heightBelow, this.staleBelow);
  }

  /** Groups on the longest chain going up to `node`, `node` included. */
  above(node: string): number {
    return this.height(node, this.parents, this.heightAbove, this.staleAbove);
  }

  /**
   * The cached height of `start`, recomputing the stale ones it depends on with an iterative
   * post-order walk (the graph is acyclic: a membership that closes a cycle is never added).
   * A node never computed is stale: it is absent from `heights`.
   */
  private height(
    start: string,
    next: Adjacency,
    heights: Map<string, number>,
    stale: Set<string>,
  ): number {
    const fresh = (node: string): boolean => heights.has(node) && !stale.has(node);
    const stack: { node: string; neighbours: Iterator<string>; best: number }[] = [];
    const open = (node: string): void => {
      stack.push({ node, neighbours: neighbours(next, node), best: 1 });
    };
    if (fresh(start)) return heights.get(start) ?? 1;
    open(start);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      this.step();
      const step = frame.neighbours.next();
      if (step.done) {
        heights.set(frame.node, frame.best);
        stale.delete(frame.node);
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent !== undefined) parent.best = Math.max(parent.best, 1 + frame.best);
        continue;
      }
      const neighbour = step.value;
      if (fresh(neighbour)) frame.best = Math.max(frame.best, 1 + (heights.get(neighbour) ?? 1));
      else open(neighbour);
    }
    return heights.get(start) ?? 1;
  }

  /**
   * The nodes of a cycle the membership `group ∋ member` would close (`[group, member, …]`), or
   * `undefined`. Alternates one edge forward from `member` and one edge backward from `group`;
   * a node reached by both sides closes the cycle; either side exhausted means there is none.
   */
  cycle(group: string, member: string): string[] | undefined {
    if (group === member) return [group];
    const forward = side(this.children, member);
    const backward = side(this.parents, group);
    for (;;) {
      const meetForward = this.advance(forward, backward);
      if (meetForward === null) return undefined;
      if (meetForward !== undefined) return closeCycle(group, forward, backward, meetForward);
      const meetBackward = this.advance(backward, forward);
      if (meetBackward === null) return undefined;
      if (meetBackward !== undefined) return closeCycle(group, forward, backward, meetBackward);
    }
  }

  /**
   * Reads one edge of `own`: the node where it meets `other`, `undefined` to go on, or `null`
   * when `own` is exhausted.
   */
  private advance(own: Side, other: Side): string | null | undefined {
    for (;;) {
      if (own.pending === undefined) {
        const node = own.queue[own.head];
        if (node === undefined) return null;
        own.head++;
        own.pending = neighbours(own.next, node);
        this.step();
        continue;
      }
      const result = own.pending.next();
      if (result.done) {
        own.pending = undefined;
        continue;
      }
      this.step();
      const neighbour = result.value;
      if (own.from.has(neighbour)) return undefined;
      const current = own.queue[own.head - 1] ?? '';
      own.from.set(neighbour, current);
      if (other.from.has(neighbour)) return neighbour;
      own.queue.push(neighbour);
      return undefined;
    }
  }
}

function neighbours(next: Adjacency, node: string): Iterator<string> {
  return (next.get(node) ?? new Map<string, number>()).keys();
}

function side(next: Adjacency, start: string): Side {
  return { next, from: new Map([[start, null]]), queue: [start], head: 0, pending: undefined };
}

/**
 * The cycle `group > member > … > meet > … > group`: the forward path from `member` to `meet`,
 * then the backward path from `meet` to `group`.
 */
function closeCycle(group: string, forward: Side, backward: Side, meet: string): string[] {
  const down: string[] = [];
  for (let at: string | null | undefined = meet; at != null; at = forward.from.get(at)) {
    down.unshift(at);
  }
  const up: string[] = [];
  for (let at = backward.from.get(meet); at != null; at = backward.from.get(at)) up.push(at);
  // `down` runs member..meet; `up` runs from after meet to group.
  const path = [group, ...down, ...up];
  path.pop(); // the closing `group`
  return path;
}

/** Adds one to `from -> to`; true when the link is new. */
function link(adjacency: Adjacency, from: string, to: string): boolean {
  const targets = adjacency.get(from) ?? new Map<string, number>();
  adjacency.set(from, targets);
  const count = targets.get(to) ?? 0;
  targets.set(to, count + 1);
  return count === 0;
}

/** Removes one from `from -> to`; true when the link is gone. */
function unlink(adjacency: Adjacency, from: string, to: string): boolean {
  const targets = adjacency.get(from);
  const count = targets?.get(to) ?? 0;
  if (count > 1) {
    targets?.set(to, count - 1);
    return false;
  }
  targets?.delete(to);
  return count === 1;
}
