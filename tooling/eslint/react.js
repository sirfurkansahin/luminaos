import jsxA11y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

import { baseConfig } from './base.js';

/**
 * @param {string} tsconfigRootDir - pass `import.meta.dirname` from the consuming package's eslint.config.js
 * @param {string} [reactVersion] - pinned `react` version string (e.g. '19.2.7'). Must be an
 *   explicit version, not 'detect': under ESLint 9+ flat config, eslint-plugin-react's
 *   'detect' path calls the removed `context.getFilename()` API and throws.
 */
export function reactConfig(tsconfigRootDir, reactVersion = '19.2.7') {
  return tseslint.config(
    ...baseConfig(tsconfigRootDir),
    {
      files: ['**/*.tsx'],
      ...react.configs.flat.recommended,
      settings: {
        react: { version: reactVersion },
      },
      rules: {
        ...react.configs.flat.recommended.rules,
        // TypeScript already validates prop shapes at compile time; PropTypes
        // runtime validation is irrelevant in a TS-only codebase.
        'react/prop-types': 'off',
      },
    },
    {
      files: ['**/*.tsx'],
      ...react.configs.flat['jsx-runtime'],
    },
    {
      files: ['**/*.tsx'],
      ...jsxA11y.flatConfigs.recommended,
    },
    {
      files: ['**/*.ts', '**/*.tsx'],
      plugins: {
        'react-hooks': reactHooks,
      },
      rules: {
        ...reactHooks.configs.recommended.rules,
      },
    },
  );
}
