import type { CivilCalendar } from '../time/civil.js';

// Internal to `@run-iq/spec`: a `CivilCalendar` for any IANA zone the runtime knows, read from
// `Intl` (the time zone database of the JavaScript engine, local mean times included). Used by
// `verifyProof` only for an instant that a bound of a civil window cannot decide on its own.
//
// What the runtime needs: `Intl.DateTimeFormat` with time zone support and the `longOffset`
// form of `timeZoneName` (every Node.js 20.19 and later). A runtime without them is said to be
// unable (`RuntimeCannotReadOffsets`), never taken for the proof's fault.

/** The verifier cannot read the offset of a zone: a limit of the runtime, not a fault of a proof. */
export class RuntimeCannotReadOffsets extends Error {}

/**
 * The runtime knows `UTC` and fixed offsets only (the minimum ECMA-402 asks for): it has no time
 * zone database. Not a fault of a zone, nor of a proof.
 */
export class RuntimeHasNoZoneData extends RuntimeCannotReadOffsets {}

/** The bounds of the two caches: an object, so that a test can lower them. */
export const intlCacheLimits = { max: 512 };

/** The formatters by canonical zone name (`resolvedOptions().timeZone`), oldest first. */
const byCanonical = new Map<string, Intl.DateTimeFormat>();
/** The canonical name of a zone as written: bounded, so a flood of spellings costs nothing. */
const canonicalOf = new Map<string, string>();

/** Empties the two caches (for the tests that bound them). */
export function clearIntlCaches(): void {
  byCanonical.clear();
  canonicalOf.clear();
}

/** The sizes of the two caches, for the tests that bound them. */
export function intlCacheSizes(): { formatters: number; names: number } {
  return { formatters: byCanonical.size, names: canonicalOf.size };
}

function makeFormatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'longOffset',
    hour: 'numeric',
  });
}

/**
 * The formatter of `zone`. The cache is keyed by the canonical name, so every spelling of a zone
 * (`EUROPE/PARIS`, `Europe/paris`) shares one entry, and holds at most `intlCacheLimits.max` (512): a proof
 * cannot make a long-running verifier grow by writing the same zone in new ways.
 */
function formatter(zone: string): Intl.DateTimeFormat {
  const known = canonicalOf.get(zone);
  if (known !== undefined) {
    const cached = byCanonical.get(known);
    if (cached !== undefined) return cached;
  }
  const made = makeFormatter(zone);
  const canonical = made.resolvedOptions().timeZone;
  let shared = byCanonical.get(canonical);
  if (shared === undefined) {
    if (byCanonical.size >= intlCacheLimits.max) {
      const oldest = byCanonical.keys().next().value;
      if (oldest !== undefined) byCanonical.delete(oldest);
    }
    byCanonical.set(canonical, made);
    shared = made;
  }
  if (canonicalOf.size >= intlCacheLimits.max) canonicalOf.clear();
  canonicalOf.set(zone, canonical);
  return shared;
}

/** Whether `makeFormatter(zone)` reads a valid `longOffset` text at the epoch. */
function readsOffsetOf(zone: string): boolean {
  const part = makeFormatter(zone)
    .formatToParts(new Date(0))
    .find((entry) => entry.type === 'timeZoneName');
  return part !== undefined && parseOffset(part.value) !== undefined;
}

/**
 * Throws what the runtime cannot do: `RuntimeCannotReadOffsets` without time zones and the
 * `longOffset` form at all, `RuntimeHasNoZoneData` when it knows `UTC` only. Any other throw of
 * the runtime while it is asked is the same limit.
 */
function requireZoneSupport(): void {
  let utc: boolean;
  try {
    utc = readsOffsetOf('UTC');
  } catch {
    utc = false;
  }
  if (!utc) throw new RuntimeCannotReadOffsets('no time zone support');
  let named: boolean;
  try {
    named = readsOffsetOf(PROBE_ZONE);
  } catch {
    named = false;
  }
  if (!named) throw new RuntimeHasNoZoneData('no time zone data');
}

/** A zone every time zone database has, to tell a runtime with a database from one without. */
const PROBE_ZONE = 'America/New_York';

/**
 * Whether the runtime knows the time zone `zone`. A runtime that cannot read offsets at all, or
 * has no database, throws (`RuntimeCannotReadOffsets`, `RuntimeHasNoZoneData`): that is not a
 * fault of the zone. A zone the runtime refuses with a `RangeError` is unknown; any other throw
 * of the runtime is a limit of the runtime.
 */
export function isKnownZone(zone: string): boolean {
  requireZoneSupport();
  try {
    formatter(zone);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw new RuntimeCannotReadOffsets(`cannot build a formatter for the zone: ${String(error)}`);
  }
}

/**
 * The release of the time zone database of the runtime (`2025c`), or `undefined` when it does
 * not name it. Node.js names it in `process.versions.tz`.
 */
export function runtimeTzdata(): string | undefined {
  try {
    const release = (globalThis as { process?: { versions?: { tz?: unknown } } }).process?.versions
      ?.tz;
    return typeof release === 'string' && release !== '' ? release : undefined;
  } catch {
    // `process.versions` that cannot be read: the release is not known, which the notice says.
    return undefined;
  }
}

/**
 * The offset, in milliseconds, a `longOffset` text names (`GMT`, `GMT+02:00`, `GMT-03:30`,
 * `GMT+14:58:47`, with the true minus sign U+2212 too), or `undefined` for any other text.
 */
export function parseOffset(text: string): number | undefined {
  const match = /^GMT(?:([+\-\u2212])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!match) return undefined;
  const [, sign, hours, minutes, seconds] = match;
  if (sign === undefined) return 0;
  const total = (Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds ?? 0);
  return (sign === '+' ? 1 : -1) * total * 1000;
}

const DAY_MS = 86_400_000;

/** The offset of `zone` from UTC at the instant `ms`, in milliseconds. */
function offsetAt(zone: string, ms: number): number {
  const part = formatter(zone)
    .formatToParts(new Date(ms))
    .find((entry) => entry.type === 'timeZoneName');
  const offset = parseOffset(part?.value ?? '');
  if (offset === undefined) {
    throw new RuntimeCannotReadOffsets(`cannot read the offset of ${zone}: ${part?.value ?? ''}`);
  }
  return offset;
}

function civilDateAt(zone: string, ms: number): string {
  return new Date(ms + offsetAt(zone, ms)).toISOString().split('T')[0] ?? '';
}

/**
 * The calendar of the runtime. `startOfDay` is the first instant whose civil date is `day` or
 * later, found by bisection: local midnight, the first local time that exists on a day whose
 * midnight does not, and the start of the next day for a day skipped whole.
 */
export const intlCalendar: CivilCalendar = {
  toCivilDate: (at, zone) => civilDateAt(zone, Date.parse(at)),
  startOfDay: (day, zone) => {
    const midnight = Date.parse(`${day}T00:00:00.000Z`);
    let low = midnight - 1.2 * DAY_MS;
    let high = midnight + 1.2 * DAY_MS;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (civilDateAt(zone, middle) >= day) high = middle;
      else low = middle;
    }
    return new Date(high).toISOString();
  },
};
