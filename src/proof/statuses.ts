import type { JsonValue } from '../canonical.js';
import { OUTPUT_STATUSES } from '../decision/status.js';
import type { OutputStatus } from '../decision/status.js';
import { citeName } from '../errors.js';
import { parsePointer } from '../path/pointer.js';
import { qualifyName } from '../rule/ruleSet.js';
import { combinationProblems, comparator, SELECTING } from './combination.js';
import type { Target } from './combination.js';
import { declarationOf, instanceKey } from './output-values.js';
import type {
  ProofBounds,
  ProofItem,
  ProofOutput,
  ProofPending,
  ProofSelection,
  ProofSkip,
  ProofStep,
  UnsignedProof,
} from './types.js';

/** The types whose values are ordered, so that bounds can hold them. */
const ORDERED: ReadonlySet<string> = new Set(['number', 'decimal', 'enum', 'date', 'dateTime']);

const rankOf = (status: OutputStatus): number => OUTPUT_STATUSES.indexOf(status);

/** How messages cite an item: `name at subject`. */
export function citeItem(output: string, subject: string): string {
  return `${citeName(output)} at ${citeName(subject)}`;
}

/** What one output or item receives: steps, pending rules, and the strongest candidate. */
interface Feed {
  steps: ProofStep[];
  /** The ids of the pending rules, and their entries. */
  pending: string[];
  waiting: ProofPending[];
  /** The rank of the strongest exclusion that would have fed it, -1 when none. */
  candidates: number;
}

const newFeed = (): Feed => ({ steps: [], pending: [], waiting: [], candidates: -1 });

/** A node of the trie of the subjects of a per output: an item ends at it, or an exclusion. */
interface Node {
  children: Map<string, Node>;
  item?: Feed;
  skip: number;
}

const newNode = (): Node => ({ children: new Map(), skip: -1 });

/**
 * The feeds of the items of one per output, by subject. A step or a pending rule goes to the
 * deepest item containing its subject; an exclusion counts for every item its subject contains
 * and for the deepest one containing it; one without subject, for every item. Linear in the
 * segments of the subjects: each is walked once in a trie.
 */
class ItemTrie {
  private readonly root = newNode();
  private everywhere = -1;

  /** Adds an item; false when one with this subject is already there (a duplicate). */
  add(subject: string, feed: Feed): boolean {
    const node = this.walk(subject, true);
    if (node === undefined || node.item !== undefined) return false;
    node.item = feed;
    return true;
  }

  /** The feed of the deepest item containing `subject`, if any. */
  deepest(subject: string): Feed | undefined {
    let found: Feed | undefined;
    this.walk(subject, false, (node) => {
      if (node.item !== undefined) found = node.item;
    });
    return found;
  }

  exclude(subject: string | undefined, rank: number): void {
    if (subject === undefined) {
      this.everywhere = Math.max(this.everywhere, rank);
      return;
    }
    const containing = this.deepest(subject);
    if (containing !== undefined) containing.candidates = Math.max(containing.candidates, rank);
    const node = this.walk(subject, true);
    if (node !== undefined) node.skip = Math.max(node.skip, rank);
  }

  /** Passes down the strongest exclusion of each node to the items below it. */
  settle(): void {
    const stack: [Node, number][] = [[this.root, this.everywhere]];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      const [node, above] = next;
      const rank = Math.max(above, node.skip);
      if (node.item !== undefined) node.item.candidates = Math.max(node.item.candidates, rank);
      for (const child of node.children.values()) stack.push([child, rank]);
    }
  }

  private walk(subject: string, create: boolean, visit?: (node: Node) => void): Node | undefined {
    let node = this.root;
    for (const segment of parsePointer(subject)) {
      let child = node.children.get(segment);
      if (child === undefined) {
        if (!create) return undefined;
        child = newNode();
        node.children.set(segment, child);
      }
      node = child;
      visit?.(node);
    }
    return node;
  }
}

