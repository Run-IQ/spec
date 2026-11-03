import { toJsonDocument, toJsonValue } from '../canonical.js';
import {
  citeName,
  describeError,
  isOwnError,
  quoteText,
  specErrorPath,
  unreadableMessage,
} from '../errors.js';
import type { RuleValidationIssue } from '../issues.js';
import {
  hasLoneSurrogate,
  isPlainObject,
  loneSurrogateMessage,
  readList,
  spendValues,
  tooLargeMessage,
} from '../values.js';
import {
  NativeMap,
  NativeSet,
  NativeWeakMap,
  arrayIncludes,
  arrayIsArray,
  arrayJoin,
  arrayMap,
  arraySome,
  mapGet,
  mapSet,
  objectDefineProperty,
  objectEntries,
  objectHasOwn,
  objectKeys,
  regExpTest,
  setHas,
  weakMapGet,
  weakMapSet,
} from '../intrinsics.js';

// Internal to `@run-iq/spec`: the combinators the proof validator is written with. Each check
// reads its value once, reports every problem through `add`, and returns a plain copy.

export type Add = (path: string, message: string) => void;
/**
 * Checks `value` at `path`, reporting each problem through `add`, and returns its copy: the
 * value itself for a scalar, a plain copy of what was read for a list or an object. The copy is
 * the proof's snapshot only when nothing was reported.
 */
export type Check = (value: unknown, path: string, add: Add) => unknown;

