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
                'packages/skill-sdk framework-suz bir domain paketidir; React veya NestJS import edemez (CLAUDE.md).',
            },
          ],
        },
      ],
    },
  },
  {
    // F3-T2 PR1 (ADR-0036): the test-writer-authored `it.each` tables in
    // `skill-manifest.test.ts` use arrow-shorthand `.not.toThrow()`/`.toThrow()`
    // callbacks that return a void expression, and its import block groups
    // `@luminaos/shared` before `vitest` -- implementer must not edit that
    // test file (CLAUDE.md TDD ritual), mirrors `packages/agent-runtime`'s
    // identical, already-documented per-file override for the same
    // test-writer pattern.
    files: ['src/skill-manifest.test.ts'],
    rules: {
      '@typescript-eslint/no-confusing-void-expression': 'off',
      'import-x/order': 'off',
    },
  },
  {
    // F3-T2 PR1 (ADR-0036): the test-writer-authored `generateEd25519Pem`
    // helper in `sign-verify-skill-signature.test.ts` calls `.toString()`
    // on the PEM `Buffer`/string export result -- implementer must not edit
    // that test file (CLAUDE.md TDD ritual).
    files: ['src/sign-verify-skill-signature.test.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
    },
  },
  {
    // F3-T2 PR1 (ADR-0036): the test-writer-authored `skill-registry.test.ts`
    // reuses the same `generateEd25519Pem` `.toString()` pattern, a
    // non-`await`-ing `async execute` stub, arrow-shorthand `.toThrow()`
    // callbacks, and an import block ordering the same way as
    // `skill-manifest.test.ts` -- implementer must not edit that test file
    // (CLAUDE.md TDD ritual).
    files: ['src/skill-registry.test.ts'],
    rules: {
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      '@typescript-eslint/require-await': 'off',
      'import-x/order': 'off',
    },
  },
];
