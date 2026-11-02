import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { writeCanonical } from '../canonical.js';
import { citeName, newSpecError } from '../errors.js';
import { PackedHashes, rootFromPath, sizedDigest } from '../merkle.js';
import { hashWork, withSha256 } from '../stream.js';
import { withValueBudget } from '../values.js';
import { isProofFormat, PROOF_FORMATS } from './formats.js';
import { PROOF_SECTIONS } from './types.js';
import type { DecisionProof, Redacted, UnsignedProof } from './types.js';
import { readProofContent, readProofLeaf } from './validate.js';
import type { ProofLeaf } from './validate.js';

export type { ProofLeaf } from './validate.js';

// Internal to `@run-iq/spec`: the leaves of a proof and its digest (D-16), all encoded by
// `hashLeafInto` and `sizedDigest` under the proof's own format. A short leaf is written as one
// text and hashed at once; a longer one is hashed as it is written (`withSha256`,
// `writeCanonical`): no long canonical text is ever built.

/** A digest as `sealProof` writes it. */
const DIGEST_HEX = /^[0-9a-f]{64}$/;

/** The keys that are not in the header leaf: the ten sections, `digest` and `signature`. */
const NOT_HEADER: ReadonlySet<string> = new Set([...PROOF_SECTIONS, 'digest', 'signature']);

/** The start of every leaf of a proof of `format`: `0x00 ‖ utf8(format) ‖ 0x00`, built once. */
function leafPrefix(format: string): Uint8Array {
  let prefix = LEAF_PREFIXES.get(format);
  if (prefix === undefined) {
    prefix = Uint8Array.from([0, ...utf8ToBytes(format), 0]);
    LEAF_PREFIXES.set(format, prefix);
  }
  return prefix;
}

const LEAF_PREFIXES = new Map<string, Uint8Array>();

/** True when `entry`, an entry of a validated snapshot, is redacted. */
export function isRedacted(entry: object): entry is Redacted {
  return (entry as Partial<Redacted>).redacted !== undefined;
}

/** Internal: the header of `p` (a snapshot): every member but the sections, digest, signature. */
export function headerOf(p: object): Record<string, unknown> {
  const header: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(p)) {
    if (!NOT_HEADER.has(key)) header[key] = value;
  }
  return header;
}

/**
 * Writes into `out` the hash of the leaf `{ s, i?, e }` of a proof of `format` (D-16):
 * `sha256(0x00 ‖ utf8(format) ‖ 0x00 ‖ utf8(canonicalize(leaf)))`. The keys of the leaf are
 * written in canonical order (`e`, `i`, `s`; `s` is `header` or a section name, which need no
 * escape), `e` as `canonicalize` writes it: from its short text (`shortText`) when it has one,
 * else streamed (`writeCanonical`), so that no long text is ever built.
 */
function hashLeafInto(
  out: Uint8Array,
  format: string,
  s: string,
  i: number | undefined,
  e: unknown,
): void {
  const text = shortText(e, SHORT_DEPTH);
  if (text !== undefined) {
    const leaf = `{"e":${text}${i === undefined ? '' : `,"i":${i}`},"s":"${s}"}`;
    hashShortInto(out, leafPrefix(format), leaf);
    return;
  }
  out.set(
    withSha256((stream) => {
      stream.bytes(leafPrefix(format));
      stream.text('{"e":');
      writeCanonical(stream, e);
      if (i !== undefined) stream.text(`,"i":${i}`);
      stream.text(`,"s":"${s}"}`);
    }),
  );
}

/** The nesting `shortText` writes: an entry, its lists and objects, and theirs. */
const SHORT_DEPTH = 3;

/** The longest text `shortText` builds, in UTF-16 code units: past it, a leaf is streamed. */
const SHORT_UNITS = 4_096;

/**
 * The canonical text of `value`, a member of a plain-JSON snapshot (finite numbers, well-formed
 * strings, plain objects and arrays), when it is short: at most `SHORT_UNITS` code units and
 * `depth` levels of objects and arrays; else `undefined`. It is the text `canonicalize` writes
 * (RFC 8785): keys sorted by UTF-16 code units (the order of `Array.prototype.sort`), strings as
 * `JSON.stringify` writes them, numbers as `String` writes them.
 */
