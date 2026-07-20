import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [swc.vite()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
