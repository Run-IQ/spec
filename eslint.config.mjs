import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

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
);