function shortText(value: unknown, depth: number): string | undefined {
  let text: string;
  if (typeof value === 'string') {
    if (value.length > SHORT_UNITS) return undefined;
    text = quoted(value);
  } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    text = String(value);
  } else if (depth === 0 || typeof value !== 'object') {
    return undefined;
  } else if (Array.isArray(value)) {
    text = '[';
    for (let k = 0; k < value.length; k++) {
      const member = shortText(value[k], depth - 1);
      if (member === undefined) return undefined;
      text += k === 0 ? member : `,${member}`;
      if (text.length > SHORT_UNITS) return undefined;
    }
    text += ']';
  } else {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    text = '{';
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k] as string;
      const member = shortText(record[key], depth - 1);
      if (member === undefined || key.length > SHORT_UNITS) return undefined;
      text += `${k === 0 ? '' : ','}${quoted(key)}:${member}`;
      if (text.length > SHORT_UNITS) return undefined;
    }
    text += '}';
  }
  return text.length > SHORT_UNITS ? undefined : text;
}

/** `text` as `JSON.stringify` writes it: as it is between quotes when nothing needs escaping. */
function quoted(text: string): string {
  return NEEDS_ESCAPE.test(text) ? JSON.stringify(text) : `"${text}"`;
}

/** What `JSON.stringify` escapes in a well-formed string: a quote, a backslash, a control. */
// eslint-disable-next-line no-control-regex
const NEEDS_ESCAPE = /["\\\u0000-\u001f]/;

/** The sha256 states and the buffer `hashShortInto` reuses (it never calls out). */
const SHORT_FRESH = sha256.create();
const SHORT_WORK = SHORT_FRESH.clone();
let shortBuffer = new Uint8Array(1_024);

/** Writes into `out` `sha256(prefix ‖ utf8(text))`, `text` short: encoded once, hashed once. */
function hashShortInto(out: Uint8Array, prefix: Uint8Array, text: string): void {
  const room = prefix.length + 3 * text.length;
  if (room > shortBuffer.length) shortBuffer = new Uint8Array(room);
  shortBuffer.set(prefix);
  const { written } = SHORT_ENCODER.encodeInto(text, shortBuffer.subarray(prefix.length));
  const bytes = prefix.length + written;
  SHORT_FRESH._cloneInto(SHORT_WORK);
  SHORT_WORK.update(shortBuffer.subarray(0, bytes));
  SHORT_WORK.digestInto(out);
  hashWork.calls += 1;
  hashWork.bytes += bytes;
}

const SHORT_ENCODER = new TextEncoder();

/**
 * Internal: the leaf hashes of `p`, a plain-JSON snapshot of a proof `validateProof` accepts (its
 * `digest` and `signature` ignored), in order: the header, then each entry of each section in
 * the order of `PROOF_SECTIONS`, a redacted entry giving its hash as it is. Packed: no array per
 * hash.
 */
export function packedLeafHashes(p: UnsignedProof): PackedHashes {
  const record = p as unknown as Record<string, readonly object[]>;
  let count = 1;
  for (const section of PROOF_SECTIONS) count += record[section]?.length ?? 0;
  const hashes = new PackedHashes(count);
  hashLeafInto(hashes.next(), p.format, 'header', undefined, headerOf(p));
  hashes.push();
  for (const section of PROOF_SECTIONS) {
    (record[section] ?? []).forEach((entry, i) => {
      const out = hashes.next();
      if (isRedacted(entry)) out.set(hexToBytes(entry.redacted));
      else hashLeafInto(out, p.format, section, i, entry);
      hashes.push();
    });
  }
  return hashes;
}

/**
 * Internal: the digest of `p`, a plain-JSON snapshot of a proof `validateProof` accepts (D-16):
 * `sha256(0x02 ‖ utf8(format) ‖ 0x00 ‖ uint64be(n) ‖ root)`, `root` the RFC 6962 root of its
 * `n` leaves (`packedLeafHashes`), in lowercase hex.
 */
export function treeDigest(p: UnsignedProof): string {
  const hashes = packedLeafHashes(p);
  return bytesToHex(sizedDigest(p.format, hashes.length, hashes.root()));
}

/**
 * The leaf hashes of a proof (D-16), 32 bytes each, in the order of its tree: first its header
 * (`sha256(0x00 ‖ T ‖ utf8(canonicalize({ s: 'header', e: H })))`, `H` the proof without
 * `digest`, `signature` and the ten sections), then, section by section in the order of
 * `PROOF_SECTIONS`, one leaf per entry (`sha256(0x00 ‖ T ‖ utf8(canonicalize({ s: section, i:
 * index, e: entry })))`, `index` its place in its section, its `salt` inside `entry`), where
 * `T = utf8(format) ‖ 0x00`. A redacted entry gives its hash as it is. The digest of the proof
 * commits to these leaves and their number: `sha256(0x02 ‖ T ‖ uint64be(n) ‖ root)`, `root`
 * their RFC 6962 root (`merkleRoot`).
 *
 * `p` is read once and checked as `validateProof` checks it (`digest` and `signature`, when
 * present, are ignored); its consistency is not checked. Throws `SpecError` (`INVALID_PROOF`,
 * `Cannot hash the proof: <first problem>`) when it is malformed.
 */
export function proofLeafHashes(p: DecisionProof | UnsignedProof): Uint8Array[] {
  return withValueBudget(() => {
    const { proof, errors } = readProofContent(p);
    if (!proof) throw newSpecError('INVALID_PROOF', `Cannot hash the proof: ${errors[0]}`);
    const hashes = packedLeafHashes(proof);
    return Array.from({ length: hashes.length }, (_, i) => hashes.copyAt(i));
  });
}

/**
 * The hash of one leaf of a proof (D-16), 32 bytes, as `proofLeafHashes` gives it: `leaf` is
 * the header (`{ s: 'header', e: header }`, `header` the proof without `digest`, `signature`
 * and the ten sections) or one entry (`{ s: section, i: index, e: entry }`, `entry` salted, or
 * redacted: its hash is then returned as it is), hashed under `format`, the format of the proof
 * it comes from (D-16: the domain tag is the proof's format). `format` must be one of
 * `PROOF_FORMATS`, and a header's own `format` must be `format`.
 *
 * With `verifyProofInclusion`, a verifier checks the header and some entries of a proof against
 * its signed digest without reading the other leaves: each leaf, its audit path
 * (`inclusionPath(proofLeafHashes(p), at)`) and the number of leaves.
 *
 * `leaf` is read once; the header is checked as `validateProof` checks one, an entry as an
 * entry of its section. Throws `SpecError` (`INVALID_PROOF`): `invalid proof leaf: <first
 * problem>` when it is malformed, `invalid proof leaf: unknown format: <format>` (or `format
 * must be one of …` for a value that is not a string) when `format` is not listed, and
 * `invalid proof leaf: the header is of format <f>, not <format>` for a header of another
 * format.
 */
export function proofLeafHash(leaf: ProofLeaf, format: string): Uint8Array {
  return withValueBudget(() => {
    const tag: unknown = format;
    if (!isProofFormat(tag)) {
      const problem =
        typeof tag === 'string'
          ? `unknown format: ${citeName(tag)}`
          : `format must be one of ${PROOF_FORMATS.join(', ')}`;
      throw newSpecError('INVALID_PROOF', `invalid proof leaf: ${problem}`);
    }
    const { leaf: read, errors } = readProofLeaf(leaf);
    if (read === undefined) {
      throw newSpecError('INVALID_PROOF', `invalid proof leaf: ${errors[0] ?? 'unreadable'}`);
    }
    const out = new Uint8Array(32);
    if (read.s === 'header') {
      const own = String(read.e.format);
      if (own !== format) {
        const message = `invalid proof leaf: the header is of format ${own}, not ${format}`;
        throw newSpecError('INVALID_PROOF', message);
      }
      hashLeafInto(out, format, 'header', undefined, read.e);
    } else if (isRedacted(read.e)) {
      out.set(hexToBytes(read.e.redacted));
    } else {
      hashLeafInto(out, format, read.s, read.i, read.e);
    }
    return out;
  });
}

/**
 * True when `path` proves that `leafHash` (`proofLeafHash`) is the leaf at `index` of the tree
 * of `size` leaves of a proof of format `format` whose digest is `digest` (D-16): the RFC 6962
 * root rebuilt from the leaf and its audit path (`inclusionPath`), committed with `size`, gives
 * `digest`. The digest commits to the number of leaves, so a leaf cannot be shown under another
 * size. The header is leaf 0; the entries follow, section by section.
 *
 * Never throws: false for anything else, in particular a `format` not listed in
 * `PROOF_FORMATS`, a `digest` that is not 64 lowercase hex characters, and every case where
 * `verifyInclusion` is false (`size` not an integer from 1 to 2^53 - 1, `index` not below it,
 * a hash that is not 32 bytes, a path of another length, its length checked before any element
 * is read). It reads the digest, the leaf and the ⌈log2 size⌉ hashes of the path at most: never
 * the other leaves.
 */
export function verifyProofInclusion(
  digest: string,
  size: number,
  index: number,
  leafHash: Uint8Array,
  path: readonly Uint8Array[],
  format: string,
): boolean {
  const tag: unknown = format;
  if (!isProofFormat(tag)) return false;
  const expected: unknown = digest;
  if (typeof expected !== 'string' || !DIGEST_HEX.test(expected)) return false;
  const root = rootFromPath(leafHash, index, size, path);
  return root !== undefined && bytesToHex(sizedDigest(format, size, root)) === expected;
}
