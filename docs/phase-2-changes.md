# Phase 2: typed outputs, exceptions and decision proofs

Phase 2 of the [redesign](2026-10-30-refonte-run-iq-design.md) turns the engine into a decision engine: a rule contributes to a typed output, rules can carry exceptions, and each decision can be sealed in a proof that a third party verifies without running anything. `@run-iq/spec` defines the three formats; `@run-iq/core` implements them.

## Versions

| Package | Before | Now |
|---|---|---|
| `@run-iq/spec` | `1.0.0-next.0` | `1.0.0-next.1` |

Dependants that use `^1.0.0-next.0` accept the new version. Node.js 20.19 or later is required, the floor of `@noble/hashes` and `@noble/curves`.

## Output declarations

- `OutputDeclaration` is `{ type, combine, values? }`. The types are `number`, `boolean`, `string`, `enum`, `list` and `object`; the strategies are `sum`, `max`, `min` (numbers), `all`, `any` (booleans), `union` (lists) and `highestPriority` (any type).
- `values` is required for an `enum` (distinct non-empty strings, at least one) and refused for any other type.
- `validateOutputDeclaration(d)` returns every problem with its path and never throws. `valueMatchesOutputType(value, d)` checks a value against a declaration.
- `DEFAULT_OUTPUT` is `value`, the output of a rule that names none. `DEFAULT_OUTPUT_DECLARATION` is `{ type: 'number', combine: 'sum' }`, frozen.
- There is no JSON schema for declarations: they live in calculation models, not in rules.

## Decimals, rounding and strata

- **`OutputType` gains `decimal`.** A decimal output holds an exact decimal as a canonical string: no exponent, no leading zero, no trailing fractional zero, no `-0` (`"1234.5"`). `sum`, `max`, `min` and `highestPriority` combine it; `union`, `all` and `any` do not. `valueMatchesOutputType` accepts only a canonical string, never a number. `number` stays a floating-point value: an amount is declared `decimal`. A `switch` over `OutputType` needs the new case.
- `isCanonicalDecimal(text)` tells a canonical decimal. `toCanonicalDecimal(text)` writes `-?digits(.digits)?` canonically (`"0012.50"` gives `"12.5"`, `"-0.0"` gives `"0"`), for any number of digits, and is idempotent. It refuses anything else, an exponent, `+`, spaces, `".5"` or `"5."`, with the new error code **`INVALID_DECIMAL`**. Both are pure text functions, with no dependency, in both entries.
- `OutputDeclaration` gains `rounding?: { scale, mode, at? }`, for `number` and `decimal` outputs only: `scale` an integer from 0 to 20, `mode` one of `halfUp`, `halfDown`, `halfEven`, `up`, `down`, `ceiling`, `floor` (`RoundingMode`), and `at` `output` (the default) or `contribution`. `validateOutputDeclaration` checks it.
- `OUTPUTS_VARIABLE` is `$outputs`, the reserved variable through which a rule reads an output (`$outputs.x`).
- **The proof gains required fields.** `UnsignedProof.strata` (`string[][]`) lists the outputs of each evaluation stratum, in order; a stratum may be empty, and a rule set where no rule reads an output has one stratum. `ProofStep`, `ProofSkip` and `ProofException` gain a required `stratum`, a safe integer index in `strata`. `ProofStep` gains `unrounded?`, the contribution before rounding, and `ProofOutput` gains `rounding?`, checked as in a declaration. The format stays `run-iq.proof/1`: it was not published before this change.
- `verifyProof` makes a proof `invalid`, and `sealProof` and `signProof` refuse it (`INVALID_PROOF`), when `strata` contradicts the rest of the proof: `stratum output unknown: name`, `stratum output repeated: name`, `output not in strata: name`, `stratum out of range: id@version`, `step stratum mismatch: id@version`. `validateProof` and the JSON schema check the shape of the new fields and agree on it.

## Exceptions

