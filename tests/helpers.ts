import { expect } from 'vitest';
import { normalizeRuleDefinition, SpecError, validateRuleDefinition } from '../src/index.js';
import type {
  CivilCalendar,
  FactAssertion,
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

/** A value whose deepest value is `levels` objects below it: `nested(1)` is `{ a: 1 }`. */
export function nested(levels: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < levels; i++) value = { a: value };
  return value;
}
