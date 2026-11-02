# CLAUDE.md

Run-IQ is a generic decision engine: every decision comes with a verifiable proof. This file is read first by any Claude session working in this repository, a new cloud session included. It holds what the owner has decided, and it is binding.

## 1. Founding principle: correctness and fail-closed behaviour come first

They come before convenience, compatibility and dates. The reputation of Run-IQ depends on them.

1. **The engine never guesses.** It applies only what is declared explicitly: the data given, the caller's declarations (scope, completeness, how a fact is justified) and the pack's rules. Each declaration is recorded in the proof.
2. **Nothing passes silently.** A fault either fails what it touches, or marks it with an explicit status: a pending rule with its reason, an output with its status, a verdict with its problem. Never accepted: a hiding default, a swallowed error, or a quiet diagnostic under a result that looks certain.
3. **A fault stops at what it touches.** A faulty rule makes only its outputs pending. The whole evaluation is refused for an invalid input, a failing plugin, a tampered rule or a failed save.
4. **Only rules in force have an effect.** A beaten, skipped or pending rule imposes nothing. While it is unknown whether a rule is in force, its effect is pending too.
5. **A verifier never means "trust".** It says `authentic` only for what it checked, and it says what it did not check.

You apply this yourself, in every job. The machine audit is a second net, not the first.

## 2. Fail-closed checklist

Check every changed line for:

1. **Swallowed errors.** A `catch` that returns a default, `continue`s, or only logs, when the fault changes the result.
2. **Defaults that hide an absence.** `?? 0`, `?? ''`, `|| []`, `?? true` on data that should exist; an absent value read as `false`, `0` or "no constraint".
3. **Leniency on unknown things.** An unknown field, key, option, kind or reason accepted without a signal where it changes meaning. A misspelled name must fail and name the field.
4. **Coercion.** Truthiness instead of `=== true`; a string, `NaN`, `-0` or an unsafe integer passing as a number; `null` read as absence.
5. **The checked copy and the used copy are not the same.** Getters, Proxies, a value read several times, input rewritten after a check.
6. **Plugins.** Any hook failure, malformed return, invalid input, rule rewritten under the same `id@version`, rule dropped without a skip, or change to the decision in `afterEvaluate` makes the evaluation fail with `PluginHookError`.
7. **Verdicts too kind.** A verifier that returns `authentic` or `consistent` while it skipped a check, without a notice; `consistent` where `invalid` is warranted; a revocation or an unsupported kind not refused.
8. **Limits.** Every limit is enforced, never truncated or clamped silently, and is held by a test.
9. **Integrity and storage.** A checksum mismatch, a failed save, a proof that cannot be sealed: the evaluation fails, and no decision comes out without its stored proof.
10. **Tests that cannot fail.** Every safety rule has a test that fails when the rule is removed. Show it by a mutation check in the PR.

**Every PR body has a "Fail-closed" section.** It lists every place where the change refuses, fails or marks something, and confirms that items 1 to 10 were checked. A finding against this checklist is never "minor enough to leave".

Other rigour: write the test first and show it failing; exact assertions; one mutation check per behavioural change; replay the full CI at the lockfile versions on Node 20 before asking for an audit; CI green before "audit OK". Public text is in English, with no em dash and no arrows in prose, and never uses the old internal names of the product.

## 3. Loop protocol with the machine session

