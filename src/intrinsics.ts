/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars -- lib signatures, copied */
// Internal to `@run-iq/spec`: every built-in this package calls, captured once when the module
// loads. Code that runs later (a plugin, a test harness such as `vi.useFakeTimers()`, any patch
// of a prototype or of a global) changes nothing here: spec calls these references only.
//
// - Methods are held uncurried (`arrayPush(list, item)`), built from the captured
//   `Function.prototype.call` and `bind`, so a patched `call`, `apply` or `bind` changes nothing.
// - Statics (`Object.keys`, `JSON.parse`, `Math.max`, ...) are held as the functions themselves.
// - Constructors are held as `Native<Name>`; a getter (`Map.prototype.size`) is held uncurried.
//
// Nothing outside this file may use a built-in directly: `eslint-rules/no-live-builtins.mjs` fails
// the lint on any prototype method, static, getter or global of the language in `src/`. What is
// out of scope is stated in the README, "Threat model": a process whose built-ins were patched
// before this module loaded, and the iteration protocol (`for ... of`, spread, destructuring),
// which the engine runs through well-known symbols.

const { bind, call } = Function.prototype;
/** `uncurryThis(Array.prototype.push)(list, item)` is `list.push(item)`, with no live lookup. */
const uncurryThis = bind.bind(call) as unknown as (fn: unknown) => unknown;
/** `bindThis(fn, thisArg)`: `fn` with its `this` fixed, built from the captured `bind`. */
const bindThis = uncurryThis(bind) as unknown as (fn: unknown, thisArg: unknown) => unknown;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

/** `Object.getPrototypeOf`, captured. */
export const getPrototypeOf: (value: object) => object | null = Object.getPrototypeOf;

/** `fn[Symbol.hasInstance](value)` for functions: the `instanceof` of a class, captured. */
export const functionHasInstance = uncurryThis(Function.prototype[Symbol.hasInstance]) as (
  self: object,
  value: unknown,
) => boolean;
/** `next()` of the iterators of a `Map` (`keys()`, `values()`, `entries()`), captured. */
export const mapIteratorNext = uncurryThis(getPrototypeOf(new Map().keys())?.['next' as never]) as <
  T,
>(
  self: Iterator<T>,
) => IteratorResult<T, undefined>;

/** `TextEncoder`, captured: the class, `encode` and `encodeInto` (uncurried). */
export const NativeTextEncoder = TextEncoder;
export const textEncoderEncode = uncurryThis(TextEncoder.prototype.encode) as (
  self: InstanceType<typeof TextEncoder>,
  text: string,
) => Uint8Array;
export const textEncoderEncodeInto = uncurryThis(TextEncoder.prototype.encodeInto) as (
  self: InstanceType<typeof TextEncoder>,
  text: string,
  into: Uint8Array,
) => { read: number; written: number };

/**
 * The release of the time zone database a host names (`process.versions.tz` of Node.js), or
 * `undefined` when it names none or cannot be read. A pure reading, so that it can be tested.
 */
export function tzdataReleaseOf(host: unknown): string | undefined {
  try {
    const release = (host as { process?: { versions?: { tz?: unknown } } }).process?.versions?.tz;
    return typeof release === 'string' && release !== '' ? release : undefined;
  } catch {
    return undefined;
  }
}
/** The release of this runtime, read once when the module loads: a later redefinition changes nothing. */
export const loadTimeTzdata: string | undefined = tzdataReleaseOf(globalThis);

/** `Date.parse`, captured. */
export const parseTime: (text: string) => number = Date.parse;
/** The `Date` class of this realm, as it was when the package loaded. */
export const NativeDate: DateConstructor = Date;
/** The prototype of every `Date` of this realm. */
export const datePrototype: Date = Date.prototype;
/** `Intl.DateTimeFormat`, captured. */
export const NativeIntlDateTimeFormat: typeof Intl.DateTimeFormat = Intl.DateTimeFormat;

