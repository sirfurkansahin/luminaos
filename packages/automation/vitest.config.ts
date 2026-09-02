import { defineConfig } from 'vitest/config';

import { coverageConfig } from '../../tooling/vitest/coverage.js';

export default defineConfig({
  test: {
    coverage: coverageConfig(95),
  },
});