/** The per outputs, non-per outputs and items of `p`, each fed from the trace. */
interface Feeds {
  outputs: Map<string, Feed>;
  items: Map<ProofItem, Feed>;
  /** `step feeds no item`, `pending rule feeds no item`, in trace order. */
  strays: string[];
}

function feedsOf(p: UnsignedProof, listed: ReadonlyMap<string, ProofOutput>): Feeds {
  const outputs = new Map<string, Feed>();
  const items = new Map<ProofItem, Feed>();
  const tries = new Map<string, ItemTrie>();
  for (const [name, output] of listed) {
    if (output.per === undefined) outputs.set(name, newFeed());
    else tries.set(name, new ItemTrie());
  }
  for (const item of p.items) {
    const trie = tries.get(item.output);
    if (trie === undefined) continue;
    const feed = newFeed();
    // A repeated item is reported by `orderProblems`; only the first is fed.
    if (trie.add(item.subject, feed)) items.set(item, feed);
  }
  const strays: string[] = [];
  const route = (
    entry: ProofStep | ProofPending,
    output: string,
    what: string,
  ): Feed | undefined => {
    const direct = outputs.get(output);
    if (direct !== undefined) return direct;
    const trie = tries.get(output);
    if (trie === undefined) return undefined;
    const feed = entry.subject === undefined ? undefined : trie.deepest(entry.subject);
    if (feed === undefined) strays.push(`${what} feeds no item: ${citeName(instanceKey(entry))}`);
    return feed;
  };
  for (const step of p.applied) route(step, step.output, 'step')?.steps.push(step);
  for (const entry of p.pending) {
    if (entry.output === undefined) continue;
    const feed = route(entry, entry.output, 'pending rule');
    feed?.pending.push(entry.ruleId);
    feed?.waiting.push(entry);
  }
  for (const skip of p.skipped) exclude(skip, outputs, tries);
  for (const trie of tries.values()) trie.settle();
  return { outputs, items, strays };
}

function exclude(skip: ProofSkip, outputs: Map<string, Feed>, tries: Map<string, ItemTrie>): void {
  if (skip.output === undefined) return;
  const rank = rankOf(skip.status);
  const direct = outputs.get(skip.output);
  if (direct !== undefined) direct.candidates = Math.max(direct.candidates, rank);
  tries.get(skip.output)?.exclude(skip.subject, rank);
}

/** What an output and an item share: a status, a value, bounds, a selection. */
interface Entry {
  status: OutputStatus;
  value?: JsonValue;
  bounds?: ProofBounds;
  selected?: ProofSelection;
}

/** The problems of the status, value, bounds and selection of an output or an item. */
function entryProblems(entry: Entry, cite: () => string, output: ProofOutput): string[] {
  const issues: string[] = [];
  const undetermined = entry.status === 'undetermined';
  if (undetermined && entry.value !== undefined) {
    issues.push(`undetermined output has a value: ${cite()}`);
  }
  const { bounds } = entry;
  if (bounds !== undefined) issues.push(...boundsProblems(bounds, undetermined, cite, output));
  if (entry.selected !== undefined) {
    if (undetermined) issues.push(`selected on an undetermined output: ${cite()}`);
    else if (!SELECTING.has(output.combine)) {
      issues.push(`selected on a ${output.combine} output: ${cite()}`);
    }
  }
  return issues;
}

function boundsProblems(
  bounds: ProofBounds,
  undetermined: boolean,
  cite: () => string,
  output: ProofOutput,
): string[] {
  if (!undetermined) return [`bounds on a settled output: ${cite()}`];
  const { min, max } = bounds;
  if (min === undefined && max === undefined) return [`bounds without min or max: ${cite()}`];
  if (!ORDERED.has(output.type)) return [`bounds on an unordered output: ${cite()}`];
  const compare = comparator(declarationOf(output));
  if (min !== undefined && max !== undefined && compare(min, max) === 1) {
    return [`bounds min above max: ${cite()}`];
  }
  return [];
}