The cloud session (you) and the machine session (on the owner's computer) talk only through the GitHub issue `Run-IQ/.github#1` and the pull requests. The owner does not intervene in the loop.

- **Branches.** One `cloud/<task>` branch per job, cut from `refonte/phase-2`. Pull requests go into `refonte/phase-2`.
- **Lanes.** Two cloud sessions work in parallel: **lane A** and **lane B**, with the machine session. A lane is a session, not a repo: each job names the repos it works in, and a lane works only in those. The current job names the lane that works here; that lane alone works in this repo until its job is merged. Two lanes never work in the same repo at the same time. When a job needs a change in a repo the job does not name, post what is needed and wait for the machine session's ruling. Cross-lane dependencies are decided by the machine session; lanes never coordinate directly. Each repo a lane enters later gets this same `CLAUDE.md` in that lane's first PR there.
- **Comments.** Every comment you post starts with `Cloud session (lane A):` or `Cloud session (lane B):`. The machine session's start with `Machine session (lane A):`, `Machine session (lane B):` or `Machine session (all lanes):`; a `Machine session: DECISION` post counts as all lanes. A lane acts only on comments for its own lane or for all lanes, and never answers, comments on or acts on the other lane's jobs, audits or PRs. Earlier comments with no lane tag belonged to lane A, except Job 5, which is lane B. An audit is posted on the PR, with a one-line tagged notice on #1.
- **Sequence.** `Cloud session (lane B): ready for audit <PR link>`, then audit comments, then `fixes pushed` (one answer per finding, by number, Minor ones included), repeated until the audit OK.
- **Merge.** Only after `Machine session (lane B): audit OK <your PR link>` (your own lane's tag; the untagged `Machine session: audit OK` of past PRs is accepted too), and only if the comment names **your** PR, with CI green and the base unchanged: a fast-forward only, `git push origin cloud/<task>:refonte/phase-2`. Then post `merged <sha>` and wait for the next job. Commits are kept, never squashed.
- **Owner questions.** For a product, licence or irreversible choice, any publish, tag or release, any push to `master` or `main`, deleting a repository or another branch, a change to a repo the job does not name, or a budget choice: post `Cloud session (lane B): BLOCKED (owner decision) <why>` and wait.
- **Waiting.** Never end the session while waiting: poll issue #1 and the PR every 2 minutes for a new comment whose body **starts with** `Machine session`, then keep only those tagged with your lane, `(all lanes)` or `DECISION` (a pattern of `Machine session:` alone would miss the tagged ones). Re-arm the watch when it expires, and check its pattern when the comment format changes.
- **No footers.** No "Generated with", no `Co-Authored-By`, no signature line in commits, pull requests or comments. Tools that append one (`gh api`, some MCP create calls) must be followed by an edit that removes it, then checked.
- **The owner is the sole author** of every commit: check `git config user.name` and `user.email` before the first commit of a session (a commit once went out as `Claude <noreply@anthropic.com>`).
- **Never:** push to `master` or `main`, publish a package, create or move a tag, create a repository, force-push, print or store a token.

## 4. Owner decisions

Decisions of 2 November 2026 that apply to spec. Items marked "from <task>" are decided and are not in the code yet; the code follows when that task lands.

- From 9K5: the verifier says what it did not check, and never returns `authentic` or `consistent` for a skipped check without a notice.
- From 9K5: an attestation that is unsupported, or a revocation, is `invalid`; so is a `{ keyId }` subject verified against a proof digest. D-29 is revised to this.
- From 9K5: unknown rule fields are refused, and extensions go under `extensions`.
- From 9K5: `null` in a rule is refused where an author writes it (every optional field, `effectiveUntil` and `checksum` included, and inside `dimensions`): `<field> is null: omit the field instead`. "No end" is written by omitting `effectiveUntil`. The normalized and stored form keeps `effectiveUntil: null` as its internal encoding of "no end", so no checksum changes, and the functions that read that form (`computeRuleChecksum`, `toExecutableRule`, `fromStoredRecord`) accept it (ruling of 2 November, on M8).
- Tags absent means no tag filter (D-38). A given list is complete unless the caller declares otherwise.

## 5. Rule for future decisions

Every owner decision the machine session posts on issue #1 starts with `Machine session: DECISION`. Add it to the "Owner decisions" section of this file, in the affected repository, in your next pull request. The audit checks that it is there. A decision that applies to both repositories goes in both.
