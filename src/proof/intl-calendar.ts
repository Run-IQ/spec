import {
  NativeDate,
  NativeError,
  NativeIntlDateTimeFormat,
  NativeMap,
  NativeNumber,
  NativeRangeError,
  NativeString,
  arrayFind,
  dateTimeFormatFormatToParts,
  dateTimeFormatResolvedOptions,
  isoOf,
  mapClear,
  mapDelete,
  mapGet,
  mapIteratorNext,
  mapKeys,
  mapSet,
  mapSize,
  mathFloor,
  parseTime,
  regExpExec,
  stringSplit,
} from '../intrinsics.js';
import type { CivilCalendar } from '../time/civil.js';

// Internal to `@run-iq/spec`: a `CivilCalendar` for any IANA zone the runtime knows, read from
// `Intl` (the time zone database of the JavaScript engine, local mean times included). Used by
// `verifyProof` only for an instant that a bound of a civil window cannot decide on its own.
//
// What the runtime needs: `Intl.DateTimeFormat` with time zone support and the `longOffset`
// form of `timeZoneName` (every Node.js 20.19 and later). A runtime without them is said to be
// unable (`RuntimeCannotReadOffsets`), never taken for the proof's fault.

/** The verifier cannot read the offset of a zone: a limit of the runtime, not a fault of a proof. */
export class RuntimeCannotReadOffsets extends NativeError {}

/**
 * The runtime knows `UTC` and fixed offsets only (the minimum ECMA-402 asks for): it has no time
 * zone database. Not a fault of a zone, nor of a proof.
 */
export class RuntimeHasNoZoneData extends RuntimeCannotReadOffsets {}

/** The bounds of the two caches: an object, so that a test can lower them. */
export const intlCacheLimits = { max: 512 };

/** The formatters by canonical zone name (`resolvedOptions().timeZone`), oldest first. */
const byCanonical = new NativeMap<string, Intl.DateTimeFormat>();
/** The canonical name of a zone as written: bounded, so a flood of spellings costs nothing. */
const canonicalOf = new NativeMap<string, string>();

/** Empties the two caches (for the tests that bound them). */
export function clearIntlCaches(): void {
  mapClear(byCanonical);
  mapClear(canonicalOf);
}

/** The sizes of the two caches, for the tests that bound them. */
export function intlCacheSizes(): { formatters: number; names: number } {
  return { formatters: mapSize(byCanonical), names: mapSize(canonicalOf) };
}

/**
 * `Intl.DateTimeFormat`, captured when the module loads (the one place the tests replace it).
 * Code that reassigns `Intl.DateTimeFormat` later changes nothing here.
 */
export const intlRuntime: { DateTimeFormat: typeof Intl.DateTimeFormat } = {
  DateTimeFormat: NativeIntlDateTimeFormat,
};

function makeFormatter(zone: string): Intl.DateTimeFormat {
  return new intlRuntime.DateTimeFormat('en-US', {
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
  const known = mapGet(canonicalOf, zone);
  if (known !== undefined) {
    const cached = mapGet(byCanonical, known);
    if (cached !== undefined) return cached;
  }
  const made = makeFormatter(zone);
  const canonical = dateTimeFormatResolvedOptions(made).timeZone;
  let shared = mapGet(byCanonical, canonical);
  if (shared === undefined) {
    if (mapSize(byCanonical) >= intlCacheLimits.max) {
      const oldest = mapIteratorNext(mapKeys(byCanonical)).value;
      if (oldest !== undefined) mapDelete(byCanonical, oldest);
    }
    mapSet(byCanonical, canonical, made);
    shared = made;
  }
  if (mapSize(canonicalOf) >= intlCacheLimits.max) mapClear(canonicalOf);
  mapSet(canonicalOf, zone, canonical);
  return shared;
}

/**
 * Throws what the runtime cannot do: `RuntimeCannotReadOffsets` when it has no time zone support
 * at all (it cannot build the formatter of `UTC`), `RuntimeHasNoZoneData` only when it refuses a
 * zone every database has (a `RangeError`: it knows `UTC` only), `RuntimeCannotReadOffsets` for
 * any other failure on that zone. An offset text it prints badly is found where it is read
 * (`offsetAt`), whichever zone it is.
 */
function requireZoneSupport(): void {
  try {
    makeFormatter('UTC');
  } catch {
    throw new RuntimeCannotReadOffsets('no time zone support');
  }
  try {
    makeFormatter(PROBE_ZONE);
  } catch (error) {
    if (error instanceof NativeRangeError) throw new RuntimeHasNoZoneData('no time zone data');
    throw new RuntimeCannotReadOffsets(`cannot build the formatter of ${PROBE_ZONE}`);
  }
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
    if (error instanceof NativeRangeError) return false;
    throw new RuntimeCannotReadOffsets(
      `cannot build a formatter for the zone: ${NativeString(error)}`,
    );
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
  const match = regExpExec(/^GMT(?:([+\-\u2212])(\d{2}):(\d{2})(?::(\d{2}))?)?$/, text);
  if (!match) return undefined;
  const [, sign, hours, minutes, seconds] = match;
  if (sign === undefined) return 0;
  const total =
    (NativeNumber(hours) * 60 + NativeNumber(minutes)) * 60 + NativeNumber(seconds ?? 0);
  return (sign === '+' ? 1 : -1) * total * 1000;
}

const DAY_MS = 86_400_000;

/** The offset of `zone` from UTC at the instant `ms`, in milliseconds. */
function offsetAt(zone: string, ms: number): number {
  const part = arrayFind(
    dateTimeFormatFormatToParts(formatter(zone), new NativeDate(ms)),
    (entry) => entry.type === 'timeZoneName',
  );
  const offset = parseOffset(part?.value ?? '');
  if (offset === undefined) {
    throw new RuntimeCannotReadOffsets(`cannot read the offset of ${zone}: ${part?.value ?? ''}`);
  }
  return offset;
}

function civilDateAt(zone: string, ms: number): string {
  return stringSplit(isoOf(ms + offsetAt(zone, ms)), 'T')[0] ?? '';
}

/**
 * The calendar of the runtime. `startOfDay` is the first instant whose civil date is `day` or
 * later, found by bisection: local midnight, the first local time that exists on a day whose
 * midnight does not, and the start of the next day for a day skipped whole.
 */
export const intlCalendar: CivilCalendar = {
  toCivilDate: (at, zone) => civilDateAt(zone, parseTime(at)),
  startOfDay: (day, zone) => {
    const midnight = parseTime(`${day}T00:00:00.000Z`);
    let low = midnight - 1.2 * DAY_MS;
    let high = midnight + 1.2 * DAY_MS;
    while (high - low > 1) {
      const middle = mathFloor((low + high) / 2);
      if (civilDateAt(zone, middle) >= day) high = middle;
      else low = middle;
    }
    return isoOf(high);
  },
};
