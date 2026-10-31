import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { expect } from 'vitest';
import {
  canonicalize,
  inputLeaves,
  normalizeRuleDefinition,
  SpecError,
  UNSALTED_SEED,
  validateRuleDefinition,
} from '../src/index.js';
import type {
  CivilCalendar,
  JsonValue,
  FactAssertion,
  InputLeaf,
  ProofInput,
  Referential,
  RuleDefinitionInput,
} from '../src/index.js';

/** The `SpecError` `call` throws; fails the test when it throws anything else, or nothing. */
export function specError(call: () => unknown): SpecError {
  try {
    call();
  } catch (error) {
    if (error instanceof SpecError) return error;
    throw error;
  }
  throw new Error('expected a SpecError');
}

const MINUTE = 60_000;

/** Fixed offsets, in minutes, of the zone names the test calendar knows. */
const NAMED_OFFSETS: Readonly<Record<string, number>> = {
  UTC: 0,
  'Europe/Paris': 60,
  'Pacific/Noumea': 660,
  'Pacific/Kiritimati': 840,
  'Pacific/Niue': -660,
};

function offsetOf(zone: string): number {
  if (Object.hasOwn(NAMED_OFFSETS, zone)) return NAMED_OFFSETS[zone] ?? 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  if (!match) throw new Error(`test calendar: unknown time zone ${zone}`);
  const [, sign, hours, minutes] = match;
  return (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
}

/** The date part of the ISO form, expanded (`-000001-12-31`) outside the years 0000 to 9999. */
function civilOf(time: number): string {
  return new Date(time).toISOString().split('T')[0] ?? '';
}

/**
 * A test calendar without any time zone database: `Europe/Paris` is `+01:00` all year,
 * `Pacific/Noumea` `+11:00`, `Pacific/Kiritimati` `+14:00`, `Pacific/Niue` `-11:00`, `UTC`
 * `+00:00`, and a `±HH:MM` zone is its own offset. Outside the years 0000 to 9999 it answers in
 * the expanded ISO form, as `CivilCalendar` asks. With a fixed
 * offset every day has a midnight, so `startOfDay` (the FIRST instant of the civil day) is
 * always local midnight. A day without midnight is covered by `transitionCalendar`.
 */
export const fixedCalendar: CivilCalendar = {
  toCivilDate: (at, zone) => civilOf(Date.parse(at) + offsetOf(zone) * MINUTE),
  startOfDay: (day, zone) =>
    new Date(Date.parse(`${day}T00:00:00.000Z`) - offsetOf(zone) * MINUTE).toISOString(),
};

/** 2026-09-06T04:00:00.000Z: local 00:00 at -04:00 becomes 01:00 at -03:00. */
const SPRING_FORWARD = Date.parse('2026-09-06T04:00:00.000Z');

/**
 * A test calendar for `America/Santiago` around its 2026 change to summer time, which happens
 * AT midnight: `-04:00` before `2026-09-06T04:00:00.000Z`, `-03:00` from then on. Local
 * 2026-09-06 00:00 does not exist, so the first instant of that day is 01:00 local
 * (`2026-09-06T04:00:00.000Z`). Every other zone is delegated to `fixedCalendar`.
 */
export const transitionCalendar: CivilCalendar = {
  toCivilDate: (at, zone) => {
    if (zone !== 'America/Santiago') return fixedCalendar.toCivilDate(at, zone);
    const time = Date.parse(at);
    return civilOf(time + (time < SPRING_FORWARD ? -4 : -3) * 60 * MINUTE);
  },
  startOfDay: (day, zone) => {
    if (zone !== 'America/Santiago') return fixedCalendar.startOfDay(day, zone);
    const midnight = Date.parse(`${day}T00:00:00.000Z`);
    const winter = midnight + 4 * 60 * MINUTE;
    if (winter < SPRING_FORWARD) return new Date(winter).toISOString();
    const summer = midnight + 3 * 60 * MINUTE;
    // A midnight that falls in the skipped hour does not exist: the day starts at the change.
    return new Date(summer >= SPRING_FORWARD ? summer : SPRING_FORWARD).toISOString();
  },
};

/**
 * The test referential `ue` of Task 9E, a fresh copy at each call: `UE` exhaustive (FR since
 * 1958-01-01, GB during [1973-01-01, 2020-02-01), HR since 2013-07-01, DK since 1973-01-01);
 * `EEE` exhaustive (members `UE` and `NO`); `MONDE` not exhaustive (member `EEE`).
 */
export function ueReferential(): Referential {
  return {
    format: 'run-iq.referential/1',
    id: 'ue',
    version: '2026.1',
    dimension: 'pays',
    groups: {
      UE: {
        exhaustive: true,
        members: [
          { value: 'FR', from: '1958-01-01' },
          { value: 'GB', from: '1973-01-01', until: '2020-02-01' },
          { value: 'HR', from: '2013-07-01' },
          { value: 'DK', from: '1973-01-01' },
        ],
      },
      EEE: { exhaustive: true, members: [{ value: 'UE' }, { value: 'NO' }] },
      MONDE: { exhaustive: false, members: [{ value: 'EEE' }] },
    },
  };
}

/** A chain of `depth` groups, `G1 ∋ G2 ∋ … ∋ G<depth>`, the last one holding the code `x`. */
export function nestedReferential(depth: number): Referential {
  const groups: Referential['groups'] = {};
  for (let i = 1; i <= depth; i++) {
    const member = i === depth ? 'x' : `G${i + 1}`;
    groups[`G${i}`] = { exhaustive: true, members: [{ value: member }] };
  }
  return { format: 'run-iq.referential/1', id: 'deep', version: '1', dimension: 'd', groups };
}

/** A minimal valid rule definition; spread it to build test rules. */
export const BASE_RULE = Object.freeze({
  id: 'r1',
  version: 1,
  model: 'PERCENTAGE',
  params: Object.freeze({ rate: 0.05 }),
  priority: 1,
  effectiveFrom: '2025-01-01',
});

/**
 * Asserts that normalize throws `INVALID_RULE` with `message` and that the validator reports
 * exactly that one issue at `path`.
 */
export function expectRuleRefused(rule: object, path: string, message: string): void {
  expect(specError(() => normalizeRuleDefinition(rule as RuleDefinitionInput))).toMatchObject({
    code: 'INVALID_RULE',
    message,
  });
  expect(validateRuleDefinition(rule).issues).toEqual([{ path, message }]);
}

/** A valid assertion (`FactAssertion`): a person validated the fact. Spread it to vary. */
export const HUMAN_ASSERTION: Readonly<FactAssertion> = Object.freeze({
  by: 'agent-7',
  method: 'human',
  at: '2026-01-02',
  status: 'validated',
});

/**
 * A valid proof input (`ProofInput`), a fresh copy at each call: `data` and each field of
 * `meta` can be replaced (`proofInput({ tags: ['a'] })`, `proofInput({}, { x: 1 })`).
 */
export function proofInput(
  meta: Partial<ProofInput['meta']> = {},
  data: ProofInput['data'] = { revenue: 1000 },
): ProofInput {
  return {
    data,
    meta: {
      tenantId: 't1',
      dates: { effective: '2026-01-01' },
      tags: [],
      dimensions: {},
      context: {},
      assertions: {},
      ...meta,
    },
  };
}

/** What `findOverlappingVersions` returns below its limit: every pair, not truncated. */
export function overlapReport<T>(overlaps: T[]): { overlaps: T[]; truncated: false } {
  return { overlaps, truncated: false };
}

/**
 * Asserts a list of issues that reached the shared bound: 100 problems, then the last issue
 * `further problems not listed (limit 100)`; every path at most 1024 code units plus `…`, every
 * message at most `maxMessage` code units (so the total size is bounded too).
 */
export function expectBoundedIssues(
  issues: readonly { path: string; message: string }[],
  maxMessage = 1025,
): void {
  expect(issues).toHaveLength(101);
  expect(issues[100]).toEqual({ path: '', message: 'further problems not listed (limit 100)' });
  expect(issues.every((issue) => issue.path.length <= 1025)).toBe(true);
  expect(issues.every((issue) => issue.message.length <= maxMessage)).toBe(true);
  expect(issues.reduce((total, issue) => total + issue.message.length, 0)).toBeLessThanOrEqual(
    101 * maxMessage,
  );
}

/** `issues` sorted by path (UTF-16 code units), to compare problems whatever their order. */
export function sortedByPath<T extends { path: string }>(issues: readonly T[]): T[] {
  return [...issues].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A value whose deepest value is `levels` objects below it: `nested(1)` is `{ a: 1 }`. */
export function nested(levels: number): JsonValue {
  let value: JsonValue = 1;
  for (let i = 0; i < levels; i++) value = { a: value };
  return value;
}

/** `text` as an issue cuts it: at most `length` code units, then `…` (ASCII text only). */
function cutAt(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

/**
 * The issue of a value nested deeper than 1000 levels whose first container past the limit sits
 * at `path` (ASCII): the path cut at 1024 code units, the message citing it cut at 256.
 */
export function tooDeepIssue(path: string): { path: string; message: string } {
  return {
    path: cutAt(path, 1024),
    message: `${cutAt(path, 256)} is nested deeper than 1000 levels`,
  };
}

/**
 * The values of `value` as its JSON text holds them: each member of an object (an `undefined`
 * one included) and each element of an array, on every path (a shared object counts once per
 * path); the root is not one. A `Date` is a single value. What each function of the package
 * charges against `MAX_JSON_VALUES` when it reads `value` once.
 */
export function countValues(value: unknown): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null || node instanceof Date) continue;
    const members: unknown[] = Array.isArray(node) ? node : Object.values(node);
    count += members.length;
    for (const member of members) stack.push(member);
  }
  return count;
}

