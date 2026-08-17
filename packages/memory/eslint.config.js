import { baseConfig } from '../../tooling/eslint/base.js';

export default [
  ...baseConfig(import.meta.dirname),
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-dom', 'react-dom/*', '@nestjs/*'],
              message:
                'packages/memory framework-suz bir domain paketidir; React veya NestJS import edemez (CLAUDE.md).',
            },
          ],
        },
      ],
    },
  },
];
