/* eslint-env node */
// The time budgets of D-26 for the input tree (Task 9H1), measured on the built package:
// `npm run bench` (it builds first). Not part of `npm test` nor of CI: the suite bounds the same
// work by counting it (tests/input-scale.test.ts); a clock is only read here, on a machine at
// rest. Exits with 1 when a written budget is not held.
import { performance } from 'node:perf_hooks';
import {
  computeInputDigest,
  deriveInputSeed,
  inputLeaves,
  UNSALTED_SEED,
  validateProofInput,
} from '../dist/index.js';

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

/** The code units of the leaf pointers of `meta`, as the package itself lists its leaves. */
const META_TEXT = inputLeaves({ data: {}, meta }, UNSALTED_SEED)
  .filter((leaf) => leaf.pointer.startsWith('/meta'))
  .reduce((sum, leaf) => sum + leaf.pointer.length, 0);

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
 * Leaf pointers of `units` code units: a value shared by 2^16 paths under a long key, and a
 * second key for the remainder (as `sharedPointerText` of the tests).
 */
function sharedPointers(units) {
  const depth = 16;
  const paths = 2 ** depth;
  const width = Math.floor((units - META_TEXT - 7) / paths) - 6 - 2 * depth;
  const rest = units - META_TEXT - paths * (6 + width + 2 * depth) - 6;
  let shared = 0;
  for (let level = 0; level < depth; level++) shared = { l: shared, r: shared };
  return { data: { ['k'.repeat(width)]: shared, ['z'.repeat(rest)]: 0 }, meta };
}

/** Leaf pointers of `units` code units in one leaf: `/data/<key>` holding 0. */
function singleKey(units) {
  return { data: { ['k'.repeat(units - META_TEXT - '/data/'.length)]: 0 }, meta };
}

/** `make(MAX_INPUT_LEAF_TEXT)`, proven at the limit: valid, and one code unit more is not. */
function atTheLimit(make) {
  const input = make(MAX_INPUT_LEAF_TEXT);
  const over = validateProofInput(make(MAX_INPUT_LEAF_TEXT + 1));
  if (validateProofInput(input).length !== 0 || over.length !== 1) {
    throw new Error('the bench input is not at the leaf text limit');
  }
  return input;
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
  { name: `${MAX_INPUT_LEAVES} leaves`, input: () => largestInput(), budget: 5_000 },
  {
    name: `leaf pointers of ${MAX_INPUT_LEAF_TEXT} code units, 2^16 paths to a shared value`,
    input: () => atTheLimit(sharedPointers),
    budget: undefined,
  },
  {
    name: `leaf pointers of ${MAX_INPUT_LEAF_TEXT} code units, one key`,
    input: () => atTheLimit(singleKey),
    budget: undefined,
  },
];

const print = (line) => process.stdout.write(`${line}\n`);
print(`node ${process.version}, computeInputDigest, median of ${RUNS} runs`);
for (const { name, input, budget } of cases) {
  const ms = measure(input());
  const verdict =
    budget === undefined
      ? 'no written budget'
      : `budget ${budget} ms: ${ms < budget ? 'held' : 'NOT HELD'}`;
  print(`${name}: ${ms.toFixed(0)} ms (${verdict})`);
  if (budget !== undefined && ms >= budget) process.exitCode = 1;
}