const dateGetTime = uncurryThis(Date.prototype.getTime) as (self: Date) => number;
const dateToISOString = uncurryThis(Date.prototype.toISOString) as (self: Date) => string;
const dateSetUTCFullYear = uncurryThis(Date.prototype.setUTCFullYear) as (
  self: Date,
  year: number,
  month: number,
  day: number,
) => number;
const dateSetUTCHours = uncurryThis(Date.prototype.setUTCHours) as (
  self: Date,
  hours: number,
  minutes: number,
  seconds: number,
  ms: number,
) => number;

/** The time value held by the date slot of `value`; throws when it has none. */
export function slotTime(value: object): number {
  return dateGetTime(value as Date);
}

/** The ISO string of a time value, or throws `RangeError` outside the representable range. */
export function isoOf(time: number): string {
  return dateToISOString(new NativeDate(time));
}

/** The ISO string of the current instant. */
export function nowIso(): string {
  return dateToISOString(new NativeDate());
}

/** The time value of 00:00:00.000 UTC on `year`-01-01 (proleptic, the year as given). */
export function startOfYear(year: number, month: number, day: number): number {
  return dateSetUTCFullYear(new NativeDate(0), year, month, day);
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
  dateSetUTCFullYear(instant, year, month, day);
  dateSetUTCHours(instant, hour, minute, second, millisecond);
  return dateGetTime(instant);
}

// Generated from the sites of `src/`: one definition per built-in the package calls.
export const NativeArray = Array;
export const NativeBigInt = BigInt;
export const NativeBoolean = Boolean;
export const NativeDataView = DataView;
export const NativeError = Error;
export const NativeFloat64Array = Float64Array;
export const NativeMap = Map;
export const NativeNumber = Number;
export const NativeRangeError = RangeError;
export const NativeRegExp = RegExp;
export const NativeSet = Set;
export const NativeString = String;
export const NativeUint8Array = Uint8Array;
export const NativeWeakMap = WeakMap;
export const NativeWeakSet = WeakSet;
export const functionPrototype = Function.prototype;
export const objectPrototype = Object.prototype;
export const uint8ArrayPrototype = Uint8Array.prototype;
export const symbolHasInstance = Symbol.hasInstance;
export const symbolToStringTag = Symbol.toStringTag;
export const numberMAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
export const arrayFrom: typeof Array.from = bindThis(Array.from, Array) as never;
export const arrayIsArray: typeof Array.isArray = Array.isArray;
export const jsonParse: typeof JSON.parse = JSON.parse;
export const jsonStringify: typeof JSON.stringify = JSON.stringify;
export const mathAbs: typeof Math.abs = Math.abs;
export const mathFloor: typeof Math.floor = Math.floor;
export const mathLog2: typeof Math.log2 = Math.log2;
export const mathMax: typeof Math.max = Math.max;
export const mathMin: typeof Math.min = Math.min;
export const mathSign: typeof Math.sign = Math.sign;
export const numberIsFinite: typeof Number.isFinite = Number.isFinite;
export const numberIsInteger: typeof Number.isInteger = Number.isInteger;
export const numberIsNaN: typeof Number.isNaN = Number.isNaN;
export const numberIsSafeInteger: typeof Number.isSafeInteger = Number.isSafeInteger;
export const objectAssign: typeof Object.assign = Object.assign;
export const objectDefineProperty: typeof Object.defineProperty = Object.defineProperty;
export const objectEntries: typeof Object.entries = Object.entries;
export const objectFreeze: typeof Object.freeze = Object.freeze;
export const objectFromEntries: typeof Object.fromEntries = Object.fromEntries;
export const objectGetOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor =
  Object.getOwnPropertyDescriptor;
