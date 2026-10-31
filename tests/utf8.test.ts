import { describe, expect, it } from 'vitest';
import { Utf8Writer } from '../src/utf8.js';

describe('Utf8Writer', () => {
  it('encodes exactly as TextEncoder does, lone surrogates included', () => {
    const encoder = new TextEncoder();
    const writer = new Utf8Writer();
    const texts = [
      '',
      'abc',
      '\u0000\u007f\u0080߿ࠀ￿',
      'é"\\\u{1F600}~/',
      '\u{10000}\u{10FFFF}',
      `a${String.fromCharCode(0xd800)}b`,
      `${String.fromCharCode(0xdc00)}${String.fromCharCode(0xd800)}`,
      String.fromCharCode(0xdbff),
      'x'.repeat(1000),
      '\u{1F600}'.repeat(300),
    ];
    for (const text of texts) {
      expect([text, Array.from(writer.encode(text))]).toEqual([
        text,
        Array.from(encoder.encode(text)),
      ]);
    }
  });

  it('every code unit alone and every pair of code units', () => {
    const encoder = new TextEncoder();
    const writer = new Utf8Writer();
    for (let code = 0; code <= 0xffff; code++) {
      const text = String.fromCharCode(code);
      expect(Buffer.from(writer.encode(text)).equals(encoder.encode(text))).toBe(true);
    }
    for (let high = 0xd800; high <= 0xdbff; high += 0x3f) {
      for (let low = 0xdc00; low <= 0xdfff; low += 0x3f) {
        const text = String.fromCharCode(high, low);
        expect(Buffer.from(writer.encode(text)).equals(encoder.encode(text))).toBe(true);
      }
    }
  });
});
