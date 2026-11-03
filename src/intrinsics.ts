// Internal to `@run-iq/spec`: the intrinsics this package relies on, captured once when the
// module loads. A plugin, a test harness (`vi.useFakeTimers()`) or any other code that later
// replaces `globalThis.Date`, or a method of `Date.prototype`, changes nothing here: spec
// compares against and calls these references only. A `Date` is the one of this realm, whose
// prototype is `datePrototype`.

/** The `Date` class of this realm, as it was when the package loaded. */
export const NativeDate: DateConstructor = Date;
/** The prototype of every `Date` of this realm. */
export const datePrototype: Date = Date.prototype;
/** `Object.getPrototypeOf`, captured. */
export const getPrototypeOf: (value: object) => object | null = Object.getPrototypeOf;
/** `Date.parse`, captured. */
export const parseTime: (text: string) => number = Date.parse;

const dateGetTime = Date.prototype.getTime;
const dateToISOString = Date.prototype.toISOString;
const dateSetUTCFullYear = Date.prototype.setUTCFullYear;
const dateSetUTCHours = Date.prototype.setUTCHours;

/** The time value held by the date slot of `value`; throws when it has none. */
export function slotTime(value: object): number {
  return dateGetTime.call(value);
}

/** The ISO string of a time value, or throws `RangeError` outside the representable range. */
export function isoOf(time: number): string {
  return dateToISOString.call(new NativeDate(time));
}

/** The ISO string of the current instant. */
export function nowIso(): string {
  return dateToISOString.call(new NativeDate());
}

/** The time value of 00:00:00.000 UTC on `year`-01-01 (proleptic, the year as given). */
export function startOfYear(year: number, month: number, day: number): number {
  return dateSetUTCFullYear.call(new NativeDate(0), year, month, day);
}

/** The time value of a UTC date and time, the year as given (years 0 to 99 are not shifted). */
export function utcTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): number {
  const instant = new NativeDate(0);
  dateSetUTCFullYear.call(instant, year, month, day);
  dateSetUTCHours.call(instant, hour, minute, second, millisecond);
  return dateGetTime.call(instant);
}