export const objectHasOwn: typeof Object.hasOwn = Object.hasOwn;
export const objectIs: typeof Object.is = Object.is;
export const objectKeys: typeof Object.keys = Object.keys;
export const objectValues: typeof Object.values = Object.values;
export const reflectGet: typeof Reflect.get = Reflect.get;
export const reflectHas: typeof Reflect.has = Reflect.has;
export const reflectOwnKeys: typeof Reflect.ownKeys = Reflect.ownKeys;
export const symbolFor: typeof Symbol.for = Symbol.for;
export const uint8ArrayFrom: typeof Uint8Array.from = bindThis(
  Uint8Array.from,
  Uint8Array,
) as never;
export const uint8ArrayOf: typeof Uint8Array.of = bindThis(Uint8Array.of, Uint8Array) as never;
export const float64ArrayLength: <TArrayBuffer extends ArrayBufferLike = ArrayBufferLike>(
  self: Float64Array<TArrayBuffer>,
) => number = uncurryThis(
  getOwnPropertyDescriptor(getPrototypeOf(Float64Array.prototype), 'length')?.get as never,
) as never;
export const mapSize: <K, V>(self: ReadonlyMap<K, V>) => number = uncurryThis(
  getOwnPropertyDescriptor(Map.prototype, 'size')?.get as never,
) as never;
export const regExpSource: (self: RegExp) => string = uncurryThis(
  getOwnPropertyDescriptor(RegExp.prototype, 'source')?.get as never,
) as never;
export const setSize: <T>(self: ReadonlySet<T>) => number = uncurryThis(
  getOwnPropertyDescriptor(Set.prototype, 'size')?.get as never,
) as never;
export const uint8ArrayBuffer: <TArrayBuffer extends ArrayBufferLike = ArrayBufferLike>(
  self: Uint8Array<TArrayBuffer>,
) => TArrayBuffer = uncurryThis(
  getOwnPropertyDescriptor(getPrototypeOf(Uint8Array.prototype), 'buffer')?.get as never,
) as never;
export const uint8ArrayLength: <TArrayBuffer extends ArrayBufferLike = ArrayBufferLike>(
  self: Uint8Array<TArrayBuffer>,
) => number = uncurryThis(
  getOwnPropertyDescriptor(getPrototypeOf(Uint8Array.prototype), 'length')?.get as never,
) as never;
export const arrayAt: <T>(self: T[], index: number) => T | undefined = uncurryThis(
  Array.prototype.at,
) as never;
export const arrayEntries: <T>(self: readonly T[]) => ArrayIterator<[number, T]> = uncurryThis(
  Array.prototype.entries,
) as never;
export const arrayEvery: {
  <T, S extends T>(
    self: readonly T[],
    predicate: (value: T, index: number, array: readonly T[]) => value is S,
    thisArg?: any,
  ): self is readonly S[];
  <T>(
    self: readonly T[],
    predicate: (value: T, index: number, array: readonly T[]) => unknown,
    thisArg?: any,
  ): boolean;
} = uncurryThis(Array.prototype.every) as never;
export const arrayFill: <T>(self: T[], value: T, start?: number, end?: number) => T[] = uncurryThis(
  Array.prototype.fill,
) as never;
export const arrayFilter: {
  <T, S extends T>(
    self: readonly T[],
    predicate: (value: T, index: number, array: readonly T[]) => value is S,
    thisArg?: any,
  ): S[];
  <T>(
    self: readonly T[],
    predicate: (value: T, index: number, array: readonly T[]) => unknown,
    thisArg?: any,
  ): T[];
} = uncurryThis(Array.prototype.filter) as never;
export const arrayFind: {
  <T, S extends T>(
    self: readonly T[],
    predicate: (value: T, index: number, obj: readonly T[]) => value is S,
    thisArg?: any,
  ): S | undefined;
  <T>(
    self: readonly T[],
    predicate: (value: T, index: number, obj: readonly T[]) => unknown,
    thisArg?: any,
  ): T | undefined;
} = uncurryThis(Array.prototype.find) as never;
export const arrayFindIndex: <T>(
  self: readonly T[],
  predicate: (value: T, index: number, obj: readonly T[]) => unknown,
  thisArg?: any,
) => number = uncurryThis(Array.prototype.findIndex) as never;
export const arrayFlat: <T, A, D extends number = 1>(self: A, depth?: D) => FlatArray<A, D>[] =
  uncurryThis(Array.prototype.flat) as never;
