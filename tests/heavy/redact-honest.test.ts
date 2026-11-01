/**
 * An honest redaction is never refused (review of 9K1, round 4): 4000 random subsets of the
 * entries of two larger proofs, from a fixed seed, each redacted and verified.
 */
import { expect, it } from 'vitest';
import { invalidRedactions, honestProof, placesOf, randomSubsets } from '../honest-redactions.js';
import { wideProof } from '../proof-builders.js';
import { baseContent } from '../proof-cases.js';

it.each([
  ['the base proof', () => baseContent(), 29],
  ['a wide proof of five decimal outputs', () => wideProof(5, 'decimal'), 44],
])(
  '%s: 4000 random subsets of its entries',
  (_, content, entries) => {
    const proof = honestProof(content());
    const n = placesOf(proof).length;
    expect(n).toBe(entries);
    expect(invalidRedactions(proof, randomSubsets(n, 4000, 12345))).toEqual([]);
  },
  600_000,
);
