import { baseConfig } from '../../tooling/eslint/base.js';

export default [
  ...baseConfig(import.meta.dirname),
  {
    // F2-T9 PR1 (ADR-0025 §g): `McpConnectorRegistry.register` is pinned to
    // return `void` (a catalog operation, not an upsert). The test-writer-
    // authored `mcp-connector-registry.test.ts` asserts the resulting
    // `ConflictError` via `expect(() => registry.register(...)).toThrow(...)`
    // arrow-shorthand callbacks — implementer must not edit that test file
    // (CLAUDE.md TDD ritual), and the interface's `void` return type is
    // itself ADR-pinned, so this specific type-aware rule is turned off for
    // this one file only (mirrors `apps/desktop/eslint.config.js`'s same
    // documented per-file override for a test-writer-authored file the
    // implementer must not edit).
    files: ['src/mcp/mcp-connector-registry.test.ts'],
    rules: {
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
];
