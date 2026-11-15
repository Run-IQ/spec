import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  merkleRoot,
  normalizeRuleDefinition,
  PROOF_SECTIONS,
  proofLeafHashes,
  SpecError,
  VerifyOptionsError,
  validateRuleDefinition,
} from '../src/index.js';
import { MAX_JSON_VALUES } from '../src/values.js';
import type {
  CivilCalendar,
  JsonValue,
  FactAssertion,
  ProofCounts,
  ProofInput,
  Referential,
  RuleDefinitionInput,
  UnsignedProof,
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

/** The `VerifyOptionsError` a call to `verifyProof` throws for a mistake of the caller. */
export function optionError(call: () => unknown): VerifyOptionsError {
  try {
    call();
  } catch (error) {
    if (error instanceof VerifyOptionsError) return error;
    throw error;
  }
  throw new Error('expected a VerifyOptionsError');
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

/** The longest list at `/data/a`: every input holds `data`, `meta`, its six members and `a`. */
export const LONGEST_DATA_LIST = MAX_JSON_VALUES - 9;

/** `value` typed as what a JavaScript caller may pass. */
export function loose<T>(value: unknown): T {
  return value as T;
}

/** The built package, `dist/`, that `npm run build` writes. */
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');

/**
 * The path of `file` in the built package. A test of the build never skips: without it, it
 * fails, saying to build first.
 */
export function builtFile(file: string): string {
  const path = resolve(DIST, file);
  if (!existsSync(path)) {
    throw new Error(`${path} is missing: run \`npm run build\` first`);
  }
  return path;
}

/** A JSON copy of `value`: what a verifier receives over the wire. */
export function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A deterministic generator (mulberry32): the same cases on every run. */
export function generator(seed: number): <T>(choices: readonly T[]) => T {
  let state = seed;
  return <T>(choices: readonly T[]): T => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    const index = Math.floor(unit * choices.length);
    if (index >= choices.length) throw new Error('no choices');
    // An index below the length: the choice itself, `undefined` included.
    return choices[index] as T;
  };
}

/** Every string of 1 to `n` characters drawn from `alphabet`. */
export function stringsOf(alphabet: readonly string[], n: number): string[] {
  let level = [''];
  const all: string[] = [];
  for (let length = 1; length <= n; length++) {
    level = level.flatMap((text) => alphabet.map((c) => text + c));
    all.push(...level);
  }
  return all;
}

/** A Proxy over `target` whose every trap calls `fail` (which throws). */
export function allTrapsThrow(target: object, fail: () => never): object {
  const traps: ProxyHandler<object> = {
    get: fail,
    has: fail,
    ownKeys: fail,
    getOwnPropertyDescriptor: fail,
    getPrototypeOf: fail,
    apply: fail,
    construct: fail,
    set: fail,
    defineProperty: fail,
    deleteProperty: fail,
    isExtensible: fail,
    preventExtensions: fail,
    setPrototypeOf: fail,
  };
  return new Proxy(target, traps);
}

/** A Proxy that has been revoked: every operation on it throws a `TypeError`. */
export function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A shallow copy of `value` without its member `key`. */
export function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

/** `target` behind a Proxy that counts every property read in `counter`. */
export function counted<T extends object>(target: T, counter: { reads: number }): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      counter.reads++;
      return Reflect.get(object, key, receiver) as unknown;
    },
  });
}

/**
 * The digest of a proof's content (D-16), from its leaves (`proofLeafHashes`), its root
 * (`merkleRoot`) and node:crypto: `sha256(0x02 ‖ utf8('run-iq.proof/1') ‖ 0x00 ‖
 * uint64be(n) ‖ root)`. Its consistency is not checked.
 */
export function treeDigestOf(content: object): string {
  const leaves = proofLeafHashes(content as UnsignedProof);
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(leaves.length));
  return createHash('sha256')
    .update(Buffer.from([2]))
    .update('run-iq.proof/1\u0000', 'utf8')
    .update(count)
    .update(merkleRoot(leaves))
    .digest('hex');
}

/**
 * `content` sealed by hand, as a faulty producer would (the digest of its leaves, unchecked,
 * `treeDigestOf`): `sealProof` refuses what `verifyProof` then reports.
 */
export function handSealed<T extends object>(
  content: T,
): T & { counts: ProofCounts; digest: string } {
  const counted = withCounts(content);
  return { ...counted, digest: treeDigestOf(counted) };
}

/** `content` with the `counts` of its sections as they are (D-16), as sealing gives them. */
export function withCounts<T extends object>(content: T): T & { counts: ProofCounts } {
  const record = content as Record<string, unknown>;
  const counts = Object.fromEntries(
    PROOF_SECTIONS.map((section) => {
      const list = record[section];
      return [section, Array.isArray(list) ? list.length : 0];
    }),
  ) as ProofCounts;
  return { ...content, counts };
}