- **`exceptions` is now a closed format**, where phase 1 accepted any JSON value. Each item is `{ kind: 'inhibit', targets }`, `{ kind: 'substitute', targets, params }` or `{ kind: 'shortCircuit', output, value, reason? }`, and nothing else. A rule whose `exceptions` does not follow it is refused by `validateRuleDefinition` and the JSON schema, and `normalizeRuleDefinition` throws `INVALID_RULE`, so it has no checksum.
- `targets` is a `RuleSelector`: `{ ids?, tags?, dimensions?, outputs?, models? }`. Fields combine by AND, the values of one field by OR, and a selector must constrain at least one field. `matchesSelector(rule, selector)` implements it; `outputs` compares the rule's output, `value` when it names none.
- **`exceptions: []` is the same rule as an absent `exceptions`**, with the same checksum and fingerprint (`null` too). In phase 1, `[]` sealed differently: a rule sealed with `exceptions: []` must be sealed again.
- Normalization sorts and deduplicates `ids`, `tags`, `outputs` and `models` in each selector and drops empty fields, so their order does not change the checksum. The order of the exceptions is kept and does.
- `EXCEPTION_MODEL` (`@run-iq/exception`) is a reserved model: such a rule computes nothing, has a non-empty `exceptions` list and no `output`.

## Decision proofs

- `PROOF_FORMAT` is `run-iq.proof/1`. `UnsignedProof` holds the request id, the evaluation and sealing dates, the input digest, the rules received (`{ id, version, checksum, sourceRef? }`), an optional pack reference, the engine, plugin and DSL versions, the outputs, the rules applied and skipped, and the exceptions that took effect. **It holds the digest of the input, never the input.**
- `computeInputDigest(input)` is `sha256Hex(canonicalize(input))`.
- `sealProof(p)` returns a detached copy with `digest`, the sha256 of the canonical proof without `digest` and `signature`. It refuses (`INVALID_PROOF`) an invalid proof, and a proof that cites a rule its `rules` does not list: in `applied`, `skipped` or `exceptions` (by id and version), or in output `contributors` or exception `affected` (by id). It does not sort lists: the producer sorts `rules` and `applied` by id then version, and `skipped` by id, so the same decision always gives the same digest.
- `signProof(p, privateKey, keyId)` signs the 64 characters of `digest` with ed25519 and stores `{ alg: 'ed25519', keyId, value }`, `value` in base64url without padding. It refuses a proof whose digest does not match its content or that cites an unlisted rule (`INVALID_PROOF`) and a malformed key (`INVALID_KEY`). `createSigningKeyPair()` returns hex keys.
- `verifyProof(p, { trustedKeys?, rules? })` never runs anything and never throws. It returns `authentic` (digest matches, signed by a trusted key), `consistent` (digest matches, but unsigned or signed by a key that is not trusted) or `invalid`, with short issues such as `digest mismatch`, `unsigned`, `untrusted key`, `signature invalid`, `cited rule not listed: id@version` (or `: id`), `rule missing: id@version`, `unexpected rule: id@version` and `rule checksum mismatch: id@version`. **An unsigned proof is never `authentic`.** The proof is read once into a JSON snapshot and every check runs on it; act on verified data (a JSON copy), not on a live object.
- `validateProof(value)` checks the shape and returns `{ errors, issues }` like `validateRuleDefinition`. The JSON schema `schema/decision-proof.schema.json` accepts the same proofs, except that it cannot refuse a rule listed twice.
- **`SpecErrorCode` gains `INVALID_PROOF`, `INVALID_KEY` and `INVALID_DECIMAL`.** A `switch` that covers every code needs the three new cases.

## Portable hashing

- `sha256Hex(text)` is a pure JavaScript sha256 (`@noble/hashes`). spec no longer imports `node:crypto`. Checksum values do not change.
- Both entries export `sha256Hex` and the whole proof API. `@run-iq/spec/canonical` still imports no Node.js module: `sha256Hex(canonicalRulePayload(rule))` gives the checksum, and `verifyProof` runs in a browser.
