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
                'packages/core-objects framework-suz bir domain paketidir; React veya NestJS import edemez (CLAUDE.md).',
            },
          ],
        },
      ],
      // F1-T4: formül alanları ifade motoru bu paket içinde yaşar; eval/
      // Function KESİNLİKLE yasak (spec'in kendi ifadesi) — sözdizimsel bir
      // güvence olarak burada zorunlu kılınır.
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
    },
  },
];
