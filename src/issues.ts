/**
 * Internal to `@run-iq/spec`: the one bound on every list of problems the package returns
 * (`validateRuleDefinition`, `validateOutputDeclaration`, `validateReferential`,
 * `validateProof`, `verifyProof`, `validateProofInput`, `validateTemporalFact`, and the lists
 * that normalization reads its first problem from), so that a hostile value never makes a huge
 * list or a huge path.
 */

/** One problem found by a validator: the path of the value (`''` for the whole value). */
export interface RuleValidationIssue {
  path: string;
  message: string;
}

/**
 * The most problems one list holds: past it, one last issue says that further problems were
 * not listed.
 */
export const MAX_ISSUES = 100;

/**
 * The longest path, and the longest message, an issue gives, in UTF-16 code units: a longer one
 * is cut there (between two code points) and followed by `…`, so that a huge key or value never
 * makes a huge issue.
 */
export const MAX_ISSUE_TEXT = 1024;

/** The message of the last issue of a list that reached `MAX_ISSUES`. */
export const ISSUE_LIMIT_MESSAGE = `further problems not listed (limit ${MAX_ISSUES})`;

/**
 * Internal: `text` cut to `MAX_ISSUE_TEXT` code units, never inside a surrogate pair, then `…`.
 * The one cut of every issue text: `IssueList` applies it to each path and message, and a
 * function that throws the first problem a validator lists (`normalizeRuleDefinition`) applies
 * it to the message it throws, so both give the same text.
 */
export function boundIssueText(text: string): string {
  if (text.length <= MAX_ISSUE_TEXT) return text;
  const last = text.charCodeAt(MAX_ISSUE_TEXT - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return `${text.slice(0, splitsPair ? MAX_ISSUE_TEXT - 1 : MAX_ISSUE_TEXT)}…`;
}

/**
 * A list of problems in the order found, at most `MAX_ISSUES`; each path and each message cut
 * to `MAX_ISSUE_TEXT`. A problem past the limit is not kept: the list then ends with one last
 * issue `{ path: '', message: 'further problems not listed (limit 100)' }` (`toArray`).
 */
export class IssueList {
  private readonly entries: RuleValidationIssue[] = [];
  private dropped = false;

  /** Lists a problem; returns false (and keeps nothing) once `MAX_ISSUES` are listed. */
  add(path: string, message: string): boolean {
    if (this.entries.length >= MAX_ISSUES) {
      this.dropped = true;
      return false;
    }
    this.entries.push({ path: boundIssueText(path), message: boundIssueText(message) });
    return true;
  }

  /** Lists the problems of `other` after these, and its limit notice if it reached it. */
  merge(other: IssueList): void {
    for (const entry of other.entries) this.add(entry.path, entry.message);
    if (other.dropped) this.dropped = true;
  }

  /** The number of problems listed (the limit notice not counted). */
  get length(): number {
    return this.entries.length;
  }

  /** True once a problem was not listed: the list is full. */
  get full(): boolean {
    return this.dropped;
  }

  /** The problems, then the limit notice when a problem was not listed. */
  toArray(): RuleValidationIssue[] {
    const list = [...this.entries];
    if (this.dropped) list.push({ path: '', message: ISSUE_LIMIT_MESSAGE });
    return list;
  }

  /** The messages of `toArray`, in order. */
  messages(): string[] {
    return this.toArray().map((issue) => issue.message);
  }
}

/** `messages` bounded as an `IssueList` bounds them (path `''`), for lists of messages. */
export function boundMessages(messages: Iterable<string>): string[] {
  const list = new IssueList();
  for (const message of messages) {
    if (!list.add('', message)) break;
  }
  return list.messages();
}

/**
 * Internal: the single issue of a validator called with a `path` that is not a string (an
 * argument of the caller, not of the value checked); the validator returns it, never throws.
 */
export function pathArgumentIssue(path: unknown): RuleValidationIssue {
  return { path: '', message: `path must be a string, got a value of type ${typeof path}` };
}

/**
 * Internal: at most `MAX_ISSUES` messages, in the order found, but the items marked `fixed`
 * (the notices that say what a verifier did not check) are never cut: the other items give way
 * to them, and a last notice says how many were left out
 * (`further problems not listed (limit 100): n left out`).
 */
export function boundWithFixed(items: readonly { message: string; fixed?: true }[]): string[] {
  if (items.length <= MAX_ISSUES) return items.map((item) => item.message);
  const kept = items.filter((item) => item.fixed === true).length;
  let room = Math.max(0, MAX_ISSUES - kept - 1);
  let left = 0;
  const out: string[] = [];
  for (const item of items) {
    if (item.fixed === true) out.push(item.message);
    else if (room > 0) {
      room--;
      out.push(item.message);
    } else left++;
  }
  out.push(`further problems not listed (limit ${MAX_ISSUES}): ${left} left out`);
  return out;
}
