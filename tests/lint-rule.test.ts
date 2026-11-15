/**
 * The lint rule that keeps `src/` off the live built-ins (`eslint-rules/no-live-builtins.mjs`,
 * with the restricted globals of `eslint-rules/globals.mjs`) has a test of its own (round 7,
 * AF5): `src/` is clean, so a weakened rule would pass the lint and every other test. Each file
 * of `tests/lint-fixtures/` holds one pattern that must be refused, named in this table by the
 * message the rule gives (`messageId`) or by the restricted global it names. `clean.ts` holds
 * the allowed forms and must give no error.
 */
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { CAPTURED_GLOBALS, HOST_GLOBALS } from '../eslint-rules/globals.mjs';
import noLiveBuiltins from '../eslint-rules/no-live-builtins.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const FIXTURES = `${ROOT}tests/lint-fixtures/`;

const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.ts'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { project: `${FIXTURES}tsconfig.json`, tsconfigRootDir: FIXTURES },
      },
      plugins: { local: noLiveBuiltins },
      rules: {
        'local/no-live-builtins': 'error',
        'no-restricted-globals': [
          'error',
          ...[...CAPTURED_GLOBALS, ...HOST_GLOBALS].map((name) => ({ name })),
        ],
      },
    },
  ],
});

async function problems(name: string): Promise<string[]> {
  const [result] = await eslint.lintFiles([`${FIXTURES}${name}.ts`]);
  return result!.messages.map((m) =>
    m.ruleId === 'no-restricted-globals'
      ? `no-restricted-globals:${/'(\w+)'/.exec(m.message)?.[1]}`
      : `${m.ruleId}:${m.messageId}`,
  );
}

/** Fixture, then a rule problem it must raise (`local/no-live-builtins:<messageId>` or a global). */
const MUST_FAIL: readonly (readonly [string, string])[] = [
  ['method-call', 'local/no-live-builtins:live'],
  ['getter', 'local/no-live-builtins:live'],
  ['static-call', 'local/no-live-builtins:live'],
  ['host-method', 'local/no-live-builtins:live'],
  ['destructured-method', 'local/no-live-builtins:destructured'],
  ['instanceof', 'local/no-live-builtins:instanceOf'],
  ['in-operator', 'local/no-live-builtins:inOperator'],
  ['literal-index', 'local/no-live-builtins:elementRead'],
  ['for-of', 'local/no-live-builtins:iteration'],
  ['for-in', 'local/no-live-builtins:forIn'],
  ['array-spread', 'local/no-live-builtins:iteration'],
  ['call-spread', 'local/no-live-builtins:iteration'],
  ['array-destructuring', 'local/no-live-builtins:iteration'],
  ['yield-star', 'local/no-live-builtins:iteration'],
  ['set-from-iterable', 'local/no-live-builtins:iteration'],
  ['map-from-iterable', 'local/no-live-builtins:iteration'],
  ['global-process', 'no-restricted-globals:process'],
  ['global-text-encoder', 'no-restricted-globals:TextEncoder'],
  ['global-this', 'no-restricted-globals:globalThis'],
  ['global-structured-clone', 'no-restricted-globals:structuredClone'],
  ['global-uri', 'no-restricted-globals:encodeURIComponent'],
  ['global-timer', 'no-restricted-globals:setTimeout'],
  ['global-object', 'no-restricted-globals:Object'],
];

describe('the lint rule against live built-ins', () => {
  it.each(MUST_FAIL)('refuses %s', async (fixture, expected) => {
    const found = await problems(fixture);
    expect(found, fixture).toContain(expected);
  });

  it('accepts indexed loops, object spread and plain operators', async () => {
    expect(await problems('clean')).toEqual([]);
  });
});
