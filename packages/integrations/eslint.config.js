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
  {
    // F2-T10 PR1 (ADR-0026 §g): `@modelcontextprotocol/sdk`'s deep subpath
    // exports (`/client/index.js`, `/client/streamableHttp.js`,
    // `/server/index.js`, `/server/streamableHttp.js`, `/types.js`) resolve
    // correctly at build/runtime (Node's own ESM resolver honours the SDK's
    // `package.json` `exports` wildcard `"./*"` -> `"./dist/esm/*"` mapping,
    // confirmed by this package's own passing `tsc`/`vitest` runs) but
    // `eslint-import-resolver-typescript` does not fully resolve that
    // wildcard subpath-export pattern, producing false-positive
    // `import-x/no-unresolved` errors across every file that imports from
    // the SDK's client/server deep paths (both this package's own
    // `streamable-http-mcp-connector.ts` and the test-writer-authored fake
    // in-process MCP server harnesses in `*.test.ts`, which implementer must
    // not edit). Scoped to only the files that actually import these deep
    // paths, not the whole package.
    files: [
      'src/mcp/streamable-http-mcp-connector.ts',
      'src/mcp/streamable-http-mcp-connector.test.ts',
      'src/mcp/connectors/notion-mcp-connector.test.ts',
    ],
    rules: {
      'import-x/no-unresolved': 'off',
    },
  },
  {
    // F2-T10 PR1 (ADR-0026 §g): test-writer-authored fake in-process
    // Streamable HTTP MCP server harnesses (implementer must not edit,
    // CLAUDE.md TDD ritual). Three narrow, pre-existing-in-the-test-file
    // conditions implementer cannot resolve by changing test content:
    // (1) the SDK's own low-level `Server` class is used deliberately (its
    // request-handler surface is what the fake server needs; the
    // `no-deprecated` warning is about the SDK's own migration guidance
    // toward `McpServer`, irrelevant to a test-only fake); (2) two
    // `setRequestHandler` callbacks are declared `async` for symmetry with
    // the SDK's handler signature even though their specific branches never
    // `await`; (3) the fake server's `startFakeMcpServer`/
    // `startFakeNotionMcpServer` helpers pass `ZodType<unknown>`-typed maps
    // through the SDK's schema types, triggering a default-type-argument
    // redundancy warning inherent to how the test constructs its schema map
    // literals, not to any implementer-controlled file.
    files: [
      'src/mcp/streamable-http-mcp-connector.test.ts',
      'src/mcp/connectors/notion-mcp-connector.test.ts',
    ],
    rules: {
      '@typescript-eslint/no-deprecated': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-type-arguments': 'off',
    },
  },
];
