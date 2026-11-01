# Phase 1: one rule contract

Phase 1 of the [redesign](2026-10-30-refonte-run-iq-design.md) gives every Run-IQ package the same definition of a rule, through the new `@run-iq/spec`. Before it, a store computed `sha256(payload)` while `core` checked its own checksum of the rule object, so a rule saved in a store and run by the engine was skipped as `CHECKSUM_MISMATCH`. That path now works end to end.

The study note behind each change is [studies/phase-1.md](studies/phase-1.md).

## Versions

The new line is published under the `next` dist-tag; `latest` stays on the 0.x versions.

| Package                  | Before  | Now            |
| ------------------------ | ------- | -------------- |
| `@run-iq/spec`           | (new)   | `1.0.0-next.0` |
| `@run-iq/core`           | `0.2.8` | `1.0.0-next.0` |
| `@run-iq/context-engine` | `0.2.1` | `1.0.0-next.0` |
| `@run-iq/dg`             | `0.1.2` | `1.0.0-next.0` |
| `@run-iq/rule-registry`  | `0.1.1` | `1.0.0-next.0` |
| `@run-iq/policy-bridge`  | `0.1.0` | `1.0.0-next.0` |
| `@run-iq/dsl-jsonlogic`  | `0.1.4` | `0.2.0-next.0` |
| `@run-iq/plugin-sdk`     | `0.2.7` | `0.3.0-next.0` |
| `@run-iq/plugin-fiscal`  | `0.4.0` | `0.5.0-next.0` |
| `@run-iq/cli`            | `0.1.2` | `0.2.0-next.0` |
| `@run-iq/server`         | `0.1.4` | `0.2.0-next.0` |
| `@run-iq/mcp-server`     | `0.3.2` | `0.4.0-next.0` |

The packages of the `next` line depend on each other with `^1.0.0-next.0`, `^0.2.0-next.0` and so on. Do not mix them with the 0.x line.

## Checksums

- **Every checksum value changes.** `computeRuleChecksum` (spec, and core, which delegates to it) hashes the canonical definition: dates as full UTC ISO strings, defaults written out (`effectiveUntil: null`, `dimensions: {}`, `tags: []`), tags sorted and deduplicated, keys sorted. Re-seal your rules with the new version.
- A rule sealed with string dates (`'2025-01-01'`) and later hydrated to `Date` now passes verification. It used to be skipped.
- `NaN`, `Infinity`, an invalid date or a date-time without a time zone (`2025-01-01T00:00`) now throw `SpecError`, where they used to be hashed as `null` or read in the machine's time zone.
- `version` must be a positive integer.
- `schemaVersion` is no longer a named field of `Rule`. If you set it, it is an extension and enters the checksum.
- Extension fields stay at the top level of the rule and enter the checksum.
- `exceptions: []` and an absent `exceptions` give different checksums and fingerprints (`null` counts as absent). The canonical empty form is decided with the exceptions format in phase 2; until then, pick one form and keep it.

## Validity window

- spec defines the window as half-open: `[effectiveFrom, effectiveUntil)`. `effectiveUntil` is excluded. `isEffectiveAt` implements it.
- `effectiveUntil` must be after `effectiveFrom`. **A one-day rule now ends the next day**: `effectiveFrom: '2025-03-01'`, `effectiveUntil: '2025-03-02'`. A rule with `effectiveUntil` equal to `effectiveFrom` is refused.
- Only the checksum and validation follow the window in this release. `core` still applies `effectiveUntil` inclusively when it filters rules (until phase 2), and the store resolution of `context-engine` stays inclusive too (until phase 5).

## core

