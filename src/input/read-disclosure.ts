import { citeName, reasonOf, unreadableMessage } from '../errors.js';
import { auditPathLength } from '../merkle.js';
import { parsePointer } from '../path/pointer.js';
import { MAX_JSON_VALUES } from '../values.js';
import { DISCLOSURE_FORMAT } from './disclosure.js';
import {
  announce,
  expectPlainObject,
  readElement,
  readFields,
  readMember,
  requireFields,
} from './read.js';
import type { Reader } from './read.js';
import type { InputLeaf } from './tree.js';

/**
 * Internal to `@run-iq/spec`: the read-once copy of a fact disclosure (`run-iq.disclosure/1`)
 * that `verifyFactDisclosure` (src/input/verify-disclosure.ts) checks. The caller's value is
 * read once, each property read and counted once, into plain copies holding primitives only;
 * every problem of shape is listed, and nothing below is a check of the tree.
 */

/** A digest as `computeInputDigest` writes it, a salt, a commitment, a hash of an audit path. */
export const HEX_HASH = /^[0-9a-f]{64}$/;
/** The longest audit path of a tree an input can have: `MAX_JSON_VALUES` leaves. */
const MAX_AUDIT_PATH = auditPathLength(0, MAX_JSON_VALUES);

/** A shown leaf as read: its leaf (plain primitives only), index, path, and where it is. */
export interface LeafCopy {
  readonly at: string;
  readonly leaf: InputLeaf;
  readonly index: number;
  readonly path: string[];
}

/** A neighbour as read: a leaf without its content. */
export interface NeighbourCopy {
  readonly at: string;
  readonly pointer: string;
  readonly salt: string;
  readonly commitment: string;
  readonly index: number;
  readonly path: string[];
}

/** A fact as read. */
export interface FactCopy {
  readonly at: string;
  readonly pointer: string;
  readonly segments: string[];
  readonly leaves: LeafCopy[];
  readonly before?: NeighbourCopy;
  readonly after?: NeighbourCopy;
}

/** An absence as read. */
export interface AbsenceCopy {
  readonly at: string;
  readonly pointer: string;
  readonly segments: string[];
  readonly before?: NeighbourCopy;
  readonly after?: NeighbourCopy;
}

/** A disclosure as read: every field checked for its shape. */
export interface DisclosureCopy {
  readonly inputDigest: string;
  readonly size: number;
  readonly facts: FactCopy[];
  readonly absent: AbsenceCopy[];
}

const DISCLOSURE_KEYS: readonly string[] = ['format', 'inputDigest', 'size', 'facts', 'absent'];
const FACT_KEYS: readonly string[] = ['pointer', 'leaves', 'before', 'after'];
const LEAF_KEYS: readonly string[] = [
  'pointer',
  'kind',
  'value',
  'length',
  'salt',
  'valueSalt',
  'index',
  'path',
];
const NEIGHBOUR_KEYS: readonly string[] = ['pointer', 'salt', 'commitment', 'index', 'path'];
const ABSENCE_KEYS: readonly string[] = ['pointer', 'before', 'after'];

/**
 * Reads the caller's disclosure once into a copy, listing every problem of shape; the format
 * cited when it is a text other than `run-iq.disclosure/1`.
 */
export function readDisclosure(
  value: unknown,
  reader: Reader,
): DisclosureCopy | string | undefined {
  const { add } = reader;
  const shape = 'an object { format, inputDigest, size, facts, absent }';
  if (!expectPlainObject(value, '', shape, add, 'disclosure')) return undefined;
  const fields = readFields(value, '', 'disclosure', DISCLOSURE_KEYS, reader);
  if (fields === undefined) return undefined;
  requireFields(fields, '', DISCLOSURE_KEYS, add);
  const field = (key: string): unknown => fields.values.get(key);
  const format = field('format');
  if (typeof format === 'string' && format !== DISCLOSURE_FORMAT) return citeName(format);
  if (fields.values.has('format') && format !== DISCLOSURE_FORMAT) {
    add('/format', '/format must be a string');
  }
  const inputDigest = field('inputDigest');
  if (fields.values.has('inputDigest') && !isHexHash(inputDigest)) {
    add('/inputDigest', '/inputDigest must be 64 lowercase hex characters');
  }
  const rawSize = field('size');
  const size = isCount(rawSize, MAX_JSON_VALUES) ? rawSize : undefined;
  if (fields.values.has('size') && size === undefined) {
    add('/size', `/size must be an integer from 0 to ${MAX_JSON_VALUES}`);
  }
  const facts = fields.values.has('facts')
    ? readCopies('/facts', field('facts'), reader, size, 'facts', (item, at) =>
        readFactCopy(item, at, size, reader),
      )
    : undefined;
  const absent = fields.values.has('absent')
    ? readCopies('/absent', field('absent'), reader, undefined, 'absences', (item, at) =>
        readAbsenceCopy(item, at, size, reader),
      )
    : undefined;
  if (reader.issues.length > 0 || facts === undefined || absent === undefined) return undefined;
  if (!isHexHash(inputDigest) || size === undefined) return undefined;
  return { inputDigest, size, facts, absent };
}

