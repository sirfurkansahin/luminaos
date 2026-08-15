import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Tauri expects a fixed, predictable dev-server port (`devUrl` in
// `src-tauri/tauri.conf.json` is hardcoded to `http://localhost:1420`) —
// `strictPort: true` makes Vite fail fast instead of silently picking a
// different port if 1420 is already taken, which would otherwise desync
// the Tauri shell from the frontend dev server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
  },
});
