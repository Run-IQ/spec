/**
 * Honest redactions (review of 9K1, round 4): a proof sealed with a secret seed, then any set of
 * its entries redacted by `redactProof`, is never `invalid`. The accounting of what redacted
 * entries can explain (`unexplained`) counts less than the truth, never more.
 */
import { PROOF_SECTIONS, redactProof, sealProof, verifyProof } from '../src/index.js';
import type { DecisionProof, ProofSection, UnsaltedProof } from '../src/index.js';
import { fromHex } from './hashing.js';
import { unsalted } from './proof-cases.js';

const SEED = fromHex('f9b972f50267915261e884526c8553bdf4a353eb2e4e9e78ee65716aeceaacfb');

/** `content` sealed with a secret seed. */
export function honestProof(content: object): DecisionProof {
  return sealedAsGiven(unsalted(content));
}

/** `content`, already without salts, sealed with a secret seed. */
export function sealedAsGiven(content: object): DecisionProof {
  return sealProof({ ...content, inputSalted: true } as UnsaltedProof, SEED);
}

/** The places of the entries of `proof`, section by section. */
export function placesOf(proof: DecisionProof): [ProofSection, number][] {
  const places: [ProofSection, number][] = [];
  const record = proof as unknown as Record<ProofSection, unknown[]>;
  for (const section of PROOF_SECTIONS) {
    record[section].forEach((_, i) => places.push([section, i]));
  }
  return places;
}

/**
 * The redactions of `proof` (each a set of its places, `chosen`) that `verifyProof` finds
 * invalid, with their issues: none for an honest proof.
 */
export function invalidRedactions(
  proof: DecisionProof,
  masks: Iterable<readonly boolean[]>,
): string[] {
  const places = placesOf(proof);
  const found: string[] = [];
  for (const mask of masks) {
    const chosen = new Set(places.flatMap(([s, i], k) => (mask[k] === true ? [`${s}:${i}`] : [])));
    const result = verifyProof(redactProof(proof, (s, i) => chosen.has(`${s}:${i}`)));
    if (result.status === 'invalid') {
      found.push(`${[...chosen].join(' ')} => ${JSON.stringify(result.issues)}`);
    }
  }
  return found;
}

/** Every subset of `n` places. */
export function* everySubset(n: number): Generator<boolean[]> {
  for (let t = 0; t < 2 ** n; t++) yield Array.from({ length: n }, (_, i) => ((t >> i) & 1) === 1);
}

/** `count` subsets of `n` places, each place in with probability 1/3, from a fixed `seed`. */
export function* randomSubsets(n: number, count: number, seed: number): Generator<boolean[]> {
  let state = seed;
  for (let t = 0; t < count; t++) {
    yield Array.from({ length: n }, () => {
      // A linear congruential generator: the same subsets on every run.
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % 3 === 0;
    });
  }
}

/** Each subset of one place of `n`, then each of two. */
export function* singlesAndPairs(n: number): Generator<boolean[]> {
  for (let i = 0; i < n; i++) yield Array.from({ length: n }, (_, k) => k === i);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) yield Array.from({ length: n }, (_, k) => k === i || k === j);
  }
}
