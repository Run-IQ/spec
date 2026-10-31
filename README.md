# @run-iq/spec

The rule contract shared by every Run-IQ package. It defines what a rule is, its canonical JSON form, its checksum and fingerprint, and how a rule moves between a store and the engine.

[`@run-iq/core`](https://github.com/Run-IQ/core), [`@run-iq/context-engine`](https://github.com/Run-IQ/context-engine), [`@run-iq/dg`](https://github.com/Run-IQ/decision-graph), [`@run-iq/rule-registry`](https://github.com/Run-IQ/rule-registry) and [`@run-iq/policy-bridge`](https://github.com/Run-IQ/policy-bridge) all use it, so a rule sealed by one is accepted by the others.

## Install

```bash
npm install @run-iq/spec@next
```

The 1.0 line is published under the `next` tag. No runtime dependencies. Requires Node.js 20 or later.

## Example

```js
import {
  computeRuleChecksum,
  computeRuleFingerprint,
  toStoredPayload,
  fromStoredRecord,
  isEffectiveAt,
} from '@run-iq/spec';

const rule = {
  id: 'shipping-fee',
  version: 1,
  model: 'PERCENTAGE',
  params: { base: 'orderTotal', rate: 0.05 },
  priority: 1,
  effectiveFrom: '2025-01-01',
  effectiveUntil: '2026-01-01',
};

computeRuleChecksum(rule);
// '2346263c94cae281fd1697403414a56628161b3491378e2a455fd346e6d1a10c'
// The same with effectiveFrom: new Date('2025-01-01') or '2025-01-01T01:00:00+01:00'

// Store a rule, then read it back
const { payload, checksum } = toStoredPayload(rule);
payload;
// '{"dimensions":{},"effectiveFrom":"2025-01-01T00:00:00.000Z","effectiveUntil":"2026-01-01T00:00:00.000Z",
//   "id":"shipping-fee","model":"PERCENTAGE","params":{"base":"orderTotal","rate":0.05},"priority":1,"tags":[],"version":1}'
const executable = fromStoredRecord({ id: 'shipping-fee', version: 1, payload, checksum });
executable.effectiveFrom; // Date 2025-01-01T00:00:00.000Z

// effectiveUntil is excluded
isEffectiveAt(rule, new Date('2025-12-31T23:59:59Z')); // true
isEffectiveAt(rule, new Date('2026-01-01'));           // false

// Same content under another id, version and window
const copy = { ...rule, id: 'shipping-fee-2', version: 3, effectiveFrom: '2025-03-01', effectiveUntil: null };
computeRuleFingerprint(copy) === computeRuleFingerprint(rule); // true
computeRuleChecksum(copy) === computeRuleChecksum(rule);       // false
```

## Rule definition

| Field | |
|---|---|
| `id` | Non-empty string |
| `version` | Positive integer |
| `model` | Name of the calculation model |
| `params` | Required. Any JSON value, `null` included |
| `condition` | Optional `{ dsl, value }` |
| `priority` | Finite number |
| `effectiveFrom`, `effectiveUntil` | Validity window, see below. `effectiveUntil` is optional |
| `output`, `dominanceGroup`, `sourceRef` | Optional strings |
| `dimensions` | Optional `Record<string, string>`, for example `{ country: 'TG' }` |
| `tags` | Optional string array |
| `exceptions` | Optional JSON value |

Every other top-level key is a plugin extension. Extensions enter the checksum and the fingerprint. `RESERVED_RULE_FIELDS` lists the names above plus `checksum`.

`normalizeRuleDefinition` turns an input into the canonical definition:

- Dates may be a `Date`, `YYYY-MM-DD` (read as UTC midnight) or an ISO date-time with `Z` or an offset. A date-time without a time zone, such as `2025-01-01T00:00`, throws `INVALID_DATE`. Dates are written as full UTC ISO strings.
- Missing `effectiveUntil`, `dimensions` and `tags` become `null`, `{}` and `[]`. Tags are sorted and deduplicated.
- At the top level, `null`, `undefined` and an absent key mean the same thing. Inside `params`, `condition.value`, `exceptions` and extension values, `null` is data.
- `checksum` is dropped.
- `exceptions: []` is data, not a default: it seals differently from an absent `exceptions` (`null` counts as absent). Which empty form is canonical will be decided with the exceptions format in phase 2.

`canonicalize` writes JSON with keys sorted at every depth. `NaN`, `Infinity`, `bigint`, `Map`, `Set`, class instances and cycles throw `NON_SERIALIZABLE` instead of being written as `null` or `{}`. Convert values such as `Decimal` to JSON first. Strings are not Unicode-normalized.

## Validity window

A rule is in force on `[effectiveFrom, effectiveUntil)`: `effectiveUntil` is excluded, so a successor can start exactly when its predecessor ends. A rule for the single day 2025-03-01 has `effectiveFrom: '2025-03-01'` and `effectiveUntil: '2025-03-02'`. `effectiveUntil` must be after `effectiveFrom`, otherwise the rule is refused (`INVALID_RULE`).

`isEffectiveAt(rule, at)` implements the window. In this release only the checksum and validation use it: `@run-iq/core` still applies `effectiveUntil` inclusively when filtering rules, and so does the store resolution of `@run-iq/context-engine`. They move to this window in later phases of the redesign (see [docs](docs/2026-10-30-refonte-run-iq-design.md)).

## Checksum and fingerprint

- `computeRuleChecksum(rule)` is the sha256 hex of the canonical definition. It covers every field, including `id`, `version`, the dates and the extensions. `verifyRuleChecksum(rule)` compares it with `rule.checksum` and returns a boolean. It throws `SpecError` when the rule is malformed or has no string `checksum`, so a broken rule is never reported as a plain mismatch.
- `computeRuleFingerprint(rule)` hashes the same canonical definition without `id`, `version`, `effectiveFrom` and `effectiveUntil`. Two rules with the same content get the same fingerprint, however their data is written. `@run-iq/context-engine` uses it to detect a rule saved twice.

## Stored and executable rules

- `toStoredPayload(rule)` returns `{ payload, checksum }`: the canonical JSON of the definition and its sha256. A `checksum` in the input is ignored.
- `fromStoredRecord({ id, version, payload, checksum })` returns an `ExecutableRule`, with `Date` bounds and `dimensions` always present. It throws `SpecError` (`INVALID_RULE`) with a message naming the rule, `Stored rule <id>@<version>: <reason>`, when the payload is not JSON, its `id` or `version` differ from the record, it is not canonical, the definition is invalid, or the checksum does not match.
- `toExecutableRule(rule)` builds an `ExecutableRule` and seals it with a fresh checksum. To re-seal a rule you loaded, check it with `verifyRuleChecksum` first.

## Validation

`validateRuleDefinition(value)` never throws. It returns every problem found, each with the path of the offending field:

```js
import { validateRuleDefinition } from '@run-iq/spec';

validateRuleDefinition({
  id: 'r1', version: 1, model: 'PERCENTAGE', priority: 1,
  effectiveFrom: '2025-01-01T00:00',
  params: { rates: [0.1, NaN] },
});
// { valid: false,
//   errors: [ ...the messages below ],
//   issues: [
//     { path: 'params.rates[1]', message: 'Value at "params.rates[1]" cannot be serialized to canonical JSON: NaN' },
//     { path: 'effectiveFrom', message: 'effectiveFrom must be a Date, YYYY-MM-DD, or an ISO date-time with Z or an offset; got "2025-01-01T00:00"' } ] }
```

The JSON schema `@run-iq/spec/schema/rule-definition.schema.json` (draft 2020-12) accepts the same definitions, except that it cannot check that `effectiveUntil` is after `effectiveFrom`.

## Browser entry

`@run-iq/spec/canonical` imports no Node.js module. It exports `canonicalize`, `normalizeRuleDefinition`, `canonicalRulePayload`, `validateRuleDefinition`, `isEffectiveAt`, `SpecError` and the types, but no hashing. Hash `canonicalRulePayload(rule)` with any sha256 to get the checksum:

```js
import { canonicalRulePayload } from '@run-iq/spec/canonical';

const bytes = new TextEncoder().encode(canonicalRulePayload(rule));
const digest = await crypto.subtle.digest('SHA-256', bytes);
const checksum = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
// checksum === computeRuleChecksum(rule)
```

## Errors

Every function throws `SpecError` with a `code`: `NON_SERIALIZABLE` (with the `path` of the value), `INVALID_DATE` or `INVALID_RULE`. `instanceof SpecError` holds across the two entries and across ESM and CommonJS copies.

## Documents

[docs/](docs) holds the redesign document, the study notes and the [phase 1 changes](docs/phase-1-changes.md).

## License

MIT License. See [LICENSE](LICENSE).