/** The bytes of `text` in UTF-8, or the bytes given. */
function bytesOf(part: Uint8Array | string): Uint8Array {
  return typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
}

/** sha256 by `node:crypto` of the parts given, one after the other (texts in UTF-8). */
export function nodeSha256(...parts: (Uint8Array | string)[]): Uint8Array {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(bytesOf(part));
  return new Uint8Array(hash.digest());
}

/** HMAC-SHA256 by `node:crypto` of the UTF-8 text `message` under `key`. */
export function nodeHmac(key: Uint8Array, message: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(message, 'utf8').digest());
}

/** The input seed by `node:crypto`: HKDF-SHA256, salt `run-iq.input-seed/1`, 32 bytes. */
export function nodeInputSeed(secret: Uint8Array, requestId: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', secret, 'run-iq.input-seed/1', requestId, 32));
}

/**
 * The input digest by `node:crypto` (D-15) of a tree of `size` leaves whose RFC 6962 root is
 * `root`: `sha256(0x02 ‖ utf8('run-iq.input/1') ‖ 0x00 ‖ uint64be(size) ‖ root)`, in hex.
 */
export function nodeInputDigest(size: number, root: Uint8Array): string {
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(size));
  return hex(nodeSha256(Uint8Array.of(2), 'run-iq.input/1', Uint8Array.of(0), count, root));
}

