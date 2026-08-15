import tseslint from 'typescript-eslint';

import { reactConfig } from '../../tooling/eslint/react.js';

export default [
  ...reactConfig(import.meta.dirname),
  {
    // `*.integration.test.ts` files (`package-config.integration.test.ts`,
    // `src-tauri-config.integration.test.ts`) live at the package root, not
    // under `src/`, so they're deliberately excluded from `tsconfig.json`'s
    // `include` -- pulling them into the main tsconfig project would make
    // `pnpm typecheck` (`tsc --noEmit`) fail on a strict-mode
    // (`noUncheckedIndexedAccess`) narrowing case in
    // `src-tauri-config.integration.test.ts`'s `generate_handler!` regex-match
    // assertion, a test-writer-authored file this package must not edit.
    // Disabling type-aware linting for these two files (mirrors
    // `tooling/eslint/base.js`'s identical treatment of `**/*.js`/`.mjs`/
    // `.cjs`) avoids both the "not found by the project service" parse error
    // and the type-aware `no-unsafe-return` false positive on
    // `JSON.parse(...)`, while still running all non-type-aware rules
    // (unused vars, import order, etc.) against them.
    files: ['*.integration.test.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
];
