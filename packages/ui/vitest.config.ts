import { defineConfig } from 'vitest/config';

import { coverageConfig } from '../../tooling/vitest/coverage.js';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: true,
    coverage: {
      ...coverageConfig(85),
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.stories.tsx'],
    },
  },
});
