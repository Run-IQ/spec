import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', canonical: 'src/canonical-entry.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
});
