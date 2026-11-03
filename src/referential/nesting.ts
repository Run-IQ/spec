import { citeName } from '../errors.js';
import type { CivilDate } from '../time/civil.js';
import {
  NativeMap,
  NativeSet,
  arrayForEach,
  arrayJoin,
  arrayPop,
  arrayPush,
  arraySlice,
  arraySort,
  arrayUnshift,
  mapDelete,
  mapGet,
  mapHas,
  mapIteratorNext,
  mapKeys,
  mapSet,
  mathMax,
  setAdd,
  setDelete,
  setHas,
} from '../intrinsics.js';

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
  const starts = new NativeMap<CivilDate, Edge[]>();
  const ends = new NativeMap<CivilDate, Edge[]>();
  for (const edge of edges) {
    pushTo(starts, edge.from, edge);
    if (edge.until !== null) pushTo(ends, edge.until, edge);
  }
  const dates = arraySort([...new NativeSet([...mapKeys(starts), ...mapKeys(ends)])]);
  const graph = new Graph(work);
  const added = new NativeSet<Edge>();
  for (const date of dates) {
    for (const edge of mapGet(ends, date) ?? []) {
      graph.step();
      if (setDelete(added, edge)) graph.remove(edge.group, edge.member);
    }
    const starting: Edge[] = [];
    for (const edge of arraySort(mapGet(starts, date) ?? [], compareEdges)) {
      graph.step();
      const cycle = graph.cycle(edge.group, edge.member);
      if (cycle !== undefined) {
        problems.cycle ??= cycleMessage(cycle, date);
        continue;
      }
      graph.add(edge.group, edge.member);
      setAdd(added, edge);
      arrayPush(starting, edge);
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
  const list = mapGet(map, key);
  if (list) arrayPush(list, edge);
  else mapSet(map, key, [edge]);
}

function compareEdges(a: Edge, b: Edge): number {
  if (a.group !== b.group) return a.group < b.group ? -1 : 1;
  if (a.member !== b.member) return a.member < b.member ? -1 : 1;
  return 0;
}

/** `cycle A > B > A from <date>`, the cycle written from its smallest group name. */
function cycleMessage(cycle: readonly string[], date: CivilDate): string {
  let start = 0;
  arrayForEach(cycle, (name, i) => {
    if (name < (cycle[start] ?? name)) start = i;
  });
  const rotated = [...arraySlice(cycle, start), ...arraySlice(cycle, 0, start)];
  const when = date === ALWAYS ? 'from the beginning' : `from ${date}`;
  return `cycle ${citeName(arrayJoin([...rotated, rotated[0] ?? ''], ' > '))} ${when}`;
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
  private readonly children: Adjacency = new NativeMap();
  private readonly parents: Adjacency = new NativeMap();
  /** Groups on the longest chain going down from a group, itself included; exact unless stale. */
  private readonly heightBelow = new NativeMap<string, number>();
  private readonly staleBelow = new NativeSet<string>();
  /** Groups on the longest chain going up to a group, itself included; exact unless stale. */
  private readonly heightAbove = new NativeMap<string, number>();
  private readonly staleAbove = new NativeSet<string>();

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
      if (setHas(stale, node)) continue;
      setAdd(stale, node);
      const adjacent = mapGet(next, node);
      for (const neighbour of adjacent === undefined ? [] : mapKeys(adjacent)) {
        this.step();
        if (!setHas(stale, neighbour)) arrayPush(queue, neighbour);
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
    const fresh = (node: string): boolean => mapHas(heights, node) && !setHas(stale, node);
    const stack: { node: string; neighbours: Iterator<string>; best: number }[] = [];
    const open = (node: string): void => {
      arrayPush(stack, { node, neighbours: neighbours(next, node), best: 1 });
    };
    if (fresh(start)) return mapGet(heights, start) ?? 1;
    open(start);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      this.step();
      const step = mapIteratorNext(frame.neighbours);
      if (step.done) {
        mapSet(heights, frame.node, frame.best);
        setDelete(stale, frame.node);
        arrayPop(stack);
        const parent = stack[stack.length - 1];
        if (parent !== undefined) parent.best = mathMax(parent.best, 1 + frame.best);
        continue;
      }
      const neighbour = step.value;
      if (fresh(neighbour)) frame.best = mathMax(frame.best, 1 + (mapGet(heights, neighbour) ?? 1));
      else open(neighbour);
    }
    return mapGet(heights, start) ?? 1;
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
      const result = mapIteratorNext(own.pending);
      if (result.done) {
        own.pending = undefined;
        continue;
      }
      this.step();
      const neighbour = result.value;
      if (mapHas(own.from, neighbour)) return undefined;
      const current = own.queue[own.head - 1] ?? '';
      mapSet(own.from, neighbour, current);
      if (mapHas(other.from, neighbour)) return neighbour;
      arrayPush(own.queue, neighbour);
      return undefined;
    }
  }
}

function neighbours(next: Adjacency, node: string): Iterator<string> {
  return mapKeys(mapGet(next, node) ?? new NativeMap<string, number>());
}

function side(next: Adjacency, start: string): Side {
  return {
    next,
    from: new NativeMap([[start, null]]),
    queue: [start],
    head: 0,
    pending: undefined,
  };
}

/**
 * The cycle `group > member > … > meet > … > group`: the forward path from `member` to `meet`,
 * then the backward path from `meet` to `group`.
 */
function closeCycle(group: string, forward: Side, backward: Side, meet: string): string[] {
  const down: string[] = [];
  for (let at: string | null | undefined = meet; at != null; at = mapGet(forward.from, at)) {
    arrayUnshift(down, at);
  }
  const up: string[] = [];
  for (let at = mapGet(backward.from, meet); at != null; at = mapGet(backward.from, at))
    arrayPush(up, at);
  // `down` runs member..meet; `up` runs from after meet to group.
  const path = [group, ...down, ...up];
  arrayPop(path); // the closing `group`
  return path;
}

/** Adds one to `from -> to`; true when the link is new. */
function link(adjacency: Adjacency, from: string, to: string): boolean {
  const targets = mapGet(adjacency, from) ?? new NativeMap<string, number>();
  mapSet(adjacency, from, targets);
  const count = mapGet(targets, to) ?? 0;
  mapSet(targets, to, count + 1);
  return count === 0;
}

/** Removes one from `from -> to`; true when the link is gone. */
function unlink(adjacency: Adjacency, from: string, to: string): boolean {
  const targets = mapGet(adjacency, from);
  const count = (targets === undefined ? undefined : mapGet(targets, to)) ?? 0;
  if (count > 1) {
    if (targets !== undefined) mapSet(targets, to, count - 1);
    return false;
  }
  if (targets !== undefined) mapDelete(targets, to);
  return count === 1;
}