export const arrayFlatMap: <T, U, This = undefined>(
  self: readonly T[],
  callback: (this: This, value: T, index: number, array: T[]) => U | ReadonlyArray<U>,
  thisArg?: This,
) => U[] = uncurryThis(Array.prototype.flatMap) as never;
export const arrayForEach: <T>(
  self: readonly T[],
  callbackfn: (value: T, index: number, array: readonly T[]) => void,
  thisArg?: any,
) => void = uncurryThis(Array.prototype.forEach) as never;
export const arrayIncludes: <T>(
  self: readonly T[],
  searchElement: T,
  fromIndex?: number,
) => boolean = uncurryThis(Array.prototype.includes) as never;
export const arrayIndexOf: <T>(self: readonly T[], searchElement: T, fromIndex?: number) => number =
  uncurryThis(Array.prototype.indexOf) as never;
export const arrayJoin: <T>(self: readonly T[], separator?: string) => string = uncurryThis(
  Array.prototype.join,
) as never;
export const arrayMap: <T, U>(
  self: readonly T[],
  callbackfn: (value: T, index: number, array: readonly T[]) => U,
  thisArg?: any,
) => U[] = uncurryThis(Array.prototype.map) as never;
export const arrayPop: <T>(self: T[]) => T | undefined = uncurryThis(Array.prototype.pop) as never;
export const arrayPush: <T>(self: T[], ...items: T[]) => number = uncurryThis(
  Array.prototype.push,
) as never;
export const arrayReduce: {
  <T>(
    self: T[],
    callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T,
  ): T;
  <T>(
    self: T[],
    callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T,
    initialValue: T,
  ): T;
  <T, U>(
    self: T[],
    callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U,
    initialValue: U,
  ): U;
} = uncurryThis(Array.prototype.reduce) as never;
export const arraySlice: <T>(self: readonly T[], start?: number, end?: number) => T[] = uncurryThis(
  Array.prototype.slice,
) as never;
export const arraySome: <T>(
  self: readonly T[],
  predicate: (value: T, index: number, array: readonly T[]) => unknown,
  thisArg?: any,
) => boolean = uncurryThis(Array.prototype.some) as never;
export const arraySort: <T>(self: T[], compareFn?: (a: T, b: T) => number) => T[] = uncurryThis(
  Array.prototype.sort,
) as never;
export const arrayUnshift: <T>(self: T[], ...items: T[]) => number = uncurryThis(
  Array.prototype.unshift,
) as never;
export const bigIntToString: (self: bigint, radix?: number) => string = uncurryThis(
  BigInt.prototype.toString,
) as never;
export const dataViewSetUint32: (
  self: DataView,
  byteOffset: number,
  value: number,
  littleEndian?: boolean,
) => void = uncurryThis(DataView.prototype.setUint32) as never;
export const dateTimeFormatFormatToParts: (
  self: Intl.DateTimeFormat,
  date?: Date | number,
) => Intl.DateTimeFormatPart[] = uncurryThis(Intl.DateTimeFormat.prototype.formatToParts) as never;
export const dateTimeFormatResolvedOptions: (
  self: Intl.DateTimeFormat,
) => Intl.ResolvedDateTimeFormatOptions = uncurryThis(
  Intl.DateTimeFormat.prototype.resolvedOptions,
) as never;
export const functionCall: <T, A extends any[], R>(
  self: (this: T, ...args: A) => R,
  thisArg: T,
  ...args: A
) => R = uncurryThis(Function.prototype.call) as never;
export const mapClear: <K, V>(self: Map<K, V>) => void = uncurryThis(Map.prototype.clear) as never;
export const mapDelete: <K, V>(self: Map<K, V>, key: K) => boolean = uncurryThis(
  Map.prototype.delete,
) as never;
export const mapGet: <K, V>(self: ReadonlyMap<K, V>, key: K) => V | undefined = uncurryThis(
  Map.prototype.get,
) as never;
export const mapHas: <K, V>(self: ReadonlyMap<K, V>, key: K) => boolean = uncurryThis(
  Map.prototype.has,
) as never;
export const mapKeys: <K, V>(self: ReadonlyMap<K, V>) => MapIterator<K> = uncurryThis(
  Map.prototype.keys,
) as never;
export const mapSet: <K, V>(self: Map<K, V>, key: K, value: V) => Map<K, V> = uncurryThis(
  Map.prototype.set,
) as never;
export const mapValues: <K, V>(self: Map<K, V>) => MapIterator<V> = uncurryThis(
  Map.prototype.values,
) as never;
export const mapEntries: <K, V>(self: ReadonlyMap<K, V>) => MapIterator<[K, V]> = uncurryThis(
  Map.prototype.entries,
) as never;
export const setValues: <T>(self: ReadonlySet<T>) => SetIterator<T> = uncurryThis(
  Set.prototype.values,
) as never;
/** `next()` of the iterators of a `Set`, captured. */
export const setIteratorNext = uncurryThis(
  getPrototypeOf(new Set().values())?.['next' as never],
) as <T>(self: Iterator<T>) => IteratorResult<T, undefined>;
export const regExpExec: (self: RegExp, string: string) => RegExpExecArray | null = uncurryThis(
  RegExp.prototype.exec,
) as never;
export const regExpTest: (self: RegExp, string: string) => boolean = uncurryThis(
  RegExp.prototype.test,
) as never;
export const setAdd: <T>(self: Set<T>, value: T) => Set<T> = uncurryThis(
  Set.prototype.add,
) as never;
export const setDelete: <T>(self: Set<T>, value: T) => boolean = uncurryThis(
  Set.prototype.delete,
) as never;
export const setHas: <T>(self: ReadonlySet<T>, value: T) => boolean = uncurryThis(
  Set.prototype.has,
) as never;
export const stringCharAt: (self: string, pos: number) => string = uncurryThis(
  String.prototype.charAt,
) as never;
export const stringCharCodeAt: (self: string, index: number) => number = uncurryThis(
  String.prototype.charCodeAt,
) as never;
export const stringIncludes: (self: string, searchString: string, position?: number) => boolean =
  uncurryThis(String.prototype.includes) as never;