/** True for 64 lowercase hex characters. */
function isHexHash(value: unknown): value is string {
  return typeof value === 'string' && HEX_HASH.test(value);
}

/** True for an integer from 0 to `max`. */
function isCount(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

/**
 * The copies of the elements of the caller's list at `path`, each read once by `readItem`; its
 * `length` read once and, with `max` (the size of the tree), compared to it before any element
 * is read and counted (`noun` names what it holds); `undefined` after reporting a problem with
 * the list itself.
 */
function readCopies<T>(
  path: string,
  value: unknown,
  reader: Reader,
  max: number | undefined,
  noun: string,
  readItem: (item: unknown, at: string) => T | undefined,
): T[] | undefined {
  const read = readLength(value, path, reader);
  if (read === undefined) return undefined;
  const { list, length } = read;
  if (max !== undefined && length > max) {
    reader.add(path, `${path} holds ${length} ${noun}, more than the size of the tree (${max})`);
    return undefined;
  }
  announce(reader, length, path);
  const copies: T[] = [];
  for (let i = 0; i < length; i++) {
    const element = readElement(list, i, path, reader.add);
    if (element === 'failed') continue;
    const item = readItem(element.value, `${path}/${i}`);
    if (item !== undefined) copies.push(item);
  }
  return copies;
}

/** The `length` of the caller's array at `path`, read once; reports anything else. */
function readLength(
  value: unknown,
  path: string,
  reader: Reader,
): { list: readonly unknown[]; length: number } | undefined {
  let list: readonly unknown[] | undefined;
  try {
    if (Array.isArray(value)) list = value;
  } catch (error) {
    reader.add(path, unreadableMessage(path, error));
    return undefined;
  }
  if (list === undefined) {
    reader.add(path, `${path} must be an array`);
    return undefined;
  }
  const read = readMember(list, 'length', path, reader.add);
  if (read === 'failed') return undefined;
  if (!isCount(read.value, Number.MAX_SAFE_INTEGER)) {
    reader.add(path, `${path} has an invalid length`);
    return undefined;
  }
  return { list, length: read.value };
}

/** The pointer at `at` and its segments when it is a JSON pointer; reports it otherwise. */
function readPointer(
  value: unknown,
  at: string,
  add: (path: string, message: string) => void,
): { pointer: string; segments: string[] } | undefined {
  if (typeof value !== 'string') {
    add(at, `${at} must be a string`);
    return undefined;
  }
  try {
    return { pointer: value, segments: parsePointer(value) };
  } catch (error) {
    add(at, `${at}: ${reasonOf(error)}`);
    return undefined;
  }
}

/** Copies a fact at `at`, read once. */
function readFactCopy(
  value: unknown,
  at: string,
  size: number | undefined,
  reader: Reader,
): FactCopy | undefined {
  const { add } = reader;
  const shape = 'an object { pointer, leaves, before?, after? }';
  if (!expectPlainObject(value, at, shape, add)) return undefined;
  const fields = readFields(value, at, at, FACT_KEYS, reader);
  if (fields === undefined) return undefined;
  requireFields(fields, at, ['pointer', 'leaves'], add);
  const pointer = fields.values.has('pointer')
    ? readPointer(fields.values.get('pointer'), `${at}/pointer`, add)
    : undefined;
  let leaves: LeafCopy[] | undefined;
  if (fields.values.has('leaves')) {
    const path = `${at}/leaves`;
    const read = readCopies(path, fields.values.get('leaves'), reader, size, 'leaves', (item, i) =>
      readLeafCopy(item, i, size, reader),
    );
    if (read !== undefined && read.length === 0 && reader.issues.length === 0) {
      add(path, `${path} must hold at least one leaf`);
    }
    leaves = read;
  }
  const neighbours = readNeighbours(fields.values, at, size, reader);
  if (pointer === undefined || leaves === undefined || neighbours === undefined) {
    return undefined;
  }
  return { at, ...pointer, leaves, ...neighbours };
}

/** The neighbours `before` and `after` among `values`, each read once; `undefined` if refused. */
function readNeighbours(
  values: ReadonlyMap<string, unknown>,
  at: string,
  size: number | undefined,
  reader: Reader,
): { before?: NeighbourCopy; after?: NeighbourCopy } | undefined {
  const neighbour = (key: string): NeighbourCopy | undefined | 'failed' => {
    if (!values.has(key)) return undefined;
    return readNeighbourCopy(values.get(key), `${at}/${key}`, size, reader) ?? 'failed';
  };
  const before = neighbour('before');
  const after = neighbour('after');
  if (before === 'failed' || after === 'failed') return undefined;
  return { ...(before && { before }), ...(after && { after }) };
}

/**
 * The index and the audit path of a leaf at `at` among its read `values`: the index below
 * `size`, the path of exactly the length of its audit path.
 */
function readPlace(
  values: ReadonlyMap<string, unknown>,
  at: string,
  size: number | undefined,
  reader: Reader,
): { index: number; path: string[] } | undefined {
  const rawIndex = values.get('index');
  const index = isCount(rawIndex, size === undefined ? MAX_JSON_VALUES : size - 1)
    ? rawIndex
    : undefined;
  if (values.has('index') && index === undefined) {
    reader.add(
      `${at}/index`,
      size === undefined
        ? `${at}/index must be an integer from 0`
        : `${at}/index must be an integer below the size of the tree (${size})`,
    );
  }
  const path = values.has('path')
    ? readAuditPath(values.get('path'), `${at}/path`, reader, index, size)
    : undefined;
  return path === undefined || index === undefined ? undefined : { index, path };
}

/** Copies a shown leaf at `at`, read once; its values primitives only, never a caller's. */
function readLeafCopy(
  value: unknown,
  at: string,
  size: number | undefined,
  reader: Reader,
): LeafCopy | undefined {
  const { add } = reader;
  const shape = 'an object { pointer, kind, value or length, salt, valueSalt, index, path }';
  if (!expectPlainObject(value, at, shape, add)) return undefined;
  const fields = readFields(value, at, at, LEAF_KEYS, reader);
  if (fields === undefined) return undefined;
  requireFields(fields, at, ['pointer', 'kind', 'salt', 'valueSalt', 'index', 'path'], add);
  const has = (key: string): boolean => fields.values.has(key);
  const text = (key: string): string | undefined => {
    const member = fields.values.get(key);
    if (typeof member === 'string') return member;
    if (has(key)) add(`${at}/${key}`, `${at}/${key} must be a string`);
    return undefined;
  };
  const pointer = text('pointer');
  const kind = text('kind');
  const salt = text('salt');
  const valueSalt = text('valueSalt');
  if (kind !== undefined && !isLeafKind(kind)) {
    add(`${at}/kind`, `${at}/kind must be one of value, array, object`);
  }
  const scalar = fields.values.get('value');
  if (has('value') && !isScalar(scalar)) add(`${at}/value`, `${at}/value must be a JSON scalar`);
  const length = fields.values.get('length');
  if (has('length') && typeof length !== 'number') {
    add(`${at}/length`, `${at}/length must be a number`);
  }
  const place = readPlace(fields.values, at, size, reader);
  if (reader.issues.length > 0 || place === undefined) return undefined;
  if (pointer === undefined || salt === undefined || valueSalt === undefined) return undefined;
  if (kind === undefined || !isLeafKind(kind)) return undefined;
  const leaf: InputLeaf = {
    pointer,
    kind,
    // -0 has no JSON form: a leaf holds 0 (`inputLeafHash` reads it so).
    ...(isScalar(scalar) && { value: Object.is(scalar, -0) ? 0 : scalar }),
    ...(typeof length === 'number' && { length }),
    salt,
    valueSalt,
  };
  return { at, leaf, ...place };
}

/** Copies a neighbour at `at`, read once. */
function readNeighbourCopy(
  value: unknown,
  at: string,
  size: number | undefined,
  reader: Reader,
): NeighbourCopy | undefined {
  const { add } = reader;
  const shape = 'an object { pointer, salt, commitment, index, path }';
  if (!expectPlainObject(value, at, shape, add)) return undefined;
  const fields = readFields(value, at, at, NEIGHBOUR_KEYS, reader);
  if (fields === undefined) return undefined;
  requireFields(fields, at, NEIGHBOUR_KEYS, add);
  const pointer = fields.values.get('pointer');
  if (fields.values.has('pointer') && typeof pointer !== 'string') {
    add(`${at}/pointer`, `${at}/pointer must be a string`);
  }
  const [salt, commitment] = ['salt', 'commitment'].map((key) => {
    const hex = fields.values.get(key);
    if (isHexHash(hex)) return hex;
    if (fields.values.has(key))
      add(`${at}/${key}`, `${at}/${key} must be 64 lowercase hex characters`);
    return undefined;
  });
  const place = readPlace(fields.values, at, size, reader);
  if (reader.issues.length > 0 || place === undefined || typeof pointer !== 'string') {
    return undefined;
  }
  if (salt === undefined || commitment === undefined) return undefined;
  return { at, pointer, salt, commitment, ...place };
}

/** True for a kind of leaf (D-15). */
function isLeafKind(kind: string): kind is InputLeaf['kind'] {
  return kind === 'value' || kind === 'array' || kind === 'object';
}

/** True for a JSON scalar: what a leaf of kind `value` holds (checked further by its hash). */
function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * The hashes of an audit path at `at`: exactly `auditPathLength(index, size)` of them (at most
 * `MAX_AUDIT_PATH` when the place is unknown), the length compared before any is read.
 */
function readAuditPath(
  value: unknown,
  at: string,
  reader: Reader,
  index: number | undefined,
  size: number | undefined,
): string[] | undefined {
  const read = readLength(value, at, reader);
  if (read === undefined) return undefined;
  const { list, length } = read;
  if (index !== undefined && size !== undefined) {
    const expected = auditPathLength(index, size);
    if (length !== expected) {
      const hashes = expected === 1 ? 'hash' : 'hashes';
      reader.add(
        at,
        `${at} must hold ${expected} ${hashes} (the audit path of leaf ${index} of ${size})`,
      );
      return undefined;
    }
  } else if (length > MAX_AUDIT_PATH) {
    reader.add(at, `${at} must hold at most ${MAX_AUDIT_PATH} hashes`);
    return undefined;
  }
  announce(reader, length, at);
  const hashes: string[] = [];
  for (let i = 0; i < length; i++) {
    const element = readElement(list, i, at, reader.add);
    if (element === 'failed') continue;
    if (isHexHash(element.value)) hashes.push(element.value);
    else reader.add(`${at}/${i}`, `${at}/${i} must be 64 lowercase hex characters`);
  }
  return hashes;
}

/** Copies an absence at `at`, read once. */
function readAbsenceCopy(
  value: unknown,
  at: string,
  size: number | undefined,
  reader: Reader,
): AbsenceCopy | undefined {
  const { add } = reader;
  if (!expectPlainObject(value, at, 'an object { pointer, before?, after? }', add)) {
    return undefined;
  }
  const fields = readFields(value, at, at, ABSENCE_KEYS, reader);
  if (fields === undefined) return undefined;
  requireFields(fields, at, ['pointer'], add);
  const pointer = fields.values.has('pointer')
    ? readPointer(fields.values.get('pointer'), `${at}/pointer`, add)
    : undefined;
  const neighbours = readNeighbours(fields.values, at, size, reader);
  if (pointer === undefined || neighbours === undefined) return undefined;
  return { at, ...pointer, ...neighbours };
}
