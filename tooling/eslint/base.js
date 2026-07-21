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