export const stringIndexOf: (self: string, searchString: string, position?: number) => number =
  uncurryThis(String.prototype.indexOf) as never;
export const stringPadEnd: (self: string, maxLength: number, fillString?: string) => string =
  uncurryThis(String.prototype.padEnd) as never;
export const stringPadStart: (self: string, maxLength: number, fillString?: string) => string =
  uncurryThis(String.prototype.padStart) as never;
export const stringRepeat: (self: string, count: number) => string = uncurryThis(
  String.prototype.repeat,
) as never;
export const stringReplace: {
  (self: string, searchValue: string | RegExp, replaceValue: string): string;
  (
    self: string,
    searchValue: string | RegExp,
    replacer: (substring: string, ...args: any[]) => string,
  ): string;
  (
    self: string,
    searchValue: { [Symbol.replace](string: string, replaceValue: string): string },
    replaceValue: string,
  ): string;
  (
    self: string,
    searchValue: {
      [Symbol.replace](
        string: string,
        replacer: (substring: string, ...args: any[]) => string,
      ): string;
    },
    replacer: (substring: string, ...args: any[]) => string,
  ): string;
} = uncurryThis(String.prototype.replace) as never;
export const stringSlice: (self: string, start?: number, end?: number) => string = uncurryThis(
  String.prototype.slice,
) as never;
export const stringSplit: {
  (self: string, separator: string | RegExp, limit?: number): string[];
  (
    self: string,
    splitter: { [Symbol.split](string: string, limit?: number): string[] },
    limit?: number,
  ): string[];
} = uncurryThis(String.prototype.split) as never;
export const stringStartsWith: (self: string, searchString: string, position?: number) => boolean =
  uncurryThis(String.prototype.startsWith) as never;
