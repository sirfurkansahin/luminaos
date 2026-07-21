import { baseConfig } from './base.js';

export function nodeConfig(tsconfigRootDir) {
  return [
    ...baseConfig(tsconfigRootDir),
    {
      files: ['**/*.ts'],
      rules: {
        // NestJS modules are idiomatically empty classes carrying only a @Module() decorator.
        '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      },
    },
  ];
}
