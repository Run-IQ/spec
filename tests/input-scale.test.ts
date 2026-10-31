import { describe, expect, it } from 'vitest';
import { computeInputDigest, deriveInputSeed, inputLeaves, merkleRoot } from '../src/index.js';
import { inputLeafHash, validateProofInput } from '../src/index.js';
import type { ProofInput } from '../src/index.js';
import { lastInputLeafCount } from '../src/input/tree.js';
import { MAX_INPUT_POINTER_TEXT } from '../src/values.js';
import { hex, proofInput, withPointerText } from './helpers.js';

/** `core`'s `DEFAULT_LIMITS.maxInputLeaves` (D-26): the default largest input. */
const MAX_INPUT_LEAVES = 500_000;
/** The budget of D-26 for the digest of an input of `MAX_INPUT_LEAVES` leaves. */
const BUDGET_MS = 5_000;

/**
 * An input of exactly `MAX_INPUT_LEAVES` leaves: 166 664 rows of three facts, the list holding
 * them and a total (499 994 leaves under `data`), and the 6 leaves of `meta`.
 */
function largestInput(): ProofInput {
  const rows = Array.from({ length: 166_664 }, (_, i) => ({
    id: `row-${i}`,
    amount: i * 1.5,
    paid: i % 2 === 0,
  }));
  return proofInput({}, { rows, total: 0 });
}

/**
 * The CPU time, in milliseconds, the calling thread has used so far: the work it did, whatever
 * else runs on the machine (the other test files run in parallel). `process.threadCpuUsage`
 * exists from Node 23.9; an older Node falls back to the wall clock, which other work can
 * stretch.
 */
function threadMilliseconds(): number {
  const clock: unknown = Reflect.get(process, 'threadCpuUsage');
  if (typeof clock === 'function') {
    const usage: unknown = Reflect.apply(clock, process, []);
    if (typeof usage === 'object' && usage !== null) {
      const user: unknown = Reflect.get(usage, 'user');
      const system: unknown = Reflect.get(usage, 'system');
      if (typeof user === 'number' && typeof system === 'number') return (user + system) / 1000;
    }
  }
  return performance.now();
}

describe(`scale (D-26): an input of ${MAX_INPUT_LEAVES} leaves`, () => {
  it(`is digested in less than ${BUDGET_MS} ms of the thread's time`, () => {
    const input = largestInput();
    const seed = deriveInputSeed(new Uint8Array(32).fill(1), 'scale');
    const start = threadMilliseconds();
    const digest = computeInputDigest(input, seed);
    const elapsed = threadMilliseconds() - start;
    expect(lastInputLeafCount()).toBe(MAX_INPUT_LEAVES);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  }, 60_000);
});

describe(`leaf pointers of ${MAX_INPUT_POINTER_TEXT} code units, the most an input holds`, () => {
  it('is digested, and the digest is the root of its leaves', () => {
    const input = withPointerText(MAX_INPUT_POINTER_TEXT);
    expect(validateProofInput(input)).toEqual([]);
    const seed = deriveInputSeed(new Uint8Array(32).fill(2), 'limit');
    const digest = computeInputDigest(input, seed);
    expect(lastInputLeafCount()).toBe(17);
    const leaves = inputLeaves(input, seed);
    expect(leaves.reduce((total, leaf) => total + leaf.pointer.length, 0)).toBe(
      MAX_INPUT_POINTER_TEXT,
    );
    expect(digest).toBe(hex(merkleRoot(leaves.map(inputLeafHash))));
  }, 120_000);
});
