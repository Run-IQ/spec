import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalSha256Hex, isCanonicalText } from '../src/canonical.js';
import { canonicalize, sha256Hex } from '../src/index.js';
import type { JsonValue } from '../src/index.js';
import { HashStream, STREAM_BUFFER_BYTES, writeJsonString } from '../src/stream.js';
import { canonical, hex, nodeSha256, specError } from './helpers.js';

/** The texts a stream must encode as `TextEncoder` does, piece boundaries included. */
const PIECE = 16_384;
const HIGH = String.fromCharCode(0xd83d);
const LOW = String.fromCharCode(0xde00);
const TEXTS = [
  '',
  'abc',
  '\u0000\u007f\u0080߿ࠀ￿',
  'é"\\\u{1F600}~/',
  '\u{10000}\u{10FFFF}',
  `a${String.fromCharCode(0xd800)}b`,
  `${String.fromCharCode(0xdc00)}${String.fromCharCode(0xd800)}`,
  // A surrogate pair across each boundary of the encoder's pieces and of the buffer.
  `${'a'.repeat(PIECE - 1)}${HIGH}${LOW}b`,
  `${'a'.repeat(PIECE)}${HIGH}${LOW}`,
  `${'é'.repeat(PIECE * 2 - 1)}${HIGH}${LOW}${'€'.repeat(PIECE)}`,
  '\u{1F600}'.repeat(PIECE * 3),
  'x'.repeat(STREAM_BUFFER_BYTES * 3 + 7),
];

/** The sha256 of `parts` by a fresh `HashStream`, texts and bytes in order. */
function streamed(stream: HashStream, parts: readonly (string | Uint8Array)[]): string {
  stream.start();
  for (const part of parts) {
    if (typeof part === 'string') stream.text(part);
    else stream.bytes(part);
  }
  const out = new Uint8Array(32);
  stream.digestInto(out);
  return hex(out);
}

describe('HashStream (M1: TextEncoder.encodeInto into one 64 KiB buffer)', () => {
  it('hashes each text as node:crypto hashes its UTF-8 (TextEncoder) bytes', () => {
    const stream = HashStream.sha256();
    const encoder = new TextEncoder();
    for (const text of TEXTS) {
      const expected = hex(nodeSha256(encoder.encode(text)));
      expect([text.length, streamed(stream, [text])]).toEqual([text.length, expected]);
      expect([text.length, sha256Hex(text.replace(/[\ud800-\udfff]/g, 'x'))]).toEqual([
        text.length,
        hex(nodeSha256(encoder.encode(text.replace(/[\ud800-\udfff]/g, 'x')))),
      ]);
    }
  });

  it('hashes texts and bytes mixed, small and large, in order, and starts afresh each time', () => {
    const stream = HashStream.sha256();
    const big = new Uint8Array(STREAM_BUFFER_BYTES * 2 + 3).fill(7);
    const parts: (string | Uint8Array)[] = [];
    for (let i = 0; i < 3_000; i++) parts.push(`k${i}`, Uint8Array.of(i % 256));
    parts.push(big, 'tail', TEXTS[9] ?? '', Uint8Array.of(1, 2));
    const encoder = new TextEncoder();
    const bytes = parts.map((part) => (typeof part === 'string' ? encoder.encode(part) : part));
    const expected = hex(nodeSha256(...bytes));
    expect(streamed(stream, parts)).toBe(expected);
    expect(streamed(stream, parts)).toBe(expected);
    expect(streamed(stream, ['abc'])).toBe(hex(nodeSha256('abc')));
  });

  it('computes HMAC-SHA256 under its key', () => {
    const key = new Uint8Array(32).fill(9);
    const stream = HashStream.hmacSha256(key);
    for (const text of [...TEXTS.slice(0, 5), TEXTS[8] ?? '']) {
      const expected = createHmac('sha256', key).update(new TextEncoder().encode(`input:${text}`));
      expect(streamed(stream, ['input:', text])).toBe(expected.digest('hex'));
    }
  });
});

describe('writeJsonString', () => {
  it('writes JSON.stringify(text), slice by slice, never splitting a surrogate pair', () => {
    const escapes = '"\\\u0000\u001f \b\n';
    const texts = [
      ...TEXTS,
      escapes.repeat(PIECE),
      `${'a'.repeat(PIECE - 1)}${String.fromCharCode(0xd800)}x`,
      `${'a'.repeat(PIECE - 1)}${HIGH}`,
    ];
    for (const text of texts) {
      const pieces: string[] = [];
      writeJsonString({ text: (piece) => pieces.push(piece) }, text);
      expect([text.length, pieces.join('')]).toEqual([text.length, JSON.stringify(text)]);
      if (text.length > PIECE)
        expect(Math.max(...pieces.map((p) => p.length))).toBeLessThan(PIECE * 7);
    }
  });
});

/** A seeded generator: the same values on every run. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

const CHARS = ['a', '~', '/', 'é', '\u{1F600}', '"', '\\', '\n', '\u0000', '€', '0', '$'];
const NUMBERS = [0, -0, 1.5, -1, 5e-324, 1e21, 1e-7, 2 ** 53 - 1, 333333333.3333333, 0.1];

/** A random JSON value: long strings land on the piece boundaries now and then. */
function randomValue(random: () => number, depth: number): JsonValue {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const text = (): string => {
    if (random() < 0.05) return `${'b'.repeat(PIECE - 1 + Math.floor(random() * 3))}${pick(CHARS)}`;
    return Array.from({ length: Math.floor(random() * 6) }, () => pick(CHARS)).join('');
  };
  const roll = random();
  if (depth > 4 || roll < 0.4) {
    return pick<JsonValue>([null, true, false, pick(NUMBERS), text()]);
  }
  if (roll < 0.7)
    return Array.from({ length: Math.floor(random() * 5) }, () => randomValue(random, depth + 1));
  const out: { [k: string]: JsonValue } = {};
  for (let i = Math.floor(random() * 5); i > 0; i--) out[text()] = randomValue(random, depth + 1);
  return out;
}

describe('the streamed canonical writers agree with canonicalize (I1)', () => {
  it('on 400 random values: same digest, same text', () => {
    const random = generator(20_261_101);
    for (let i = 0; i < 400; i++) canonical(randomValue(random, 0));
  }, 60_000);

  it('refuse what canonicalize refuses, with the same error', () => {
    const shared = { a: 1 };
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const refused: unknown[] = [
      { a: Number.NaN },
      [1, undefined],
      { s: String.fromCharCode(0xd800) },
      { [String.fromCharCode(0xdc00)]: 1 },
      cycle,
      new Map(),
      { x: [shared, shared, 1n] },
    ];
    for (const value of refused) {
      const expected = specError(() => canonicalize(value));
      expect(specError(() => canonicalSha256Hex(value))).toEqual(expected);
      expect(specError(() => isCanonicalText(value, ''))).toEqual(expected);
    }
  });
});
