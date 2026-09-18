import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    // `apiClient.ts`'in TÜM istekleri göreli URL'lerdir (`/workspaces/...`) --
    // proxy olmadan bunlar tarayıcıda bu dev sunucusunun kendisine
    // (localhost:5173) gider, apps/server'a (3000) hiç ulaşmaz. `apiClient.ts`
    // yalnızca `/workspaces/...` çağırıyor (login/register UI henüz yok), bu
    // yüzden yalnızca bu önek proxy'leniyor.
    proxy: {
      '/workspaces': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
  },
});
