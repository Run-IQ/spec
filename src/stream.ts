import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  NativeUint8Array,
  jsonStringify,
  mathMin,
  stringCharCodeAt,
  stringSlice,
  uint8ArrayLength,
  uint8ArraySet,
  uint8ArraySubarray,
} from './intrinsics.js';

/**
 * Internal to `@run-iq/spec`: hashing a text without ever building it whole. Every digest of
 * this package (canonical JSON, input leaves, salts) writes its text piece by piece into a
 * `HashStream`, which encodes it to UTF-8 (`TextEncoder.encodeInto`) into one fixed buffer of
 * `STREAM_BUFFER_BYTES` and hashes that buffer each time it fills: the memory a digest needs does
 * not follow the length of what it hashes, and no text is ever longer than its longest piece.
 */

/** The bytes a `HashStream` buffers before hashing them: 64 KiB. */
export const STREAM_BUFFER_BYTES = 65_536;
/**
 * The UTF-16 code units encoded at once: at most 3 bytes each (a surrogate pair gives 4 bytes
 * for 2 units), so a piece always fits in an empty buffer.
 */
const TEXT_PIECE = 16_384;
/** Short texts are joined (a rope, no copy) up to this length before they are encoded. */
const PENDING_UNITS = 4_096;

const encoder = new TextEncoder();

/**
 * Internal: the hash work this package has done since it was loaded: `calls`, the sha256 and
 * HMAC computations, and `bytes`, the bytes given to them (an HMAC's fixed key blocks aside).
 * Tests bound a digest's work by its difference across a call, never by a clock.
 */
export const hashWork = { calls: 0, bytes: 0 };

/** Internal, for tests: a copy of `hashWork` as it stands. */
export function hashWorkDone(): { calls: number; bytes: number } {
  return { ...hashWork };
}

/** Where text is written, piece by piece, in order. */
export interface TextOut {
  text(piece: string): void;
}

/** A hash of noble (sha256 or HMAC-SHA256): what a `HashStream` drives. */
interface NobleHash<T> {
  update(bytes: Uint8Array): unknown;
  digestInto(out: Uint8Array): void;
  _cloneInto(to?: T): T;
}

/**
 * Internal: one hash computation after another, each started by `start` and ended by
 * `digestInto`, fed bytes and texts (UTF-8) in between through one fixed buffer.
 */
export class HashStream implements TextOut {
  private readonly buffer = new NativeUint8Array(STREAM_BUFFER_BYTES);
  private used = 0;
  private pending = '';
  private readonly reset: () => void;
  private readonly update: (bytes: Uint8Array) => void;
  private readonly finish: (out: Uint8Array) => void;

  private constructor(fresh: NobleHash<unknown>, work: NobleHash<unknown>) {
    this.reset = () => {
      fresh._cloneInto(work);
    };
    this.update = (bytes) => {
      work.update(bytes);
    };
    this.finish = (out) => {
      work.digestInto(out);
    };
  }

  /** A stream of sha256. */
  static sha256(): HashStream {
    const fresh = sha256.create();
    return new HashStream(fresh, fresh.clone());
  }

  /** A stream of HMAC-SHA256 under `key`: the keyed state is built once, cloned each time. */
  static hmacSha256(key: Uint8Array): HashStream {
    const fresh = hmac.create(sha256, key);
    return new HashStream(fresh, fresh.clone());
  }

  /** Starts a new hash computation; what was written since the last digest is dropped. */
  start(): this {
    this.reset();
    this.used = 0;
    this.pending = '';
    return this;
  }

  /** Writes `bytes`. */
  bytes(bytes: Uint8Array): void {
    this.encodePending();
    if (uint8ArrayLength(bytes) > STREAM_BUFFER_BYTES - this.used) {
      this.flush();
      if (uint8ArrayLength(bytes) >= STREAM_BUFFER_BYTES) {
        hashWork.bytes += uint8ArrayLength(bytes);
        this.update(bytes);
        return;
      }
    }
    uint8ArraySet(this.buffer, bytes, this.used);
    this.used += uint8ArrayLength(bytes);
  }

  /**
   * Writes `piece` in UTF-8, as `TextEncoder` encodes it (a lone surrogate as U+FFFD: the texts
   * this package hashes never hold one, its validators refuse them first).
   */
  text(piece: string): void {
    if (piece.length <= PENDING_UNITS - this.pending.length) {
      this.pending += piece;
      return;
    }
    this.encodePending();
    if (piece.length <= PENDING_UNITS) this.pending = piece;
    else this.encode(piece);
  }

  /** Ends the computation: its 32 bytes go into `out`. */
  digestInto(out: Uint8Array): void {
    this.encodePending();
    this.flush();
    hashWork.calls += 1;
    this.finish(out);
  }

  private encodePending(): void {
    if (this.pending === '') return;
    const text = this.pending;
    this.pending = '';
    this.encode(text);
  }

  /** Encodes `text` piece by piece, never splitting a surrogate pair between two pieces. */
  private encode(text: string): void {
    let at = 0;
    while (at < text.length) {
      let end = mathMin(text.length, at + TEXT_PIECE);
      const last = stringCharCodeAt(text, end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      if (STREAM_BUFFER_BYTES - this.used < (end - at) * 3) this.flush();
      const piece = at === 0 && end === text.length ? text : stringSlice(text, at, end);
      this.used += encoder.encodeInto(piece, uint8ArraySubarray(this.buffer, this.used)).written;
      at = end;
    }
  }

  private flush(): void {
    if (this.used === 0) return;
    hashWork.bytes += this.used;
    this.update(uint8ArraySubarray(this.buffer, 0, this.used));
    this.used = 0;
  }
}

/**
 * Internal: writes `text` as `JSON.stringify(text)` writes it, in pieces: a long text is escaped
 * slice by slice (never splitting a surrogate pair), so no escaped copy of it is ever built
 * whole. Escaping is per code point, so the pieces join to exactly `JSON.stringify(text)`.
 */
export function writeJsonString(out: TextOut, text: string): void {
  if (text.length <= TEXT_PIECE) {
    out.text(jsonStringify(text));
    return;
  }
  out.text('"');
  let at = 0;
  while (at < text.length) {
    let end = mathMin(text.length, at + TEXT_PIECE);
    const last = stringCharCodeAt(text, end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.text(stringSlice(jsonStringify(stringSlice(text, at, end)), 1, -1));
    at = end;
  }
  out.text('"');
}

/** The idle sha256 stream `withSha256` lends, when none is in use. */
let idleSha256: HashStream | undefined;

/**
 * Internal: `use(stream)` with a started sha256 stream, then its digest (32 bytes). One stream
 * (its 64 KiB buffer) serves every call in turn; a call made while it is lent (from a caller's
 * getter, say) gets a fresh one, so calls never share a computation.
 */
export function withSha256(use: (stream: HashStream) => void): Uint8Array {
  const stream = idleSha256 ?? HashStream.sha256();
  idleSha256 = undefined;
  try {
    use(stream.start());
    const out = new NativeUint8Array(32);
    stream.digestInto(out);
    return out;
  } finally {
    idleSha256 = stream;
  }
}
