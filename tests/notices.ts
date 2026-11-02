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

/**
 * What `verifyProof` finds out of the trace and the definitions that have nothing to do with
 * the check under test: the notices about what was not checked, and the contradictions between
 * a trace entry and its definition (`definition-checks`, tested in proof-verify-closed). The
 * fixtures of the carrier and priority tests give each rule the definition of `ruleA`.
 */
const DEFINITION_CHECKS =
  /^(rule applied outside its window|applied model differs|applied output differs|skipped output differs|rule skipped as INACTIVE_DATE|CONDITION_FALSE on a rule|DIMENSION_MISMATCH on a rule|window not checked|reason not checked)/;
export const withoutDefinitionChecks = (issues: readonly string[]): string[] =>
  withoutUnchecked(issues).filter((issue) => !DEFINITION_CHECKS.test(issue));
