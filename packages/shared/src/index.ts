// Kept free of `node:*` imports on purpose — Vite's dev server evaluates a
// barrel's entire module graph on any named import, so anything Node-only
// re-exported here would crash `apps/web`'s browser bundle at load time
// (`Module "node:crypto" has been externalized...`). Node-only utilities
// (ids/, secrets/) live behind the `@luminaos/shared/server` subpath.
export * from './errors/index.js';
export * from './events/index.js';
export * from './query/index.js';

/**
 * `/health`'s response shape. Widened for F0-T8 PR-C: health-checking now
 * requires real IO (DB `SELECT 1`, Redis `PING`), so the logic that used to
 * build this payload (`buildHealthCheckPayload()`, removed here) can no
 * longer live in this IO-free package — it moves to
 * `apps/server/src/health/health.service.ts`. This package keeps only the
 * shape, since both the server and any future client that consumes
 * `/health` need a shared type for it.
 */
export interface HealthCheckPayload {
  status: 'ok' | 'degraded';
  checks: { db: 'ok' | 'error'; redis: 'ok' | 'error' };
  version: string;
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
