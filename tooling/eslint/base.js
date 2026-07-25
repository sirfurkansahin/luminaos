import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import { importX } from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

/**
 * @param {string} tsconfigRootDir - pass `import.meta.dirname` from the consuming package's eslint.config.js
 */
export function baseConfig(tsconfigRootDir) {
  return tseslint.config(
    {
      ignores: ['dist/**', '.turbo/**', 'coverage/**'],
    },
    js.configs.recommended,
    importX.flatConfigs.recommended,
    {
      files: ['**/*.ts', '**/*.tsx'],
      extends: [...tseslint.configs.recommendedTypeChecked, ...tseslint.configs.strictTypeChecked],
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      settings: {
        'import-x/resolver-next': [createTypeScriptImportResolver({ alwaysTryTypes: true })],
        'import-x/parsers': {
          '@typescript-eslint/parser': ['.ts', '.tsx', '.cts', '.mts'],
        },
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        // F1-T5: all AI provider calls must go through packages/ai-gateway;
        // a direct @anthropic-ai/sdk import anywhere else is a lint error.
        // Uses `no-restricted-syntax` (not `no-restricted-imports`) so it
        // can never be silently overridden by a package's own
        // `no-restricted-imports` block layered after this base config
        // (ESLint flat config replaces same-named rules wholesale across
        // the cascade, not merges them) — see
        // tooling/eslint/anthropic-sdk-ban.test.ts. packages/ai-gateway
        // itself turns this rule back off (it's the one package allowed to
        // use the real SDK).
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "ImportDeclaration[source.value='@anthropic-ai/sdk'], ImportExpression[source.value='@anthropic-ai/sdk']",
            message:
              'AI calls must go through packages/ai-gateway only; do not import @anthropic-ai/sdk directly (CLAUDE.md).',
          },
        ],
        'import-x/order': [
          'error',
          {
            groups: [
              'builtin',
              'external',
              'internal',
              ['parent', 'sibling', 'index'],
              'object',
              'type',
            ],
            pathGroups: [
              {
                pattern: '@luminaos/**',
                group: 'internal',
                position: 'before',
              },
            ],
            pathGroupsExcludedImportTypes: ['builtin'],
            'newlines-between': 'always',
            alphabetize: { order: 'asc', caseInsensitive: true },
          },
        ],
      },
    },
    {
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      extends: [tseslint.configs.disableTypeChecked],
    },
    eslintConfigPrettier,
  );
}
