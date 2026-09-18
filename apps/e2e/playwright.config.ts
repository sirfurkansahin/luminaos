import { defineConfig, devices } from '@playwright/test';

const WEB_URL = 'http://localhost:5173';
const SERVER_URL = 'http://localhost:3000';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://lumina:lumina@localhost:5432/lumina_dev';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

// F0-T9: only Chromium (spec's explicit v0 scope — Firefox/WebKit matrix is
// out of scope, docs/specs/F0-E1/F0-T9-playwright-e2e-altyapisi.md "Kapsam
// DIŞI"). Runtime workspace-id injection (`?e2eWorkspaceId=`, see
// apps/web/src/App.tsx's `DEV_WORKSPACE_ID`) means no `globalSetup` is
// needed — each test (via apps/e2e/tests/board-drag-drop.spec.ts's own
// fixtures) creates a fresh user/workspace against the already-running
// `apps/server` webServer below.
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @luminaos/web dev',
      url: WEB_URL,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
    {
      // `db:migrate` runs first (idempotent -- drizzle skips already-applied
      // migrations) so this webServer is self-contained on a fresh Postgres
      // (CI's service container, or a first-time local `docker compose up`)
      // without needing a separate CI step to run migrations.
      command:
        'pnpm --filter @luminaos/server run db:migrate && pnpm --filter @luminaos/server run dev',
      // `/health` (apps/server/src/app.controller.ts), not `SERVER_URL` root --
      // Playwright's readiness probe treats any non-2xx/3xx-ish response
      // (`statusCode < 404`) as "not ready yet" and keeps polling until its
      // timeout; the root path has no route and the app's global error
      // filter converts that `NotFoundException` into a bare `500`, which
      // would make this webServer entry time out forever even though the
      // process is actually up and serving requests.
      url: `${SERVER_URL}/health`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: {
        DATABASE_URL,
        REDIS_URL,
      },
    },
  ],
});