export const stringToLowerCase: (self: string) => string = uncurryThis(
  String.prototype.toLowerCase,
) as never;
export const symbolToString: (self: symbol) => string = uncurryThis(
  Symbol.prototype.toString,
) as never;
export const uint8ArrayEvery: <TArrayBuffer extends ArrayBufferLike = ArrayBufferLike>(
  self: Uint8Array<TArrayBuffer>,
  predicate: (value: number, index: number, array: Uint8Array<TArrayBuffer>) => unknown,
  thisArg?: any,
) => boolean = uncurryThis(Uint8Array.prototype.every) as never;
export const uint8ArraySet: <TArrayBuffer extends ArrayBufferLike = ArrayBufferLike>(
  self: Uint8Array<TArrayBuffer>,
  array: ArrayLike<number>,
  offset?: number,
) => void = uncurryThis(Uint8Array.prototype.set) as never;
export const uint8ArraySlice: <TArrayBuffer extends ArrayBufferLike = ArrayBufferLike>(
  self: Uint8Array<TArrayBuffer>,
  start?: number,
  end?: number,
) => Uint8Array<ArrayBuffer> = uncurryThis(Uint8Array.prototype.slice) as never;
export const uint8ArraySubarray: <TArrayBuffer extends ArrayBufferLike = ArrayBufferLike>(
  self: Uint8Array<TArrayBuffer>,
  begin?: number,
  end?: number,
) => Uint8Array<TArrayBuffer> = uncurryThis(Uint8Array.prototype.subarray) as never;
export const weakMapGet: <K extends WeakKey, V>(self: WeakMap<K, V>, key: K) => V | undefined =
  uncurryThis(WeakMap.prototype.get) as never;
export const weakMapSet: <K extends WeakKey, V>(
  self: WeakMap<K, V>,
  key: K,
  value: V,
) => WeakMap<K, V> = uncurryThis(WeakMap.prototype.set) as never;
export const weakSetAdd: <T extends WeakKey>(self: WeakSet<T>, value: T) => WeakSet<T> =
  uncurryThis(WeakSet.prototype.add) as never;
export const weakSetHas: <T extends WeakKey>(self: WeakSet<T>, value: T) => boolean = uncurryThis(
  WeakSet.prototype.has,
) as never;

// `from` kept out of the exported statement: a string `from'` would read as an import to the
// test that scans the module graph for `node:` imports.
const BOUND_STATICS: readonly (readonly [object, string])[] = [
  [Array, 'from'],
  [Uint8Array, 'from'],
];

