import { baseConfig } from '../../tooling/eslint/base.js';

export default [
  ...baseConfig(import.meta.dirname),
  {
    // Playwright's fixture-definition signature (`async ({}, use) => {...}`)
    // idiomatically destructures an empty object when a fixture body needs
    // no other fixtures -- ESLint's `no-empty-pattern` otherwise flags this
    // as an error. Scoped only to test files (fixtures live inline in
    // apps/e2e/tests/board-drag-drop.spec.ts -- see its own "TASARIM NOTU"
    // comment on why fixture logic isn't split into separate files here).
    files: ['tests/**/*.ts'],
    rules: {
      'no-empty-pattern': 'off',
    },
  },
];