/** Lowercase hex of `bytes`. */
export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** The bytes of a hex text. */
export function fromHex(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'hex'));
}

/** `n` distinct leaf hashes: the sha256 of `leaf 0`, `leaf 1`, … */
export function leafHashes(n: number): Uint8Array[] {
  return Array.from({ length: n }, (_, i) => nodeSha256(`leaf ${i}`));
}

/** The largest power of two strictly below `n` (n ≥ 2), as RFC 6962 splits a tree. */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * The Merkle tree hash of RFC 6962 (section 2.1), written as the RFC writes it, recursively:
 * a reference for test sizes only. `[]` gives the sha256 of nothing, one leaf gives itself.
 */
export function referenceRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return nodeSha256();
  const [only] = leaves;
  if (leaves.length === 1 && only !== undefined) return only;
  const k = split(leaves.length);
  const left = referenceRoot(leaves.slice(0, k));
  const right = referenceRoot(leaves.slice(k));
  return nodeSha256(Uint8Array.of(1), left, right);
}

/** The audit path of RFC 6962 (section 2.1.1), recursive: a reference for test sizes only. */
export function referencePath(leaves: readonly Uint8Array[], index: number): Uint8Array[] {
  if (leaves.length <= 1) return [];
  const k = split(leaves.length);
  return index < k
    ? [...referencePath(leaves.slice(0, k), index), referenceRoot(leaves.slice(k))]
    : [...referencePath(leaves.slice(k), index - k), referenceRoot(leaves.slice(0, k))];
}

