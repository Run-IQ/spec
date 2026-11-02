import { defineConfig } from 'vitest/config';

/** The heavy tests: the scale limits (10M values, 2^28 code units, strings of 2^29). */
const HEAVY = 'tests/heavy/**/*.test.ts';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Type tests (tests/*.test-d.ts) are checked by `npm run typecheck` (tsc on
    // tsconfig.test.json), not by Vitest's experimental typecheck runner.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
    projects: [
      {
        extends: true,
        // `npm test`: every test but the heavy ones, files in parallel.
        test: { name: 'fast', include: ['tests/**/*.test.ts'], exclude: [HEAVY] },
      },
      {
        extends: true,
        // `npm run test:heavy`: one file at a time (the script also passes one worker), so
        // that no two of them hold their gigabytes at once.
        // Each worker gets an 8 GiB heap: some of them (the disclosure at scale) pass the default
        // heap of Node 20 and 22, so `npm run test:heavy` needs no `NODE_OPTIONS`.
        test: {
          name: 'heavy',
          include: [HEAVY],
          fileParallelism: false,
          execArgv: ['--max-old-space-size=8192'],
        },
      },
    ],
  },
});