/** Every built-in captured above, as its owner and key: the table the patch test walks. */
export const CAPTURED: readonly (readonly [object, string])[] = [
  [globalThis, 'Array'],
  [globalThis, 'BigInt'],
  [globalThis, 'Boolean'],
  [globalThis, 'DataView'],
  [globalThis, 'Error'],
  [globalThis, 'Float64Array'],
  [globalThis, 'Map'],
  [globalThis, 'Number'],
  [globalThis, 'RangeError'],
  [globalThis, 'RegExp'],
  [globalThis, 'Set'],
  [globalThis, 'String'],
  [globalThis, 'TextEncoder'],
  [globalThis, 'Uint8Array'],
  [globalThis, 'WeakMap'],
  [globalThis, 'WeakSet'],
  [Array, 'isArray'],
  [JSON, 'parse'],
  [JSON, 'stringify'],
  [Math, 'abs'],
  [Math, 'floor'],
  [Math, 'log2'],
  [Math, 'max'],
  [Math, 'min'],
  [Math, 'sign'],
  [Number, 'isFinite'],
  [Number, 'isInteger'],
  [Number, 'isNaN'],
  [Number, 'isSafeInteger'],
  [Object, 'assign'],
  [Object, 'defineProperty'],
  [Object, 'entries'],
  [Object, 'freeze'],
  [Object, 'fromEntries'],
  [Object, 'getOwnPropertyDescriptor'],
  [Object, 'hasOwn'],
  [Object, 'is'],
  [Object, 'keys'],
  [Object, 'values'],
  [Reflect, 'get'],
  [Reflect, 'has'],
  [Reflect, 'ownKeys'],
  [Symbol, 'for'],
  [Uint8Array, 'of'],
  [getPrototypeOf(Float64Array.prototype) as object, 'length'],
  [Map.prototype, 'size'],
  [RegExp.prototype, 'source'],
  [Set.prototype, 'size'],
  [getPrototypeOf(Uint8Array.prototype) as object, 'buffer'],
  [getPrototypeOf(Uint8Array.prototype) as object, 'length'],
  [Array.prototype, 'at'],
  [Array.prototype, 'entries'],
  [Array.prototype, 'every'],
  [Array.prototype, 'fill'],
  [Array.prototype, 'filter'],
  [Array.prototype, 'find'],
  [Array.prototype, 'findIndex'],
  [Array.prototype, 'flat'],
  [Array.prototype, 'flatMap'],
  [Array.prototype, 'forEach'],
  [Array.prototype, 'includes'],
  [Array.prototype, 'indexOf'],
  [Array.prototype, 'join'],
  [Array.prototype, 'map'],
  [Array.prototype, 'pop'],
  [Array.prototype, 'push'],
  [Array.prototype, 'reduce'],
  [Array.prototype, 'slice'],
  [Array.prototype, 'some'],
  [Array.prototype, 'sort'],
  [Array.prototype, 'unshift'],
  [BigInt.prototype, 'toString'],
  [DataView.prototype, 'setUint32'],
  [Intl.DateTimeFormat.prototype, 'formatToParts'],
  [Intl.DateTimeFormat.prototype, 'resolvedOptions'],
  ...BOUND_STATICS,
  [Function.prototype, 'call'],
  [Map.prototype, 'clear'],
  [Map.prototype, 'delete'],
  [Map.prototype, 'get'],
  [Map.prototype, 'has'],
  [Map.prototype, 'keys'],
  [Map.prototype, 'set'],
  [Map.prototype, 'values'],
  [Map.prototype, 'entries'],
  [TextEncoder.prototype, 'encode'],
  [TextEncoder.prototype, 'encodeInto'],
  [Set.prototype, 'values'],
  [getPrototypeOf(new Map().keys()) as object, 'next'],
  [getPrototypeOf(new Set().values()) as object, 'next'],
  [RegExp.prototype, 'exec'],
  [RegExp.prototype, 'test'],
  [Set.prototype, 'add'],
  [Set.prototype, 'delete'],
  [Set.prototype, 'has'],
  [String.prototype, 'charAt'],
  [String.prototype, 'charCodeAt'],
  [String.prototype, 'includes'],
  [String.prototype, 'indexOf'],
  [String.prototype, 'padEnd'],
  [String.prototype, 'padStart'],
  [String.prototype, 'repeat'],
  [String.prototype, 'replace'],
  [String.prototype, 'slice'],
  [String.prototype, 'split'],
  [String.prototype, 'startsWith'],
  [String.prototype, 'toLowerCase'],
  [Symbol.prototype, 'toString'],
  [Uint8Array.prototype, 'every'],
  [Uint8Array.prototype, 'set'],
  [Uint8Array.prototype, 'slice'],
  [Uint8Array.prototype, 'subarray'],
  [WeakMap.prototype, 'get'],
  [WeakMap.prototype, 'set'],
  [WeakSet.prototype, 'add'],
  [WeakSet.prototype, 'has'],
  [Function.prototype, 'call'],
  [Function.prototype, 'bind'],
  [Function.prototype, 'apply'],
  [Date.prototype, 'getTime'],
  [Date.prototype, 'toISOString'],
  [Date.prototype, 'setUTCFullYear'],
  [Date.prototype, 'setUTCHours'],
  [Date, 'parse'],
  [Object, 'getPrototypeOf'],
  [Intl, 'DateTimeFormat'],
];