/**
 * True when `subject` is an element of the collection `per` (`/foyers/*\/personnes`): its
 * segments are those of `per`, each `*` an element segment (`@<key>`), then one element
 * segment (D-2). A subject deeper or shallower, an index, a group or a time segment is not.
 */
function inCollection(per: string, subject: string): boolean {
  const pattern = parsePointer(per);
  const segments = parsePointer(subject);
  if (segments.length !== pattern.length + 1) return false;
  const element = (segment: string | undefined): boolean => segment?.startsWith('@') === true;
  return (
    pattern.every((part, i) => (part === '*' ? element(segments[i]) : part === segments[i])) &&
    element(segments[pattern.length])
  );
}

/** The priority of each listed rule, by qualified id and version (`id@version`). */
export type Priorities = ReadonlyMap<string, number>;

/**
 * The completeness of an output or item (D-7, the table of Task 9M2): a pending rule that feeds
 * it makes it `undetermined`, except an `any` with a `true` contribution, an `all` with a
 * `false` one, and a `highestPriority` whose winner (the step `selected` names) has a priority
 * strictly above that of every pending rule feeding it (the priorities the proof records in
 * `rules`; an unknown one never outranks). An `undetermined` one has a cause: a pending rule,
 * or, for an `all` no rule reached without `empty`, its own emptiness (`emptyOutput`).
 */
function completenessProblems(target: Target, feed: Feed, priorities: Priorities): string[] {
  const { combine, empty } = target.declaration;
  const pending = feed.pending.length > 0;
  if (target.status === 'undetermined') {
    const emptyAll = combine === 'all' && feed.steps.length === 0 && empty !== true;
    return pending || emptyAll ? [] : [`undetermined output without a cause: ${target.cite()}`];
  }
  if (!pending) return [];
  if (combine === 'highestPriority' && outranksPending(target, feed, priorities)) return [];
  const decisive = combine === 'any' ? true : combine === 'all' ? false : undefined;
  if (decisive !== undefined && feed.steps.some((step) => step.contribution === decisive)) {
    return [];
  }
  return [`settled output with pending rules: ${target.cite()}`];
}

/** True when the winner of `target` has a known priority above every pending rule's. */
function outranksPending(target: Target, feed: Feed, priorities: Priorities): boolean {
  const { selected } = target;
  if (selected === undefined) return false;
  const winner = feed.steps.find(
    (step) => step.ruleId === selected.ruleId && step.subject === selected.subject,
  );
  const top = winner === undefined ? undefined : priorities.get(instanceRule(winner));
  if (top === undefined) return false;
  return feed.waiting.every((entry) => {
    const priority = priorities.get(instanceRule(entry));
    return priority !== undefined && priority < top;
  });
}

const instanceRule = (entry: { ruleId: string; version: number }): string =>
  `${entry.ruleId}@${entry.version}`;

/** True when the rule ids `pending` are, as a set, the rules listed in `named`. */
function samePending(named: readonly string[], pending: readonly string[]): boolean {
  const expected = new Set(pending);
  const given = new Set(named);
  return (
    given.size === named.length &&
    given.size === expected.size &&
    named.every((id) => expected.has(id))
  );
}

/**
 * Internal: the problems of the outputs and items of `p` (`listed`: each output name, first
 * entry), in this order: their status, value, bounds and selection, as outputs and items
 * (`undetermined output has a value`, `bounds on a settled output`, …; a per output carries no
 * value, bounds, selection, contributors nor pending rules; an item belongs to a per output);
 * the steps and pending rules of a per output that no item contains; then, by output and its
 * items, whether the value follows from the contributions (`combinationProblems`) and the
 * pending rules are those of the `pending` section; then the statuses: a per output's is the
 * strongest of its items' (determined without item), and no output or item is weaker than a
 * contribution or a candidate exclusion that feeds it.
 */
