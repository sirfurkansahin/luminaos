import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NextFunction, Request, Response } from 'express';

/**
 * RED-step unit test for ADR-0020-masaustu-sinyal-toplayicilar.md's
 * server-side companion change (F2-T3 PR4): `../config/env.ts` gains a
 * `desktopOrigin`/`readDesktopOrigin()` pair (`DESKTOP_ORIGIN` env var,
 * default `http://localhost:1420` -- matching ADR-0019's `tauri.conf.json`
 * `devUrl`, mirroring `readWebOrigin()`'s EXACT "absent/blank -> default"
 * shape), and `corsMiddleware` (`./cors.middleware.ts`) widens its
 * single-origin check from `origin === env.webOrigin` to
 * `origin === env.webOrigin || origin === env.desktopOrigin` -- still a
 * single exact-match reflection, still NO wildcard fallback.
 *
 * Neither change exists yet -- expected to fail RED, either because
 * `env.ts` has no `desktopOrigin` field (`env.desktopOrigin` is
 * `undefined`, so the desktop-origin assertion below never matches) or
 * because `corsMiddleware` itself hasn't been widened.
 *
 * `env.ts` exports an ALREADY-EVALUATED singleton (`export const env: Env =
 * readEnv();`) -- follows `../config/env-search.test.ts`'s EXACT precedent:
 * `process.env` is set BEFORE each dynamic import, `vi.resetModules()` runs
 * in `beforeEach` so the next `await import('./cors.middleware.js')`
 * (which transitively re-imports `../config/env.js`) re-evaluates both
 * modules fresh, and `process.env` is restored to its pre-suite snapshot
 * afterward so no mutated var leaks into another test file sharing this
 * Vitest worker process. `DATABASE_URL`/`REDIS_URL` are stubbed purely to
 * satisfy `readEnv()`'s EXISTING fail-fast boot checks -- neither is read
 * by `corsMiddleware` itself.
 *
 * `corsMiddleware` is driven directly against hand-built `Request`/
 * `Response` mocks -- mirrors `./app-error.filter.test.ts`'s
 * `createMockHost()` style for unit-testing a single middleware/filter
 * class in isolation, no Testcontainers/HTTP server. This is DELIBERATELY
 * separate from `../cors.integration.test.ts`'s real Testcontainers+
 * supertest E2E coverage of `env.webOrigin` -- that file is untouched;
 * this new one is scoped purely to the desktop-origin widening, unit-level
 * for speed (per the task brief: "Testcontainers GEREKMEZ").
 */

const WEB_ORIGIN = 'http://localhost:5173';
const DESKTOP_ORIGIN = 'http://localhost:1420';
const EVIL_ORIGIN = 'https://evil.example';

const ENV_SNAPSHOT = { ...process.env };

function restoreEnvToSnapshot(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ENV_SNAPSHOT)) {
      Reflect.deleteProperty(process.env, key);
    }
  }
  Object.assign(process.env, ENV_SNAPSHOT);
}

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = 'postgres://unit-test-placeholder/db';
  process.env.REDIS_URL = 'redis://unit-test-placeholder:6379';
  process.env.WEB_ORIGIN = WEB_ORIGIN;
  process.env.DESKTOP_ORIGIN = DESKTOP_ORIGIN;
});

afterEach(() => {
  restoreEnvToSnapshot();
});

interface MockReqRes {
  req: Request;
  res: Response;
  next: NextFunction;
  headers: Record<string, string>;
}

function createMockReqRes(origin: string | undefined): MockReqRes {
  const headers: Record<string, string> = {};
  const req = { headers: { origin }, method: 'GET' } as unknown as Request;
  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next, headers };
}

describe('corsMiddleware -- multi-origin allowlist (F2-T3 PR4, ADR-0020)', () => {
  it('reflects Access-Control-Allow-Origin/Credentials for env.webOrigin', async () => {
    const { corsMiddleware } = await import('./cors.middleware.js');
    const { req, res, next, headers } = createMockReqRes(WEB_ORIGIN);

    corsMiddleware(req, res, next);

    expect(headers['Access-Control-Allow-Origin']).toBe(WEB_ORIGIN);
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('ALSO reflects Access-Control-Allow-Origin/Credentials for env.desktopOrigin (NEW, ADR-0020)', async () => {
    const { corsMiddleware } = await import('./cors.middleware.js');
    const { req, res, next, headers } = createMockReqRes(DESKTOP_ORIGIN);

    corsMiddleware(req, res, next);

    expect(headers['Access-Control-Allow-Origin']).toBe(DESKTOP_ORIGIN);
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('a THIRD, unrecognized origin gets neither header -- still no wildcard fallback', async () => {
    const { corsMiddleware } = await import('./cors.middleware.js');
    const { req, res, next, headers } = createMockReqRes(EVIL_ORIGIN);

    corsMiddleware(req, res, next);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
    expect(Object.values(headers)).not.toContain('*');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('env.desktopOrigin defaults to http://localhost:1420 when DESKTOP_ORIGIN is unset (mirrors readWebOrigin default style)', async () => {
    delete process.env.DESKTOP_ORIGIN;

    const { corsMiddleware } = await import('./cors.middleware.js');
    const { req, res, next, headers } = createMockReqRes('http://localhost:1420');

    corsMiddleware(req, res, next);

    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:1420');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