// Collections without the iteration protocol. `for ... of`, spread, array destructuring and the
// constructors of `Map`, `Set` and `Uint8Array` read `Symbol.iterator` and the `next` of the
// array iterator: a patch of either could change what they see. Everything below uses indexed
// loops, own properties and the captured `next` of the `Map` and `Set` iterators.

/** The values `iterator` yields, in order, drained with the captured `next` of `step`. */
function drain<T>(
  iterator: Iterator<T>,
  step: (self: Iterator<T>) => IteratorResult<T, undefined>,
): T[] {
  const out: T[] = [];
  for (let result = step(iterator); result.done !== true; result = step(iterator)) {
    out[out.length] = result.value as T;
  }
  return out;
}

/** The keys of `map`, in insertion order, as an array. */
export function mapKeysArray<K, V>(map: ReadonlyMap<K, V>): K[] {
  return drain<K>(mapKeys(map), mapIteratorNext);
}
/** The values of `map`, in insertion order, as an array. */
export function mapValuesArray<K, V>(map: Map<K, V>): V[] {
  return drain<V>(mapValues(map), mapIteratorNext);
}
/** The `[key, value]` pairs of `map`, in insertion order, as an array. */
export function mapEntriesArray<K, V>(map: ReadonlyMap<K, V>): [K, V][] {
  return drain<[K, V]>(mapEntries(map), mapIteratorNext);
}
/** The members of `set`, in insertion order, as an array. */
export function setValuesArray<T>(set: ReadonlySet<T>): T[] {
  return drain<T>(setValues(set), setIteratorNext);
}
/** The bytes of `bytes` as an array of numbers. */
export function bytesToArray(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] as number;
  return out;
}
/** The lists put end to end in one new array (no `concat`, no spread). */
export function arrayConcat<L extends readonly (readonly unknown[])[]>(
  ...lists: L
): L[number][number][] {
  const out: L[number][number][] = [];
  for (let l = 0; l < lists.length; l++) {
    const list = lists[l] as readonly unknown[];
    for (let i = 0; i < list.length; i++) out[out.length] = list[i] as L[number][number];
  }
  return out;
}
/** `self.push(...items)` without a spread; returns the new length. */
export function arrayPushAll<T>(self: T[], items: readonly T[]): number {
  for (let i = 0; i < items.length; i++) self[self.length] = items[i] as T;
  return self.length;
}
/** `new Set(items)` without the iteration protocol. */
export function setOf<T>(items: readonly T[]): Set<T> {
  const out = new NativeSet<T>();
  for (let i = 0; i < items.length; i++) setAdd(out, items[i] as T);
  return out;
}
/** `new Map(entries)` without the iteration protocol. */
export function mapOf<K, V>(entries: readonly (readonly [K, V])[]): Map<K, V> {
  const out = new NativeMap<K, V>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as readonly [K, V];
    mapSet(out, entry[0], entry[1]);
  }
  return out;
}
/** `Uint8Array.from(numbers)` without the iteration protocol. */
export function bytesFromNumbers(numbers: ArrayLike<number>): Uint8Array {
  const out = new NativeUint8Array(numbers.length);
  for (let i = 0; i < numbers.length; i++) out[i] = numbers[i] as number;
  return out;
}
/** `Object.fromEntries(entries)` without the iteration protocol (own data properties). */
export function objectOfEntries<V>(entries: readonly (readonly [string, V])[]): Record<string, V> {
  const out: Record<string, V> = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as readonly [string, V];
    objectDefineProperty(out, entry[0], {
      value: entry[1],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
