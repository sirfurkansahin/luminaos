import { baseConfig } from '../../tooling/eslint/base.js';

export default [
  ...baseConfig(import.meta.dirname),
  {
    // packages/ai-gateway is the one package allowed to import the real
    // @anthropic-ai/sdk directly; the repo-wide ban (tooling/eslint/base.js)
    // is turned off here. See tooling/eslint/anthropic-sdk-ban.test.ts.
    files: ['**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
