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
                'packages/agent-runtime framework-suz bir domain paketidir; React veya NestJS import edemez (CLAUDE.md).',
            },
          ],
        },
      ],
    },
  },
  {
    // F3-T1 PR1 (ADR-0035): `assertValidManifestGrant` is a throw-or-succeed
    // guard (returns `void`), and its test-writer-authored test file asserts
    // both the throwing and non-throwing paths via
    // `expect(() => assertValidManifestGrant(...)).toThrow(...)` /
    // `.not.toThrow()` arrow-shorthand callbacks -- implementer must not
    // edit that test file (CLAUDE.md TDD ritual), mirroring
    // `packages/automation`'s and `packages/integrations`'s identical,
    // already-documented per-file override for the same test-writer pattern.
    files: ['src/permission-manifest-commands.test.ts'],
    rules: {
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    // F3-T1 PR1 (ADR-0035 Karar a): `runInAgentSandbox`'s test-writer-authored
    // test file exercises the sandbox with intentionally non-`await`-ing
    // async arrow functions (to model synchronous throws/never-resolving
    // promises per the ADR's exact scenarios) and with vitest's
    // `expect.any(Error)` matcher (typed `any` upstream) -- implementer must
    // not edit that test file (CLAUDE.md TDD ritual); mirrors
    // `packages/integrations`'s identical, already-documented
    // `require-await` override for the same test-writer pattern.
    files: ['src/run-in-agent-sandbox.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
];
