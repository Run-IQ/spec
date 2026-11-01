# @run-iq/spec

The rule contract shared by every Run-IQ package. It defines what a rule is, its canonical JSON form, its checksum and fingerprint, how a rule moves between a store and the engine, and the proof that records a decision.

[`@run-iq/core`](https://github.com/Run-IQ/core), [`@run-iq/context-engine`](https://github.com/Run-IQ/context-engine), [`@run-iq/dg`](https://github.com/Run-IQ/decision-graph), [`@run-iq/rule-registry`](https://github.com/Run-IQ/rule-registry) and [`@run-iq/policy-bridge`](https://github.com/Run-IQ/policy-bridge) all use it, so a rule sealed by one is accepted by the others.

## Install

```bash
npm install @run-iq/spec@next
```

The 1.0 line is published under the `next` tag. Depends on `@noble/hashes` and `@noble/curves`. Requires Node.js 20.19 or later.

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
| `output`, `dominanceGroup`, `sourceRef` | Optional strings. `output` names the output the rule contributes to (`value` when absent) |
| `dimensions` | Optional `Record<string, string>`, for example `{ country: 'TG' }` |
| `tags` | Optional string array |
| `exceptions` | Optional list of exceptions, see below |

Every other top-level key is a plugin extension. Extensions enter the checksum and the fingerprint. `RESERVED_RULE_FIELDS` lists the names above plus `checksum`.

`normalizeRuleDefinition` turns an input into the canonical definition:

- Dates may be a `Date`, `YYYY-MM-DD` (read as UTC midnight) or an ISO date-time with `Z` or an offset. A date-time without a time zone, such as `2025-01-01T00:00`, throws `INVALID_DATE`. Dates are written as full UTC ISO strings.
- Missing `effectiveUntil`, `dimensions` and `tags` become `null`, `{}` and `[]`. Tags are sorted and deduplicated.
- At the top level, `null`, `undefined` and an absent key mean the same thing. Inside `params`, `condition.value`, `exceptions` and extension values, `null` is data.
- `checksum` is dropped.
- `exceptions: []`, `null` and an absent `exceptions` are the same rule, with the same checksum. In each selector, `ids`, `tags`, `outputs` and `models` are sorted and deduplicated, and empty fields are dropped. The order of the exceptions is kept.

`canonicalize` writes JSON with keys sorted at every depth. `NaN`, `Infinity`, `bigint`, `Map`, `Set`, class instances and cycles throw `NON_SERIALIZABLE` instead of being written as `null` or `{}`. Convert values such as `Decimal` to JSON first. Strings are not Unicode-normalized.

## Outputs and exceptions

A rule contributes to one named output. Its calculation model declares the output's type and how the contributions of several rules combine:

```js
import { validateOutputDeclaration } from '@run-iq/spec';

validateOutputDeclaration({ type: 'list', combine: 'sum' });
// [ { path: 'output.combine', message: 'output.combine "sum" cannot combine a list output: it applies to number, decimal' } ]
```

The types are `number`, `boolean`, `string`, `enum` (with its `values`, ranked in their order), `list`, `object`, `decimal`, `date` (a civil date, `2028-02-29`) and `dateTime` (a canonical instant, `2026-01-01T00:00:00.000Z`). `sum` combines numbers and decimals; `max` and `min` numbers, decimals, enums, dates and instants; `count` counts the contributions that are `true` into a number; `all` and `any` combine booleans, `union` lists, and `highestPriority` any type. An undeclared output is a number, summed (`DEFAULT_OUTPUT_DECLARATION`).

A declaration may also carry `unit` (a `number` or `decimal` output: `"XOF"`), `empty: true` (an `all` that no rule reached is then `true` instead of undetermined), `sign` (`nonNegative` or `nonPositive`, a `sum` only), `per` (one value per element of a collection, a pointer such as `/foyers/*/personnes`) or `dimension` (a `string` or `enum` output that sets a dimension for the rules after it); `per` and `dimension` are exclusive. A declaration that cannot be satisfied is refused, never accepted silently.

```js
import { compareOutputValues, emptyOutput, normalizeOutputDeclaration, sameDeclaration } from '@run-iq/spec';

const risk = { type: 'enum', combine: 'max', values: ['minimal', 'limited', 'high', 'prohibited'] };
compareOutputValues('high', 'limited', risk);     // 1
emptyOutput({ type: 'boolean', combine: 'all' }); // { status: 'undetermined' }
normalizeOutputDeclaration({ type: 'decimal', combine: 'sum', rounding: { increment: '0.01', mode: 'up' } });
// { type: 'decimal', combine: 'sum', rounding: { scale: 2, mode: 'up' } }
sameDeclaration({ type: 'number', combine: 'sum', unit: 'XOF' }, { type: 'number', combine: 'sum', unit: 'EUR' }); // false
```

`normalizeOutputDeclaration` gives the one written form of a declaration (`empty: false` and `at: 'output'` are dropped; an increment that is a power of ten from 1 to 10^-20 becomes a `scale`); `sameDeclaration` compares by it. `contributionMatchesDeclaration` checks one rule's contribution (a boolean for a `count`), `valueMatchesOutputType` an output's value. `emptyOutput` is the output no contribution reached: `0`, `"0"`, `[]`, `false`, no value for `max`, `min` and `highestPriority`, and an undetermined `all` unless it declares `empty: true`. Each throws `INVALID_RULE` for a declaration `validateOutputDeclaration` refuses. An output's status is one of `OUTPUT_STATUSES` (`determined`, `provisional`, `conflict`, `undetermined`, from the weakest to the strongest); `joinStatus` gives the stronger of two. The JSON schema `@run-iq/spec/schema/output-declaration.schema.json` accepts the same declarations, except that it cannot refuse a lone UTF-16 surrogate in a text.

A `number` is a binary floating-point value. For an amount, declare `decimal`: its value is an exact decimal written as a canonical string, with no exponent, no trailing zero and no `-0` (`"1234.5"`). The conversion is textual, for any number of digits:

```js
import { isCanonicalDecimal, toCanonicalDecimal } from '@run-iq/spec';

toCanonicalDecimal('0012.50'); // '12.5'
toCanonicalDecimal('-0.0');    // '0'
toCanonicalDecimal('1e3');     // throws SpecError INVALID_DECIMAL: no exponent
isCanonicalDecimal('12.50');   // false
```

A `number` or `decimal` output (not a `count`) can declare `rounding: { scale or increment, mode, at? }`: `scale` decimal places (0 to 20) or `increment` a step (a canonical decimal string greater than 0 with at most 20 digits before its point and 20 after it: `"0.05"`, `"10"`; on a `decimal` output only, except a power of ten from 1 to 10^-20, which is a scale), `mode` one of `halfUp`, `halfDown`, `halfEven`, `up`, `down`, `ceiling`, `floor`, and `at` either `output` (the combined value, the default) or `contribution` (each contribution, before combining).

A rule reads the outputs computed before it through the reserved variable `$outputs` (`OUTPUTS_VARIABLE`): `$outputs.x` is output `x`. Output names starting with `$` are reserved: a rule `output`, a `shortCircuit` output or a selector `outputs` entry that starts with `$` is refused (`INVALID_RULE`).

A rule can carry exceptions that apply when the rule itself applies:

| Kind | Effect |
|---|---|
| `{ kind: 'inhibit', targets }` | The targeted rules do not apply |
| `{ kind: 'substitute', targets, params }` | The targeted rules apply with `params` deep-merged into theirs |
| `{ kind: 'shortCircuit', output, value, reason? }` | The output takes `value`, whatever other rules contribute |

`targets` is a selector: `{ ids?, tags?, dimensions?, outputs?, models? }`. Fields combine by AND, the values of one field by OR, and a selector must constrain at least one field. `matchesSelector(rule, targets)` implements it. A rule of the reserved model `@run-iq/exception` (`EXCEPTION_MODEL`) computes nothing: it has a non-empty `exceptions` list and no `output`.

```js
import { EXCEPTION_MODEL, matchesSelector, normalizeRuleDefinition } from '@run-iq/spec';

// `rule` is the shipping-fee rule of the first example
const waiver = {
  id: 'free-shipping-members', version: 1, model: EXCEPTION_MODEL, params: {}, priority: 10,
  effectiveFrom: '2025-01-01',
  exceptions: [{ kind: 'inhibit', targets: { ids: ['shipping-fee'] } }],
};
matchesSelector(normalizeRuleDefinition(rule), waiver.exceptions[0].targets); // true
```

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

## Decision proofs

A proof records one decision without its input: the digest of the input, the rules received with their checksums, the engine and plugin versions, the outputs, and the trace (rules applied, rules skipped, exceptions). `@run-iq/core` builds it; `verifyProof` checks it without running anything.

```js
import {
  computeInputDigest, computeRuleChecksum, createSigningKeyPair, deriveInputSeed, sealProof,
  signProof, verifyProof,
} from '@run-iq/spec';

// The secret stays with the producer (32 bytes or more); never put it or the seed in a proof.
const seed = deriveInputSeed(secret, 'order-42');

const proof = sealProof({
  format: 'run-iq.proof/1',
  requestId: 'order-42',
  evaluatedAt: '2025-06-01',
  sealedAt: '2025-06-01T10:00:00.000Z',
  inputDigest: computeInputDigest({
    data: { orderTotal: 200 },
    meta: {
      tenantId: 'shop', dates: { effective: '2025-06-01' }, tags: [], dimensions: {},
      context: {}, assertions: {},
    },
  }, seed),
  rules: [{ id: 'shipping-fee', version: 1, checksum: computeRuleChecksum(rule) }],
  versions: { engine: '1.0.0-next.1', plugins: {}, dsls: {} },
  strata: [['value']],
  outputs: { value: { type: 'number', combine: 'sum', value: 10, contributors: ['shipping-fee'] } },
  applied: [{ ruleId: 'shipping-fee', version: 1, model: 'PERCENTAGE', output: 'value', contribution: 10, stratum: 0 }],
  skipped: [],
  exceptions: [],
});
verifyProof(proof); // { status: 'consistent', issues: ['unsigned'] }

const { privateKey, publicKey } = createSigningKeyPair();
const signed = signProof(proof, privateKey, 'shop-server');
const trustedKeys = { 'shop-server': publicKey };
verifyProof(signed, { trustedKeys, rules: [rule] }); // { status: 'authentic', issues: [] }
verifyProof(signed, { trustedKeys, rules: [] });     // { status: 'invalid', issues: ['rule missing: shipping-fee@1'] }

signed.outputs.value.value = 0;
verifyProof(signed, { trustedKeys });                // { status: 'invalid', issues: ['digest mismatch'] }
```

- `computeInputDigest(input, seed)` commits to the leaf count and the root of a Merkle tree (RFC 6962) with one salted leaf per value of the input: a scalar, a list or an empty object, at its JSON pointer. `deriveInputSeed(secret, requestId)` gives each request its own seed; with `UNSALTED_SEED` (32 zero bytes) the salts are public and anyone holding the input can recompute the digest. `inputLeaves` and `inputLeafHash` expose the leaves; `merkleRoot`, `inclusionPath` and `verifyInclusion` build and check the tree; `verifyInputInclusion` checks a disclosed leaf against the digest. `computeIdempotencyDigest({ input, options })` is the unsalted digest a decision store keeps to recognise a retry; it is never published.
- `sealProof` sets `digest`, the sha256 of the canonical proof without `digest` and `signature`. It hashes lists in the order given: the producer sorts them.
- `signProof` signs the `digest` string with ed25519 and stores the signature in base64url. It refuses a proof whose digest does not match its content. Keys are hex strings.
- `verifyProof` never throws. A proof is `invalid` if it cites a rule its `rules` does not list (in the trace, the output contributors or the exceptions); `sealProof` and `signProof` refuse such a proof. A proof is `authentic` only when its digest matches and a trusted key signed it. An unsigned proof, or one signed by a key not in `trustedKeys`, is at best `consistent`. With `rules`, the set of `{ id, version, checksum }` must equal the proof's `rules`.
- `strata` lists the outputs of each evaluation stratum, in order: `[['value']]` when no rule reads an output. Each entry of `applied`, `skipped` and `exceptions` carries its `stratum`, the index in `strata`. An output's `rounding` and a rounded contribution's `unrounded` value are kept. A proof is `invalid`, and `sealProof` and `signProof` refuse it, when an output is in no stratum or in two, a stratum names an unknown output, a `stratum` is out of range, or an applied rule's output is not in its stratum (`step stratum mismatch: id@version`). The same goes for an output name starting with `$` (`output name reserved: name`) and for a `decimal` output whose value, or an applied contribution or `unrounded` value for it, is not a canonical decimal string (`decimal value not canonical: name`).
- `validateProof(value)` checks the shape only, with the same `{ errors, issues }` as `validateRuleDefinition`. The JSON schema `@run-iq/spec/schema/decision-proof.schema.json` accepts the same proofs, except that it cannot refuse a rule listed twice. A proof's output rounding is written in the normal form of `normalizeOutputDeclaration`.

## Browser entry

`@run-iq/spec/canonical` imports no Node.js module. It exports everything except `computeRuleChecksum`, `verifyRuleChecksum`, `computeRuleFingerprint` and the stored-rule conversions, so proofs are verified in a browser too. `sha256Hex` is a portable sha256 (`@noble/hashes`), so the checksum is computed the same way in a browser:

```js
import { canonicalRulePayload, sha256Hex } from '@run-iq/spec/canonical';

const checksum = sha256Hex(canonicalRulePayload(rule));
// checksum === computeRuleChecksum(rule)
```

## Errors

Every function throws `SpecError` with a `code`: `NON_SERIALIZABLE` (with the `path` of the value), `INVALID_DATE`, `INVALID_RULE`, `INVALID_PROOF`, `INVALID_KEY` or `INVALID_DECIMAL`. `instanceof SpecError` holds across the two entries and across ESM and CommonJS copies.

## Documents

[docs/](docs) holds the redesign document, the study notes, and the [phase 1](docs/phase-1-changes.md) and [phase 2](docs/phase-2-changes.md) changes.

## License

MIT License. See [LICENSE](LICENSE).
