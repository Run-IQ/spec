// The time budgets of D-26 for the input tree (Task 9H1), measured on the built package:
// `npm run bench` (it builds first). Not part of `npm test` nor of CI: the suite bounds the same
// work by counting it (tests/input-scale.test.ts); a clock is only read here, on a machine at
// rest. Exits with 1 when a written budget is not held.
import { performance } from 'node:perf_hooks';
import { computeInputDigest, deriveInputSeed } from '../dist/index.js';

/** `core`'s `DEFAULT_LIMITS.maxInputLeaves` (D-26). */
const MAX_INPUT_LEAVES = 500_000;
/** `MAX_INPUT_LEAF_TEXT` (D-15): the UTF-16 code units of all the leaf pointers of an input. */
const MAX_INPUT_LEAF_TEXT = 2 ** 28;
const RUNS = 5;

const meta = {
  tenantId: 't1',
  dates: { effective: '2026-01-01' },
  tags: [],
  dimensions: {},
  context: {},
  assertions: {},
};

/** 500 000 leaves: 166 664 rows of three facts, their list, a total and the 6 leaves of meta. */
function largestInput() {
  const rows = Array.from({ length: 166_664 }, (_, i) => ({
    id: `row-${i}`,
    amount: i * 1.5,
    paid: i % 2 === 0,
  }));
  return { data: { rows, total: 0 }, meta };
}

/**
 * Leaf pointers of exactly `MAX_INPUT_LEAF_TEXT` code units: a value shared by 2^16 paths under
 * a long key, a second key for the remainder (as `sharedPointerText` of the tests).
 */
function longestPointers() {
  const depth = 16;
  const paths = 2 ** depth;
  // The pointers of meta: /meta/assertions, context, dates/effective, dimensions, tags, tenantId.
  const fixed = 16 + 13 + 21 + 16 + 10 + 14;
  const width = Math.floor((MAX_INPUT_LEAF_TEXT - fixed - 7) / paths) - 6 - 2 * depth;
  const rest = MAX_INPUT_LEAF_TEXT - fixed - paths * (6 + width + 2 * depth) - 6;
  let shared = 0;
  for (let level = 0; level < depth; level++) shared = { l: shared, r: shared };
  return { data: { ['k'.repeat(width)]: shared, ['z'.repeat(rest)]: 0 }, meta };
}

/** The median of `RUNS` timed digests of `input`, after one run to warm up. */
function measure(input) {
  const seed = deriveInputSeed(new Uint8Array(32).fill(1), 'bench');
  computeInputDigest(input, seed);
  const times = [];
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    computeInputDigest(input, seed);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(RUNS / 2)];
}

const cases = [
  { name: `computeInputDigest, ${MAX_INPUT_LEAVES} leaves`, input: largestInput(), budget: 5_000 },
  {
    name: `computeInputDigest, leaf pointers of ${MAX_INPUT_LEAF_TEXT} code units`,
    input: longestPointers(),
    budget: undefined,
  },
];

console.log(`node ${process.version}, median of ${RUNS} runs`);
for (const { name, input, budget } of cases) {
  const ms = measure(input);
  const verdict =
    budget === undefined
      ? 'no written budget'
      : `budget ${budget} ms: ${ms < budget ? 'held' : 'NOT HELD'}`;
  console.log(`${name}: ${ms.toFixed(0)} ms (${verdict})`);
  if (budget !== undefined && ms >= budget) process.exitCode = 1;
}
