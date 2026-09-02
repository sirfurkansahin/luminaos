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
                'packages/automation framework-suz bir domain paketidir; React veya NestJS import edemez (CLAUDE.md).',
            },
          ],
        },
      ],
    },
  },
  {
    // F2-T15 PR1 (ADR-0032 Karar e): `assertSafeRegexPattern` is pinned to
    // return `void` (a throw-or-succeed guard, not a boolean predicate). The
    // test-writer-authored `regex-safety.test.ts` asserts success via
    // `expect(() => assertSafeRegexPattern(...)).not.toThrow()` arrow-
    // shorthand callbacks -- implementer must not edit that test file
    // (CLAUDE.md TDD ritual), and the function's `void` return type is
    // itself ADR-pinned, so this specific type-aware rule is turned off for
    // this one file only (mirrors `packages/integrations/eslint.config.js`'s
    // same documented per-file override for a test-writer-authored file the
    // implementer must not edit).
    files: ['src/regex-safety.test.ts'],
    rules: {
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
];
