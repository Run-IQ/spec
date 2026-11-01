import { MAX_ISSUES } from '../issues.js';

// Internal to `@run-iq/spec`: how the consistency checks of a proof gather their problems. A
// list can hold as many entries as the proof (10 000 000 values): never spread it into the
// arguments of a call (`push(...list)` overflows the call stack), and stop once the issues
// `verifyProof` lists, and the one that says more were found, are there.

/** Enough problems to list `MAX_ISSUES` and say that further ones were found. */
export const ISSUE_CAP = MAX_ISSUES + 1;

/** True when `issues` holds `ISSUE_CAP` problems: further ones are not gathered. */
export const full = (issues: readonly string[]): boolean => issues.length >= ISSUE_CAP;

/** Appends the problems of `source` to `issues`, one by one, up to `ISSUE_CAP`. */
export function append(issues: string[], source: Iterable<string>): void {
  for (const issue of source) {
    if (full(issues)) return;
    issues.push(issue);
  }
}

/** Appends `source` to `target` one by one (any length): never through call arguments. */
export function extend<T>(target: T[], source: Iterable<T>): void {
  for (const item of source) target.push(item);
}
