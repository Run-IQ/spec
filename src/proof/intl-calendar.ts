import type { CivilCalendar } from '../time/civil.js';

// Internal to `@run-iq/spec`: a `CivilCalendar` for any IANA zone the runtime knows, read from
// `Intl` (the time zone database of the JavaScript engine, local mean times included). Used by
// `verifyProof` only for an instant that a bound of a civil window cannot decide on its own.

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'longOffset',
      hour: 'numeric',
    });
    formatters.set(zone, found);
  }
  return found;
}

/** Whether the runtime knows the time zone `zone`. */
export function isKnownZone(zone: string): boolean {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** The offset of `zone` from UTC at the instant `ms`, in milliseconds (`+14:58:47` included). */
function offsetAt(zone: string, ms: number): number {
  const part = formatter(zone)
    .formatToParts(new Date(ms))
    .find((entry) => entry.type === 'timeZoneName');
  const match = /^GMT(?:([+-−])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(part?.value ?? '');
  if (!match) throw new Error(`cannot read the offset of ${zone}: ${part?.value ?? 'nothing'}`);
  const [, sign, hours, minutes, seconds] = match;
  if (sign === undefined) return 0;
  const total = (Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds ?? 0);
  return (sign === '+' ? 1 : -1) * total * 1000;
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
