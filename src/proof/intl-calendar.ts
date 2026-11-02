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

/** Whether the runtime can read offsets at all: time zones and `longOffset`. */
export function runtimeReadsOffsets(): boolean {
  try {
    const part = makeFormatter('UTC')
      .formatToParts(new Date(0))
      .find((entry) => entry.type === 'timeZoneName');
    return part !== undefined && parseOffset(part.value) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Whether the runtime knows the time zone `zone`. A runtime that cannot read offsets at all
 * throws `RuntimeCannotReadOffsets`: that is not a fault of the zone.
 */
export function isKnownZone(zone: string): boolean {
  if (!runtimeReadsOffsets()) throw new RuntimeCannotReadOffsets('no time zone support');
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The release of the time zone database of the runtime (`2025c`), or `undefined` when it does
 * not name it. Node.js names it in `process.versions.tz`.
 */
export function runtimeTzdata(): string | undefined {
  const release = (globalThis as { process?: { versions?: { tz?: unknown } } }).process?.versions
    ?.tz;
  return typeof release === 'string' && release !== '' ? release : undefined;
}

/**
 * The offset, in milliseconds, a `longOffset` text names (`GMT`, `GMT+02:00`, `GMT-03:30`,
 * `GMT+14:58:47`, with the true minus sign too), or `undefined` for any other text.
 */
export function parseOffset(text: string): number | undefined {
  const match = /^GMT(?:([+-−])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
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
