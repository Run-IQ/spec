import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/hash.js';
import * as main from '../src/index.js';

const reference = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('hashes the empty string to the well-known digest', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes "abc" to the FIPS 180-2 test vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes the UTF-8 bytes, like node:crypto, for non-ASCII and astral text', () => {
    for (const text of ['é', 'Ünïcödé', '日本語', '😀', 'a\u0000b', 'x'.repeat(1000)]) {
      expect(sha256Hex(text), text).toBe(reference(text));
    }
  });

  it('returns 64 lowercase hex characters', () => {
    expect(sha256Hex('run-iq')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is exported by the main entry', () => {
    expect(main.sha256Hex).toBe(sha256Hex);
  });
});
