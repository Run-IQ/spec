import type { JsonValue } from '../canonical.js';
import { OUTPUT_STATUSES } from '../decision/status.js';
import type { OutputStatus } from '../decision/status.js';
import { citeName } from '../errors.js';
import { formatPointer, parsePointer } from '../path/pointer.js';
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
import type { Ties } from './ties.js';
import type {
  ProofBounds,
  ProofItem,
  ProofOutput,
  ProofPending,
  ProofSelection,
  ProofSkip,
  ProofStep,
  ProofView,
} from './types.js';
import { isLifted, LIFTS } from './lifts.js';
import type { OutputIdentity } from './lifts.js';
import {
  NativeMap,
  NativeSet,
  arrayEvery,
  arrayFilter,
  arrayIndexOf,
  arrayPop,
  arrayPush,
  arraySlice,
  arraySome,
  mapGet,
  mapHas,
  mapSet,
  mapValues,
  mathMax,
  setAdd,
  setHas,
  setSize,
} from '../intrinsics.js';

/** The types whose values are ordered, so that bounds can hold them. */
const ORDERED: ReadonlySet<string> = new NativeSet([
  'number',
  'decimal',
  'enum',
  'date',
  'dateTime',
]);

const rankOf = (status: OutputStatus): number => arrayIndexOf(OUTPUT_STATUSES, status);

/** How messages cite an item: `name at subject`. */
export function citeItem(output: string, subject: string): string {
  return `${citeName(output)} at ${citeName(subject)}`;
}

const newFeed = (): Feed => ({
  steps: [],
  pending: [],
  waiting: [],
  candidates: -1,
  tie: false,
});

/** A node of the trie of the subjects of a per output: an item ends at it, or an exclusion. */
interface Node {
  children: Map<string, Node>;
  item?: Feed;
  skip: number;
  /** An exclusion of a rule a tie among exceptions reaches ends here. */
  tie: boolean;
}

const newNode = (): Node => ({ children: new NativeMap(), skip: -1, tie: false });

/**
 * The feeds of the items of one per output, by subject. A step or a pending rule goes to the
 * deepest item containing its subject; an exclusion counts for every item its subject contains
 * and for the deepest one containing it; one without subject, for every item. Linear in the
 * segments of the subjects: each is walked once in a trie.
 */
class ItemTrie {
  private readonly root = newNode();
  private everywhere = -1;
  private tiedEverywhere = false;

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

  /** An exclusion at `subject` (every item without), of status `rank`, `tie` when tied. */
  exclude(subject: string | undefined, rank: number, tie: boolean): void {
    if (subject === undefined) {
      this.everywhere = mathMax(this.everywhere, rank);
      this.tiedEverywhere ||= tie;
      return;
    }
    const containing = this.deepest(subject);
    if (containing !== undefined) {
      containing.candidates = mathMax(containing.candidates, rank);
      containing.tie ||= tie;
    }
    const node = this.walk(subject, true);
    if (node !== undefined) {
      node.skip = mathMax(node.skip, rank);
      node.tie ||= tie;
    }
  }

  /** Passes down the strongest exclusion of each node, and its ties, to the items below it. */
  settle(): void {
    const stack: [Node, number, boolean][] = [[this.root, this.everywhere, this.tiedEverywhere]];
    for (let next = arrayPop(stack); next !== undefined; next = arrayPop(stack)) {
      const [node, above, tiedAbove] = next;
      const rank = mathMax(above, node.skip);
      const tie = tiedAbove || node.tie;
      if (node.item !== undefined) {
        node.item.candidates = mathMax(node.item.candidates, rank);
        node.item.tie ||= tie;
      }
      for (const child of mapValues(node.children)) arrayPush(stack, [child, rank, tie]);
    }
  }

