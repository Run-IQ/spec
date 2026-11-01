/**
 * An honest redaction is never refused (review of 9K1, round 5): the 364 proofs of the review's
 * corpus (`fixtures/honest-corpus.jsonl`, the contents the suite builds, ties and exceptions
 * among them), each sealed with a secret seed, then redacted: every single entry, every pair of
 * entries, 150 subsets from a fixed seed and the whole proof. None is `invalid`.
 */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { verifyProof } from '../../src/index.js';
import {
  invalidRedactions,
  placesOf,
  randomSubsets,
  sealedAsGiven,
  singlesAndPairs,
} from '../honest-redactions.js';

const CORPUS = readFileSync(new URL('./fixtures/honest-corpus.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as object);

it('the review corpus: 364 proofs, 64063 redactions, none invalid', () => {
  expect(CORPUS).toHaveLength(364);
  let redactions = 0;
  const invalid: string[] = [];
  CORPUS.forEach((content, index) => {
    const proof = sealedAsGiven(content);
    expect(verifyProof(proof).status).not.toBe('invalid');
    const n = placesOf(proof).length;
    const masks = [
      ...singlesAndPairs(n),
      ...randomSubsets(n, 150, 99 + index),
      Array.from({ length: n }, () => true),
    ];
    redactions += masks.length;
    for (const found of invalidRedactions(proof, masks)) invalid.push(`#${index} ${found}`);
  });
  expect(redactions).toBe(64063);
  expect(invalid).toEqual([]);
}, 1_800_000);
