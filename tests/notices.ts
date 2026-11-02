/**
 * The notices `verifyProof` adds to a verdict that is not `invalid` (Task 9K5): what the call did
 * not check. Tests of the consistency checks look at the problems, not at these.
 */
export const RULES_NOT_CHECKED =
  'rules not checked: pass rules to compare checksums, priorities and carriers';
export const NOT_REPLAYED =
  'conditions and amounts not checked: verifyProof does not replay the decision';

/** `issues` without the notices about what was not checked. */
export const withoutUnchecked = (issues: readonly string[]): string[] =>
  issues.filter((issue) => issue !== RULES_NOT_CHECKED && issue !== NOT_REPLAYED);

/** The two notices of a call without `rules`, in order. */
export const UNCHECKED = [RULES_NOT_CHECKED, NOT_REPLAYED];

/** Kept under its old name for the carrier tests: only the two fixed notices are dropped. */
export const withoutDefinitionChecks = withoutUnchecked;