/** A closed object: its fields in reporting order, and which of them may be absent. */
export interface Shape {
  /** How messages write the object: `{ id, version, checksum, sourceRef? }`. */
  readonly summary: string;
  readonly fields: Readonly<Record<string, Check>>;
  readonly optional?: readonly string[];
  /**
   * Checked before anything else, on the members read: when it reports a problem, that problem
   * is the only one (an unknown format makes the rest of the object unreadable). It may instead
   * give the shape the members follow (the variant a `kind` names).
   */
  readonly gate?: (
    members: ReadonlyMap<string, unknown>,
    path: string,
  ) => RuleValidationIssue | Shape | undefined;
  /** Checked after the fields, on their copies, when each field read gave no problem. */
  readonly refine?: (copy: Readonly<Record<string, unknown>>, path: string, add: Add) => void;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A check of a scalar: `test` reports its problem; the copy is the value itself. */
export function scalarCheck(test: (value: unknown, path: string, add: Add) => void): Check {
  return (value, path, add) => {
    test(value, path, add);
    return value;
  };
}

/** A string, then `more` on it; a lone UTF-16 surrogate is refused (no JSON text holds one). */
export function stringCheck(what: string, more?: (text: string, path: string) => string | void) {
  return scalarCheck((value, path, add) => {
    if (typeof value !== 'string' || value === '') {
      add(path, `${citeName(path)} must be ${what}`);
    } else if (hasLoneSurrogate(value)) {
      add(path, loneSurrogateMessage(path));
    } else {
      const problem = more?.(value, path);
      if (problem) add(path, problem);
    }
  });
}

export const nonEmptyString = stringCheck('a non-empty string');

export const sha256 = scalarCheck((value, path, add) => {
  if (typeof value !== 'string' || !regExpTest(SHA256_HEX, value)) {
    add(path, `${citeName(path)} must be a lowercase sha256 hex string`);
  }
});

export const boolean = scalarCheck((value, path, add) => {
  if (typeof value !== 'boolean') add(path, `${citeName(path)} must be a boolean`);
});

export function constant(expected: string): Check {
  return scalarCheck((value, path, add) => {
    if (value !== expected) add(path, `${citeName(path)} must be "${expected}"`);
  });
}

export function oneOf(allowed: readonly string[]): Check {
  return scalarCheck((value, path, add) => {
    if (!arraySome(allowed, (item) => item === value)) {
      add(path, `${citeName(path)} must be one of ${arrayJoin(allowed, ', ')}`);
    }
  });
}

/**
 * A free-form value: JSON, at most `MAX_JSON_DEPTH` levels deep, without `undefined`; a
 * problem is reported at the path of the bad value. A value that cannot be read (a getter, a
 * Proxy trap) is reported at `path` with `unreadableMessage`.
 */
export const json: Check = (value, path, add) => {
  try {
    return toJsonValue(value, path);
  } catch (error) {
    if (isOwnError(error)) add(specErrorPath(error) ?? path, describeError(error));
    else add(path, unreadableMessage(path, error));
    return undefined;
  }
};

/**
 * A part of the format read as JSON before its own checks (an output's declaration members): an
 * `undefined` member of its objects is absent; a problem of its JSON form is reported at its
 * path, while a value that cannot be read stops the whole proof (`proof could not be read`).
 */
export const document: Check = (value, path, add) => {
  try {
    // Guarded: a getter or a trap that throws is named with the pointer of the value read.
    return toJsonDocument(value, path, () => false, true);
  } catch (error) {
    if (!isOwnError(error)) throw error;
    add(specErrorPath(error) ?? path, describeError(error));
    return undefined;
  }
};

/** A list of items; with `nonEmpty`, an empty list is refused with that reason. */
export function listOf(item: Check, nonEmpty?: string): Check {
  return (value, path, add) => {
    if (!arrayIsArray(value)) {
      add(path, `${citeName(path)} must be a list`);
      return undefined;
    }
    const items = readList(value, path);
    if (!arrayIsArray(items)) {
      add(items.path, items.message);
      return undefined;
    }
    if (nonEmpty !== undefined && items.length === 0) {
      add(path, `${citeName(path)} must not be empty: ${nonEmpty}`);
    }
    return arrayMap(items, (v, i) => item(v, `${path}[${i}]`, add));
  };
}

/**
 * The own members of the plain object `value`, each read once after all are counted
 * (`spendValues`); `undefined` after reporting that there are too many to read.
 */
function readMembers(
  value: Record<string, unknown>,
  path: string,
  add: Add,
): Map<string, unknown> | undefined {
  let keys: string[];
  try {
    keys = objectKeys(value);
  } catch (error) {
    // A trap that throws is named with the pointer of the object being read.
    add(path, unreadableMessage(path || 'proof', error));
    return undefined;
  }
  if (!spendValues(keys.length)) {
    add(path, tooLargeMessage(path || 'proof'));
    return undefined;
  }
  const members = new NativeMap<string, unknown>();
  for (const key of keys) {
    try {
      mapSet(members, key, value[key]);
    } catch (error) {
      // A getter that throws is named with its own pointer.
      const at = path ? `${path}.${key}` : key;
      add(at, unreadableMessage(at, error));
      return undefined;
    }
  }
  return members;
}

/**
 * An object of named entries: names must be non-empty (and pass `name`), an `undefined` entry
 * is absent; with `nonEmpty`, an object without entry is refused with that reason.
 */
export function mapOf(
  item: Check,
  summary: string,
  options: { name?: (name: string, path: string) => string | undefined; nonEmpty?: string } = {},
): Check {
  return (value, path, add) => {
    if (!isPlainObject(value)) {
      add(path, `${citeName(path)} must be an object of ${summary}`);
      return undefined;
    }
    const members = readMembers(value, path, add);
    if (members === undefined) return undefined;
    const copy: Record<string, unknown> = {};
    let count = 0;
    for (const [name, entry] of members) {
      if (entry === undefined) continue;
      count++;
      const at = `${path}.${name}`;
      const problem =
        name === '' ? `${citeName(path)} has an empty name` : options.name?.(name, at);
      if (problem !== undefined) add(name === '' ? path : at, problem);
      // Plain assignment would turn a `__proto__` key into a prototype change.
      else defineMember(copy, name, item(entry, at, add));
    }
    if (count === 0 && options.nonEmpty !== undefined) {
      add(path, `${citeName(path)} must not be empty: ${options.nonEmpty}`);
    }
    return copy;
  };
}

function defineMember(target: Record<string, unknown>, key: string, value: unknown): void {
  objectDefineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** The fields of each shape in order, listed once: a proof checks thousands of objects. */
const FIELDS = new NativeWeakMap<Shape, readonly (readonly [string, Check])[]>();

function fieldsOf(shape: Shape): readonly (readonly [string, Check])[] {
  let fields = weakMapGet(FIELDS, shape);
  if (fields === undefined) {
    fields = objectEntries(shape.fields);
    weakMapSet(FIELDS, shape, fields);
  }
  return fields;
}

export function objectOf(shape: Shape): Check {
  return (value, path, add) => checkObject(value, path, shape, add, new NativeSet())?.copy;
}

/**
 * Checks a closed object. A member whose value is `undefined` is absent, known or not (the
 * TypeScript idiom of an optional field, as in the canonical form). Unknown keys are reported
 * first, then each field in order; keys in `ignored` are skipped.
 * Each own property is read once, after all are counted (`spendValues`), so an accessor cannot
 * answer two checks differently. Returns the copies of the fields checked (known, not
 * `undefined`; `ignored` keys are left out) and their checks' copies, or `undefined` when
 * `value` is not an object, has too many members, or the shape's gate stopped.
 */
export function checkObject(
  value: unknown,
  path: string,
  given: Shape,
  add: Add,
  ignored: ReadonlySet<string>,
  reserve?: (members: ReadonlyMap<string, unknown>) => number,
): { members: ReadonlyMap<string, unknown>; copy: Record<string, unknown> } | undefined {
  if (!isPlainObject(value)) {
    add(path, `${citeName(path)} must be an object ${given.summary}`);
    return undefined;
  }
  const members = readMembers(value, path, add);
  if (members === undefined) return undefined;
  if (reserve !== undefined && !spendValues(reserve(members))) {
    add(path, tooLargeMessage(path || 'proof'));
    return undefined;
  }
  let shape = given;
  const gated = shape.gate?.(members, path);
  if (gated !== undefined && 'message' in gated) {
    add(gated.path, gated.message);
    return undefined;
  }
  if (gated !== undefined) shape = gated;
  const at = (key: string): string => (path ? `${path}.${key}` : key);
  for (const [key, member] of members) {
    // A member whose value is `undefined` is absent, known or not.
    if (member === undefined || setHas(ignored, key) || objectHasOwn(shape.fields, key)) continue;
    add(at(key), `${citeName(path || 'proof')} has an unknown key ${quoteText(key)}`);
  }
  const copy: Record<string, unknown> = {};
  let failed = false;
  const fieldAdd: Add = (where, message) => {
    failed = true;
    add(where, message);
  };
  for (const [key, check] of fieldsOf(shape)) {
    const field = mapGet(members, key);
    if (field !== undefined) copy[key] = check(field, at(key), fieldAdd);
    else if (!(shape.optional !== undefined && arrayIncludes(shape.optional, key)))
      fieldAdd(at(key), `${citeName(at(key))} is required`);
  }
  if (!failed) shape.refine?.(copy, path, add);
  return { members, copy };
}