  private walk(subject: string, create: boolean, visit?: (node: Node) => void): Node | undefined {
    let node = this.root;
    for (const segment of parsePointer(subject)) {
      let child = mapGet(node.children, segment);
      if (child === undefined) {
        if (!create) return undefined;
        child = newNode();
        mapSet(node.children, segment, child);
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
  /**
   * The steps, pending rules and exclusions of a per output that feed no item, with the item
   * that would feed them (its output and element) when one could.
   */
  strays: Stray[];
}

function feedsOf(p: ProofView, listed: ReadonlyMap<string, ProofOutput>, ties: Ties): Feeds {
  const outputs = new NativeMap<string, Feed>();
  const items = new NativeMap<ProofItem, Feed>();
  const tries = new NativeMap<string, ItemTrie>();
  for (const [name, output] of listed) {
    if (output.per === undefined) mapSet(outputs, name, newFeed());
    else mapSet(tries, name, new ItemTrie());
  }
  for (const item of p.items) {
    const trie = mapGet(tries, item.output);
    if (trie === undefined) continue;
    const feed = newFeed();
    // A repeated item is reported by `orderProblems`; only the first is fed.
    if (trie.add(item.subject, feed)) mapSet(items, item, feed);
  }
  const strays: Stray[] = [];
  const route = (
    entry: ProofStep | ProofPending,
    output: string,
    what: string,
  ): Feed | undefined => {
    const direct = mapGet(outputs, output);
    if (direct !== undefined) return direct;
    const trie = mapGet(tries, output);
    if (trie === undefined) return undefined;
    const feed = entry.subject === undefined ? undefined : trie.deepest(entry.subject);
    if (feed === undefined) {
      const message = `${what} feeds no item: ${citeName(instanceKey(entry))}`;
      const item = elementOf(mapGet(listed, output)?.per, entry.subject);
      arrayPush(strays, item === undefined ? { message } : { message, output: { output, item } });
    }
    return feed;
  };
  for (const step of p.applied) {
    const feed = route(step, step.output, 'step');
    if (feed === undefined) continue;
    arrayPush(feed.steps, step);
    feed.tie ||= ties.reaches(step);
  }
  for (const entry of p.pending) {
    if (entry.output === undefined) continue;
    const feed = route(entry, entry.output, 'pending rule');
    if (feed === undefined) continue;
    arrayPush(feed.pending, entry.ruleId);
    arrayPush(feed.waiting, entry);
    feed.tie ||= ties.reaches(entry);
  }
  for (const skip of p.skipped) {
    // A per output is fed by instances (D-21): an exclusion without subject is grouped.
    const perOutput = skip.output !== undefined && mapHas(tries, skip.output);
    if (perOutput && skip.subject === undefined && skip.instances === undefined) {
      // Grouped (instances aside): no item, visible or not, would feed it.
      arrayPush(strays, { message: `exclusion feeds no item: ${citeName(instanceKey(skip))}` });
    }
    exclude(skip, outputs, tries, ties.reaches(skip));
  }
  for (const name of ties.shortCircuits) {
    const direct = mapGet(outputs, name);
    if (direct !== undefined) direct.tie = true;
    mapGet(tries, name)?.exclude(undefined, -1, true);
  }
  for (const trie of mapValues(tries)) trie.settle();
  return { outputs, items, strays };
}

function exclude(
  skip: ProofSkip,
  outputs: Map<string, Feed>,
  tries: Map<string, ItemTrie>,
  tie: boolean,
): void {
  if (skip.output === undefined) return;
  const rank = rankOf(skip.status);
  const direct = mapGet(outputs, skip.output);
  if (direct !== undefined) {
    direct.candidates = mathMax(direct.candidates, rank);
    direct.tie ||= tie;
  }
  mapGet(tries, skip.output)?.exclude(skip.subject, rank, tie);
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
    arrayPush(issues, `undetermined output has a value: ${cite()}`);
  }
  const { bounds } = entry;
  if (bounds !== undefined) append(issues, boundsProblems(bounds, undetermined, cite, output));
  if (entry.selected !== undefined) {
    if (undetermined) arrayPush(issues, `selected on an undetermined output: ${cite()}`);
    else if (!setHas(SELECTING, output.combine)) {
      arrayPush(issues, `selected on a ${output.combine} output: ${cite()}`);
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
  if (!setHas(ORDERED, output.type)) return [`bounds on an unordered output: ${cite()}`];
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
 *
 * With redacted entries (`context.hidden`), what a hidden entry could make true is not reported:
 * a step or pending rule feeding no item (`items`), pending rules missing from the trace
 * (`pending`), a per output's status above its items' (`items`), and the checks of
 * `combinationProblems`, `completenessProblems`, `rankProblems` and `causeProblems` that need
 * every step, exclusion, exception or rule. A visible output whose steps are all redacted is
 * then accepted; one weaker than a visible contribution is still refused.
 */
export function outputProblems(
  p: ProofView,
  listed: ReadonlyMap<string, ProofOutput>,
  context: Context,
): string[] {
  const issues: string[] = [];
  const nonPer = new NativeSet<string>();
  for (const [name, output] of listed) {
    const cited = (): string => citeName(name);
    if (output.per === undefined) {
      append(issues, entryProblems(output, cited, output));
      continue;
    }
    const { value, bounds, selected, contributors, pending } = output;
    if (value !== undefined || bounds !== undefined || selected !== undefined) {
      arrayPush(issues, `per output carries a value: ${cited()}`);
    }
    if (contributors.length > 0 || pending.length > 0) {
      arrayPush(issues, `per output carries contributors: ${cited()}`);
    }
  }
  for (const item of p.items) {
    const output = mapGet(listed, item.output);
    if (output === undefined) continue;
    if (output.per === undefined) {
      if (!setHas(nonPer, item.output))
        arrayPush(issues, `item of a non-per output: ${citeName(item.output)}`);
      setAdd(nonPer, item.output);
      continue;
    }
    append(
      issues,
      entryProblems(item, () => citeItem(item.output, item.subject), output),
    );
    if (!inCollection(output.per, item.subject)) {
      arrayPush(issues, `item outside its per collection: ${citeItem(item.output, item.subject)}`);
    }
  }
  const { hidden } = context;
  const feeds = feedsOf(p, listed, context.ties);
  // The item a stray step or pending rule feeds may be redacted.
  for (const { message, output } of feeds.strays) {
    if (output === undefined || !isLifted(hidden, LIFTS.itemsOfCollection, { message, output })) {
      arrayPush(issues, message);
    }
  }
  const targets = targetsOf(p, listed, feeds);
  for (const { target, feed, pending } of targets) {
    append(issues, combinationProblems(target, context));
    // A pending rule of the target may be redacted: its own pending rules are then a superset.
    if (!samePending(pending, feed.pending)) {
      const message = `pending differ from pending rules: ${target.cite()}`;
      if (
        !pendingHidden(pending, feed.pending, (id) =>
          isLifted(hidden, LIFTS.outputPending, {
            message,
            rule: { id },
            output: { output: target.place.output },
          }),
        )
      ) {
        arrayPush(issues, message);
      }
    } else if (!pendingInOrder(pending, feed, context.standings)) {
      arrayPush(issues, `pending not in contribution order: ${target.cite()}`);
    }
    append(issues, completenessProblems(target, feed, context.standings, hidden));
    append(issues, rankProblems(target, hidden));
  }
  append(issues, statusProblems(p, listed, feeds, targets, context));
  return issues;
}

/** A stray (`Feeds`): its message, and the item that would feed it, if any could. */
interface Stray {
  message: string;
  output?: OutputIdentity;
}

/**
 * The item of a per collection `per` that would contain `subject`: the element of the
 * collection it is under, or `undefined` when it is under none (no item could feed it).
 */
function elementOf(per: string | undefined, subject: string | undefined): string | undefined {
  if (per === undefined || subject === undefined) return undefined;
  const depth = parsePointer(per).length + 1;
  const segments = parsePointer(subject);
  if (segments.length < depth) return undefined;
  const element = formatPointer(arraySlice(segments, 0, depth));
  return inCollection(per, element) ? element : undefined;
}

/**
 * True when the pending rules a target lists (`named`) are those that feed it (`fed`) and
 * more, each listed once, and `hidden` is true for each rule more (a hidden pending entry of
 * it): the pending entries that would make them equal may be hidden.
 */
function pendingHidden(
  named: readonly string[],
  fed: readonly string[],
  hidden: (id: string) => boolean,
): boolean {
  const listed = new NativeSet(named);
  if (setSize(listed) !== named.length || arraySome(fed, (id) => !setHas(listed, id))) return false;
  const found = new NativeSet(fed);
  return arrayEvery(
    arrayFilter(named, (id) => !setHas(found, id)),
    hidden,
  );
}

interface Fed {
  target: Target;
  feed: Feed;
  pending: readonly string[];
}

/** The outputs without `per` and the items, as targets of combination, with their feeds. */
function targetsOf(p: ProofView, listed: ReadonlyMap<string, ProofOutput>, feeds: Feeds): Fed[] {
  const itemsOf = new NativeMap<string, ProofItem[]>();
  for (const item of p.items) {
    const list = mapGet(itemsOf, item.output);
    if (list === undefined) mapSet(itemsOf, item.output, [item]);
    else arrayPush(list, item);
  }
  const fed: Fed[] = [];
  for (const [name, output] of listed) {
    const declaration = declarationOf(output);
    const direct = mapGet(feeds.outputs, name);
    if (direct !== undefined) {
      arrayPush(fed, {
        target: {
          ...output,
          cite: () => citeName(name),
          declaration,
          steps: direct.steps,
          whole: true,
          place: { output: name },
        },
        feed: direct,
        pending: output.pending,
      });
      continue;
    }
    for (const item of mapGet(itemsOf, name) ?? []) {
      const feed = mapGet(feeds.items, item);
      if (feed === undefined) continue;
      const target: Target = {
        ...item,
        cite: () => citeItem(name, item.subject),
        declaration,
        steps: feed.steps,
        whole: false,
        place: { output: name, item: item.subject },
      };
      arrayPush(fed, { target, feed, pending: item.pending });
    }
  }
  return fed;
}

function statusProblems(
  p: ProofView,
  listed: ReadonlyMap<string, ProofOutput>,
  feeds: Feeds,
  targets: readonly Fed[],
  context: Context,
): string[] {
  const { hidden } = context;
  const issues: string[] = [];
  const strongest = new NativeMap<string, number>();
  for (const item of p.items) {
    if (!mapHas(feeds.items, item)) continue;
    mapSet(
      strongest,
      item.output,
      mathMax(mapGet(strongest, item.output) ?? 0, rankOf(item.status)),
    );
  }
  // A redacted item may be the strongest.
  for (const [name, output] of listed) {
    if (output.per === undefined) continue;
    const differs = rankOf(output.status) !== (mapGet(strongest, name) ?? 0);
    const message = `per output status differs from its items: ${citeName(name)}`;
    const item = { output: name };
    if (differs && !isLifted(hidden, LIFTS.perOutputItems, { message, output: item })) {
      arrayPush(issues, message);
    }
  }
  for (const { target, feed } of targets) {
    append(issues, causeProblems(target, feed, hidden, context.ties.uncertain));
  }
  return issues;
}