- A malformed rule (invalid date, empty window, non-integer version, missing or non-string `checksum`...) is skipped with the new reason `INVALID_RULE`. `SkippedRule` has a new optional `detail` naming the rule (`id@version`) and the reason. With `onChecksumMismatch: 'throw'`, it throws `ValidationError` instead. A rule with an empty window used to be skipped as `INACTIVE_DATE`.
- `hydrateRule` and `hydrateRules` throw `ValidationError` on an invalid definition, with every problem in `reasons`. They keep the stored `checksum`, so a row changed after sealing is still caught as `CHECKSUM_MISMATCH`.
- `Rule` now has an extension index signature. Object literals typed as `Rule` no longer get excess-property errors, and `Omit<Rule, ...>` loses the named fields: use `Pick` on the named keys instead.
- `cli` and `server` use `hydrateRules`, so they accept and refuse the same rules.
- `canonicalStringify` and `hashParams` now go through spec's `canonicalize`, the same code as the checksum. A key containing a quote now gives valid JSON (it used to be written unescaped). `NaN`, `Infinity`, `Map`, `Set`, class instances and cycles throw `SpecError` instead of being written as `null` or `{}`, and `hashParams(undefined)` throws instead of hashing `"null"`. Hashes of plain JSON params with ordinary keys do not change.
- `VERSION` is exported.

## Migrating rules stored before phase 1

A record saved by an earlier store has a raw payload and a `sha256(payload)` checksum. `fromStoredRecord`, `RuleStoreResolver` and `RuleSandbox` refuse it (`payload is not canonical` or `checksum mismatch`). Re-seal each record once, in one of two ways:

1. **In place**: build the full definition from the record (payload fields plus the record's `id`, `version`, `model`, dates, `priority`, `tags`, and `country` as `dimensions.country`; `ruleDefinitionOf(input, id, version)` of context-engine does this), check it with `validateRuleDefinition`, then write back `payload` and `checksum` from `toStoredPayload(definition)`. The id and version stay the same. Verify the old checksum against the old payload first, so a tampered row is not re-sealed.
2. **As a new version**: call `saveRule` with the same id and the old payload. The store writes a canonical draft with the next version, which then goes through review and publication like any change.

Records whose payload has no `params` must get one first: `saveRule` and `validateRuleDefinition` require it.

`VERSION` is also exported by context-engine.

## context-engine

- **The store payload is the canonical rule definition.** `saveRule` parses the payload, overrides it with the store's `id`, `version`, `model` and dates, and writes `canonicalize(definition)`. The `checksum` is its sha256, the value `core` expects. `fromStoredRecord` and `toStoredPayload` are re-exported, and `ruleDefinitionOf(input, id, version)` builds the definition without saving.
- **`saveRule` refuses an invalid payload** with `ContextValidationError`: invalid JSON, not an object, or a definition `validateRuleDefinition` refuses. `params` is required. Payloads such as `'{}'` or `{ "rate": 0.05 }` used to be accepted.
- `RuleInput.country` is copied into `dimensions.country`. If both are set and differ, `saveRule` throws. A country given only in the payload fills the `country` column.
- Without `RuleInput.priority` or `tags`, the payload's values are used, and the `priority` column follows.
- `effectiveUntil: ''` means no end, like `null`.
- The `effectiveFrom` and `effectiveUntil` columns stay as received (`YYYY-MM-DD`). Only the payload holds full ISO dates.
- **`duplicate_checksum` compares fingerprints**: the content without `id`, `version` and dates (`computeRuleFingerprint`). The same content saved under another id or window is detected, however the data is written. A new version of the same rule id is not a duplicate. `detectConflicts` throws `ContextValidationError` on an invalid candidate.

## decision-graph

- `RuleStoreResolver` reads records with `fromStoredRecord`. `dimensions`, `dominanceGroup` and extension fields now reach `core`; they used to be dropped, and such rules were skipped as `CHECKSUM_MISMATCH`.
- A tampered or unreadable record throws an error naming the rule (`Stored rule <id>@<version>: <reason>`). The node then follows its `onError` policy. It is never dropped silently from the list.
- `node.skipped` and `node.fallback` events caused by an error carry a new optional `error` field.
- `RetryRuleResolver` does not retry a `SpecError`: an invalid record fails on the first attempt.
- `result.versions` reports the dg, `core` and `context-engine` versions that ran the execution, read from the loaded packages' `VERSION` exports. `compiled.compiled` keeps the versions loaded at compile time. Both used to report hard-coded `0.1.0`, `0.2.6` and `0.2.0`. `SUPPORTED_PEERS` lists the peer ranges.

## rule-registry

- The rule definition is always checked with spec's `validateRuleDefinition`.
- **A custom `ruleSchemaValidator` now adds to spec's check** and never replaces it: the errors of both are reported together. It receives the definition the store will save (payload merged with the rule's id, model, dates, priority, tags and country), not the raw payload.
- `metadata` must be JSON-safe (no `Infinity`, `Map` or `bigint`). It is refused with `INVALID_METADATA` before anything is written.
- `updateRule` with only a new `country` updates `dimensions.country` in the reused payload.
- `RuleSandbox.simulate` returns the rule rebuilt by `fromStoredRecord`, with `Date` bounds and a verified checksum. A record that fails it gives `validation_error` with code `INVALID_STORED_RULE`.

