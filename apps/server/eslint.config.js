import { nodeConfig } from '../../tooling/eslint/node.js';

export default [
  ...nodeConfig(import.meta.dirname),
  {
    // F2-T12 PR1 (ADR-0028 §j/§m): same `eslint-import-resolver-typescript`
    // limitation documented in `packages/integrations/eslint.config.js` for
    // `@modelcontextprotocol/sdk`'s deep subpath exports (`/server/mcp.js`,
    // `/server/streamableHttp.js`) -- Node's own ESM resolver honours the
    // SDK's `package.json` `exports` wildcard mapping fine (confirmed by
    // this package's own passing `tsc`/`vitest` runs), but the resolver
    // plugin produces a false-positive `import-x/no-unresolved` here.
    // Scoped to only the one file that imports these deep paths.
    files: ['src/mcp-server/mcp.controller.ts'],
    rules: {
      'import-x/no-unresolved': 'off',
    },
  },
];