/** The UTF-16 code units of the leaf pointers of `input`, all added up (`inputLeaves`). */
export function pointerText(input: ProofInput): number {
  return inputLeaves(input, UNSALTED_SEED).reduce((total, leaf) => total + leaf.pointer.length, 0);
}

/**
 * A valid input whose leaf pointers hold exactly `units` code units, built from short texts: one
 * value `0` shared by the `2^depth` paths of a chain of `depth` objects `{ l, r }` (each object
 * holds the next one twice), under a key `k…` of `width` units (`/data/k…/l/r/…`, `6 + width +
 * 2 * depth` units each), one more value under a key `z…` for the remainder (`/data/z…`), and
 * the fixed leaves of `meta` (`proofInput`). Its `paths`, `width` and `rest` (the length of
 * `z…`) are given beside it.
 */
export function sharedPointerText(
  units: number,
  depth: number,
): { input: ProofInput; paths: number; width: number; rest: number } {
  const fixed = pointerText(proofInput({}, { z: 0 })) - '/data/z'.length;
  const paths = 2 ** depth;
  const width = Math.floor((units - fixed - 7) / paths) - 6 - 2 * depth;
  const rest = units - fixed - paths * (6 + width + 2 * depth) - 6;
  if (width < 1 || rest < 1) throw new RangeError(`no input of ${units} units at depth ${depth}`);
  let shared: JsonValue = 0;
  for (let level = 0; level < depth; level++) shared = { l: shared, r: shared };
  const input = proofInput({}, { ['k'.repeat(width)]: shared, ['z'.repeat(rest)]: 0 });
  return { input, paths, width, rest };
}

/**
 * The hash work (`hashWork`) a digest of these leaves does, by D-14 and D-15 alone: per leaf,
 * its salt (an HMAC of `input:` and its pointer, the message counted) and its hash
 * (`0x00 ‖ tag ‖ 0x00`, 16 bytes, its salt, its content); the `n - 1` nodes of 65 bytes; the
 * digest (`0x02 ‖ tag ‖ 0x00`, the count and the root, 56 bytes). Each leaf is given as the
 * UTF-8 bytes of its pointer and of its content (`[pointer, kind, …]` in JCS).
 */
export function expectedHashWork(
  leaves: Iterable<{ pointerBytes: number; contentBytes: number }>,
): { calls: number; bytes: number } {
  let n = 0;
  let bytes = 0;
  for (const leaf of leaves) {
    n += 1;
    bytes += 'input:'.length + leaf.pointerBytes + 16 + 32 + leaf.contentBytes;
  }
  bytes += 65 * Math.max(n - 1, 0) + 56;
  return { calls: 2 * n + Math.max(n - 1, 0) + 1, bytes };
}

/** The UTF-8 bytes of a leaf's pointer and of its content, `[pointer, kind, …]` in JCS. */
export function leafBytes(leaf: InputLeaf): { pointerBytes: number; contentBytes: number } {
  const content =
    leaf.kind === 'value'
      ? [leaf.pointer, leaf.kind, leaf.value ?? null]
      : leaf.kind === 'array'
        ? [leaf.pointer, leaf.kind, leaf.length ?? 0]
        : [leaf.pointer, leaf.kind];
  return {
    pointerBytes: Buffer.byteLength(leaf.pointer, 'utf8'),
    contentBytes: Buffer.byteLength(canonicalize(content), 'utf8'),
  };
}
