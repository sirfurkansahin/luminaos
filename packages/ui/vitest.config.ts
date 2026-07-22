import { defineConfig } from 'vitest/config';

import { coverageConfig } from '../../tooling/vitest/coverage.js';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Radix UI's Toast announcement region schedules its accessible text via
    // window.requestAnimationFrame (see @radix-ui/react-toast's useNextFrame).
    // jsdom only implements rAF when pretendToBeVisual is enabled — without
    // it, rAF is undefined and that text never renders.
    environmentOptions: {
      jsdom: {
        pretendToBeVisual: true,
      },
    },
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
