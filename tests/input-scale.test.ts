import { describe, expect, it } from 'vitest';
import { computeInputDigest, deriveInputSeed, inputLeaves } from '../src/index.js';
import type { ProofInput } from '../src/index.js';
import { lastInputLeafCount } from '../src/input/tree.js';
import { hashWorkDone } from '../src/merkle.js';
import { MAX_INPUT_LEAF_TEXT } from '../src/values.js';
import { expectedHashWork, leafBytes, proofInput, sharedPointerText } from './helpers.js';

/** `core`'s `DEFAULT_LIMITS.maxInputLeaves` (D-26): the default largest input. */
const MAX_INPUT_LEAVES = 500_000;

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

/** The hash work `call` does (`hashWork`): its calls and the bytes given to them. */
function hashWorkOf(call: () => unknown): { calls: number; bytes: number } {
  const before = hashWorkDone();
  call();
  const after = hashWorkDone();
  return { calls: after.calls - before.calls, bytes: after.bytes - before.bytes };
}

// The time budgets of D-26 are measured by `npm run bench`, never asserted here: a test bounds
// the work by counting it.
describe(`scale (D-26): an input of ${MAX_INPUT_LEAVES} leaves`, () => {
  it('is digested by 3 hashes a leaf, over the bytes of its leaves and nothing more', () => {
    const input = largestInput();
    const seed = deriveInputSeed(new Uint8Array(32).fill(1), 'scale');
    let digest = '';
    const work = hashWorkOf(() => {
      digest = computeInputDigest(input, seed);
    });
    expect(lastInputLeafCount()).toBe(MAX_INPUT_LEAVES);
    const leaves = inputLeaves(input, seed);
    expect(leaves).toHaveLength(MAX_INPUT_LEAVES);
    expect(work).toEqual(expectedHashWork(leaves.map(leafBytes)));
    expect(work.calls).toBe(3 * MAX_INPUT_LEAVES);
    // Counted independently (Python, report of Task 9H1, round 2).
    expect(work.bytes).toBe(91_064_644);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);
});

describe(`leaf pointers of ${MAX_INPUT_LEAF_TEXT} code units, the most an input holds`, () => {
  it('is digested, each pointer hashed twice: the work stays linear in the limit', () => {
    const { input, paths, width, rest } = sharedPointerText(MAX_INPUT_LEAF_TEXT, 16);
    const seed = deriveInputSeed(new Uint8Array(32).fill(2), 'limit');
    const meta = inputLeaves(proofInput({}, {}), seed).filter((leaf) => leaf.pointer !== '/data');
    const work = hashWorkOf(() => computeInputDigest(input, seed));
    expect(lastInputLeafCount()).toBe(paths + 1 + meta.length);
    // Each shared leaf `/data/k…/l/…` holds the value 0: its content is its pointer and 14 bytes.
    const pointer = 6 + width + 2 * 16;
    const shared = { pointerBytes: pointer, contentBytes: pointer + 14 };
    const last = { pointerBytes: 6 + rest, contentBytes: 6 + rest + 14 };
    const leaves = [...Array<typeof shared>(paths).fill(shared), last, ...meta.map(leafBytes)];
    expect(work).toEqual(expectedHashWork(leaves));
    expect(work.bytes).toBeLessThan(2 * MAX_INPUT_LEAF_TEXT + 200 * (paths + 1 + meta.length));
  }, 120_000);
});
