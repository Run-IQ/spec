import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Type tests (tests/*.test-d.ts) are checked by `npm run typecheck` (tsc on
    // tsconfig.test.json), not by Vitest's experimental typecheck runner.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
