import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import { CAPTURED_GLOBALS, HOST_GLOBALS } from './eslint-rules/globals.mjs';
import noLiveBuiltins from './eslint-rules/no-live-builtins.mjs';

export default defineConfig(
  { ignores: ['dist/', 'node_modules/', '**/*.config.*'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // The bench script runs on Node: `process` is its only global beyond the language's.
    files: ['bench/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly' } },
  },
  {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    // The machine check of the capture (round 6, AC1): `src/` uses no live built-in outside
    // `intrinsics.ts`. Patching a built-in after load must change no verdict.
    files: ['src/**/*.ts'],
    ignores: ['src/intrinsics.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { local: noLiveBuiltins },
    rules: {
      'local/no-live-builtins': 'error',
      'no-restricted-globals': [
        'error',
        ...CAPTURED_GLOBALS.map((name) => ({
          name,
          message: `Use the captured one from src/intrinsics.ts (Native${name}), never the live global.`,
        })),
        ...HOST_GLOBALS.map((name) => ({
          name,
          message: `${name} is a host global: capture what is needed in src/intrinsics.ts, never read it live.`,
        })),
      ],
    },
  },
);