export function outputProblems(
  p: UnsignedProof,
  listed: ReadonlyMap<string, ProofOutput>,
  imposed: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  const priorities = new Map<string, number>();
  for (const rule of p.rules) {
    priorities.set(`${qualifyName(rule.ruleSet, rule.id)}@${rule.version}`, rule.priority);
  }
  const nonPer = new Set<string>();
  for (const [name, output] of listed) {
    const cited = (): string => citeName(name);
    if (output.per === undefined) {
      issues.push(...entryProblems(output, cited, output));
      continue;
    }
    const { value, bounds, selected, contributors, pending } = output;
    if (value !== undefined || bounds !== undefined || selected !== undefined) {
      issues.push(`per output carries a value: ${cited()}`);
    }
    if (contributors.length > 0 || pending.length > 0) {
      issues.push(`per output carries contributors: ${cited()}`);
    }
  }
  for (const item of p.items) {
    const output = listed.get(item.output);
    if (output === undefined) continue;
    if (output.per === undefined) {
      if (!nonPer.has(item.output))
        issues.push(`item of a non-per output: ${citeName(item.output)}`);
      nonPer.add(item.output);
      continue;
    }
    issues.push(...entryProblems(item, () => citeItem(item.output, item.subject), output));
    if (!inCollection(output.per, item.subject)) {
      issues.push(`item outside its per collection: ${citeItem(item.output, item.subject)}`);
    }
  }
  const feeds = feedsOf(p, listed);
  issues.push(...feeds.strays);
  const targets = targetsOf(p, listed, feeds);
  for (const { target, feed, pending } of targets) {
    issues.push(...combinationProblems(target, imposed));
    if (!samePending(pending, feed.pending)) {
      issues.push(`pending differ from pending rules: ${target.cite()}`);
    }
    issues.push(...completenessProblems(target, feed, priorities));
  }
  issues.push(...statusProblems(p, listed, feeds, targets));
  return issues;
}

interface Fed {
  target: Target;
  feed: Feed;
  pending: readonly string[];
}

/** The outputs without `per` and the items, as targets of combination, with their feeds. */
function targetsOf(
  p: UnsignedProof,
  listed: ReadonlyMap<string, ProofOutput>,
  feeds: Feeds,
): Fed[] {
  const itemsOf = new Map<string, ProofItem[]>();
  for (const item of p.items) {
    const list = itemsOf.get(item.output);
    if (list === undefined) itemsOf.set(item.output, [item]);
    else list.push(item);
  }
  const fed: Fed[] = [];
  for (const [name, output] of listed) {
    const declaration = declarationOf(output);
    const direct = feeds.outputs.get(name);
    if (direct !== undefined) {
      fed.push({
        target: { ...output, cite: () => citeName(name), declaration, steps: direct.steps },
        feed: direct,
        pending: output.pending,
      });
      continue;
    }
    for (const item of itemsOf.get(name) ?? []) {
      const feed = feeds.items.get(item);
      if (feed === undefined) continue;
      const target: Target = {
        ...item,
        cite: () => citeItem(name, item.subject),
        declaration,
        steps: feed.steps,
      };
      fed.push({ target, feed, pending: item.pending });
    }
  }
  return fed;
}

function statusProblems(
  p: UnsignedProof,
  listed: ReadonlyMap<string, ProofOutput>,
  feeds: Feeds,
  targets: readonly Fed[],
): string[] {
  const issues: string[] = [];
  const strongest = new Map<string, number>();
  for (const item of p.items) {
    if (!feeds.items.has(item)) continue;
    strongest.set(item.output, Math.max(strongest.get(item.output) ?? 0, rankOf(item.status)));
  }
  for (const [name, output] of listed) {
    if (output.per === undefined) continue;
    if (rankOf(output.status) !== (strongest.get(name) ?? 0)) {
      issues.push(`per output status differs from its items: ${citeName(name)}`);
    }
  }
  for (const { target, feed } of targets) {
    const rank = rankOf(target.status);
    if (feed.steps.some((step) => rankOf(step.status) > rank)) {
      issues.push(`output status weaker than its contributions: ${target.cite()}`);
    }
    if (feed.candidates > rank)
      issues.push(`output status weaker than its candidates: ${target.cite()}`);
  }
  return issues;
}