### Audit chain migration for persistent adapters

Each audit event stores in `metadata.prevChecksum` the sha256 of the previous event. It is now computed over `canonicalize(event)` instead of `JSON.stringify(event)`, so it no longer depends on the key order an adapter reads events back in. Chains written by an earlier version fail `verifyIntegrity` after the upgrade. In-memory stores are not affected.

If you persist audit events:

1. Before upgrading, run `verifyIntegrity` on every rule with the old version, and keep the result.
2. After upgrading, either recompute `metadata.prevChecksum` along each chain in order, as `sha256(canonicalize(previousEvent))` with the previous event already updated, or keep the old events and record the upgrade date, before which `verifyIntegrity` issues are expected.

## policy-bridge

- Each generated rule has `id` `<graph id>:<node id>`, stable across compilations. The store used to generate a random one.
- The payload is a full rule definition (`toStoredPayload`), with the node's `action.output` as `output` and its `sourceRef`. Its `version` is a placeholder (`1`); the store assigns the real one.
- A node whose definition spec refuses, for example without `params`, fails at compile time with a `SchemaValidationError` naming the node, instead of at `saveRule`.
- Node `exceptions` are not emitted yet (phase 2).

## plugin-fiscal

`priority` must now be set on fiscal rules before sealing: it is part of the checksum, and a rule without it cannot be sealed (`computeRuleChecksum` throws) or is skipped as `INVALID_RULE`. The plugin's default priority from jurisdiction and scope (`NATIONAL` 3000, `REGIONAL` 2000, `MUNICIPAL` 1000, times 1.0 / 1.1 / 1.2 for the scope) no longer applies, because core verifies the rule before the plugin runs. Set that value yourself. The default is reviewed in phase 3.

## mcp-server

The tools report a rule spec refuses instead of failing the whole call:

| Tool                             | Result for such a rule                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate_rules`                 | That rule's entry lists `Invalid rule: <reason>`; the other rules are reported normally                                                                     |
| `inspect_rule`                   | `checksumMatch: false`, `valid: false`, and a new `ruleErrors` array with the reason                                                                        |
| `create_checksum`, `create_rule` | `isError: true` with the JSON body `{ "error": "Invalid rule: <reason>" }`, the shape `evaluate` already used. They used to return the SDK's raw error text |

`create_checksum` with `params` that have no canonical JSON form (`NaN`, for example) returns `isError: true` with `{ "error": "Invalid params: <reason>" }`.

Checksums produced by `create_checksum` and `create_rule` are the new spec values.

## cli

`run-iq validate` checks each rule's structure through `core`'s `hydrateRule`, so its messages are spec's. It does **not** verify the stored checksum value, and never did: a rule with a wrong checksum passes `validate` and is skipped by `evaluate` as `CHECKSUM_MISMATCH`.

## web-platform

The playground examples are sealed with `@run-iq/spec/canonical` instead of a local copy of the old checksum code.
