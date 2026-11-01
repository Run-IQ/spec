import type { JsonValue } from '../canonical.js';
import { OUTPUT_STATUSES } from '../decision/status.js';
import type { OutputStatus } from '../decision/status.js';
import { citeName } from '../errors.js';
import { parsePointer } from '../path/pointer.js';
import { append } from './collect.js';
import { combinationProblems, comparator, SELECTING } from './combination.js';
import type { Context, Target } from './combination.js';
import {
  causeProblems,
  completenessProblems,
  inCollection,
  pendingInOrder,
  rankProblems,
  samePending,
} from './completeness.js';
import type { Feed } from './completeness.js';
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
  for (const skip of p.skipped) {
    // A per output is fed by instances (D-21): an exclusion without subject is grouped.
    const perOutput = skip.output !== undefined && tries.has(skip.output);
    if (perOutput && skip.subject === undefined && skip.instances === undefined) {
      strays.push(`exclusion feeds no item: ${citeName(instanceKey(skip))}`);
    }
    exclude(skip, outputs, tries);
  }
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
  if (bounds !== undefined) append(issues, boundsProblems(bounds, undetermined, cite, output));
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
  context: Context,
): string[] {
  const issues: string[] = [];
  const nonPer = new Set<string>();
  for (const [name, output] of listed) {
    const cited = (): string => citeName(name);
    if (output.per === undefined) {
      append(issues, entryProblems(output, cited, output));
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
    append(
      issues,
      entryProblems(item, () => citeItem(item.output, item.subject), output),
    );
    if (!inCollection(output.per, item.subject)) {
      issues.push(`item outside its per collection: ${citeItem(item.output, item.subject)}`);
    }
  }
  const feeds = feedsOf(p, listed);
  append(issues, feeds.strays);
  const targets = targetsOf(p, listed, feeds);
  for (const { target, feed, pending } of targets) {
    append(issues, combinationProblems(target, context));
    if (!samePending(pending, feed.pending)) {
      issues.push(`pending differ from pending rules: ${target.cite()}`);
    } else if (!pendingInOrder(pending, feed, context.standings)) {
      issues.push(`pending not in contribution order: ${target.cite()}`);
    }
    append(issues, completenessProblems(target, feed, context.standings));
    append(issues, rankProblems(target));
  }
  append(issues, statusProblems(p, listed, feeds, targets));
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
        target: {
          ...output,
          cite: () => citeName(name),
          declaration,
          steps: direct.steps,
          whole: true,
        },
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
        whole: false,
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
  for (const { target, feed } of targets) append(issues, causeProblems(target, feed));
  return issues;
}
