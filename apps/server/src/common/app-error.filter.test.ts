import { Writable } from 'node:stream';

import { Logger as NestLogger } from '@nestjs/common';
import { Logger as NestjsPinoLogger, PinoLogger } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppErrorFilter } from './app-error.filter.js';

import type { Env } from '../config/env.js';
import type { ArgumentsHost } from '@nestjs/common';
import type { Options as PinoHttpOptions } from 'pino-http';

/**
 * Direct unit test of `AppErrorFilter.catch()` -- F0-T8 PR-C's AC3, server
 * half: "Bilerek fırlatılan hata: server'da 500 + yapılandırılmış log."
 *
 * `AppErrorFilter` itself is UNCHANGED from before F0-T8 (last touched pre
 * PR-A -- see `./app-error.filter.ts`'s own doc comment). What changed
 * underneath it, per the approved plan, is that `nestjs-pino`'s
 * `LoggerModule` now wires a real pino pipeline in via
 * `app.useLogger(app.get(Logger))` (`main.ts`), which globally overrides
 * `@nestjs/common`'s static `Logger` -- meaning `AppErrorFilter`'s own
 * `private readonly logger = new Logger(AppErrorFilter.name)` (still
 * `@nestjs/common`'s `Logger`, never touched) now routes through pino
 * without any code change to the filter itself. This test proves that
 * routing survived intact: constructed directly (no full Nest app
 * bootstrap), with a REAL `nestjs-pino` `Logger`/`PinoLogger` backed by an
 * in-memory capturing stream -- not a mocked/spied logger -- so the
 * assertions below are against the actual JSON log line pino would produce,
 * not just "some method got called".
 *
 * `NestLogger.overrideLogger(...)` (called in `beforeAll`) is exactly what
 * `app.useLogger(app.get(Logger))` does at real bootstrap
 * (`main.ts`)/in `../observability/request-logging.integration.test.ts`'s
 * `app.useLogger(app.get(Logger))` call -- reproduced here directly, without
 * a full `INestApplication`, since this file's whole point is to unit-test
 * the filter class in isolation, mirroring how other filter-adjacent code in
 * this codebase is tested (a plain class, constructed directly, driven with
 * a hand-built `ArgumentsHost`-shaped mock rather than a real HTTP
 * request/response).
 *
 * This file does NOT exercise the `AppError` branch (already implicitly
 * covered by every integration test that hits a real `AppError`, e.g.
 * `../auth/tenant-isolation.integration.test.ts`'s wrong-password/no-session
 * assertions, and explicitly by
 * `../observability/request-logging.integration.test.ts`'s
 * requestId-on-the-warn-branch assertion) -- per the plan, this file's job
 * is specifically the non-`AppError` (500) branch's log-shape proof.
 *
 * ENV NOTE: `../observability/logging.module.js`'s top-level `import { env }
 * from '../config/env.js'` fails fast (`process.exit(1)`) if `DATABASE_URL`
 * OR `REDIS_URL` is unset when that module is first loaded -- a real concern
 * for a plain unit test with no Postgres/Redis container. `buildPinoHttpOptions`
 * itself is a pure function that never reads either value (only the `Env`
 * shape's `logLevel` field), so placeholder values are set just long enough
 * to satisfy that boot-time check (mirroring every existing
 * Testcontainers-driven test in this codebase, which does the same before
 * dynamically importing `logging.module.js`), then restored in `afterAll`
 * so this file never leaks mutated `process.env.DATABASE_URL`/`REDIS_URL`
 * into other test files that might share this worker process.
 */

const PINO_ERROR_LEVEL = 50;

class CollectingStream extends Writable {
  private readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  lines(): Record<string, unknown>[] {
    return this.chunks
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

interface MockHost {
  host: ArgumentsHost;
  statusMock: ReturnType<typeof vi.fn>;
  jsonMock: ReturnType<typeof vi.fn>;
}

function createMockHost(): MockHost {
  const jsonMock = vi.fn();
  const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
  const request = { method: 'GET', path: '/unit-test-path' };

  const host: ArgumentsHost = {
    switchToHttp: () => ({
      getResponse: () => ({ status: statusMock }),
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, statusMock, jsonMock };
}

describe('AppErrorFilter.catch() -- non-AppError branch (unit test, real pino-backed Logger)', () => {
  let stream: CollectingStream;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRedisUrl = process.env.REDIS_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgres://unit-test-placeholder/db';
    process.env.REDIS_URL = 'redis://unit-test-placeholder:6379';

    const { buildPinoHttpOptions } = await import('../observability/logging.module.js');

    const fakeEnv: Env = {
      databaseUrl: 'unused',
      logLevel: 'info',
      redisUrl: 'unused',
      aiTokenQuotaPerWorkspace: 1_000_000,
      aiCostBudgetUsdPerWorkspace: 10,
      aiRefreshDebounceMs: 5_000,
      webOrigin: 'http://localhost:5173',
      desktopOrigin: 'http://localhost:1420',
      docSnapshotDebounceMs: 10_000,
      docSnapshotMaxUpdates: 100,
      docMaxConnectionsPerRoom: 50,
      docMaxRooms: 1_000,
      searchIndexEmbeddingDebounceMs: 5_000,
      serverPublicUrl: 'http://localhost:3000',
    };
    const options: PinoHttpOptions = buildPinoHttpOptions(fakeEnv);

    stream = new CollectingStream();
    const pinoLogger = new PinoLogger({ pinoHttp: [options, stream] });
    const nestPinoLogger = new NestjsPinoLogger(pinoLogger, {});

    // Reproduces what `app.useLogger(app.get(Logger))` does at real
    // bootstrap (`main.ts`) -- this is what makes `AppErrorFilter`'s own
    // `new Logger(AppErrorFilter.name)` (from `@nestjs/common`, unmodified
    // since before F0-T8) route through the real pino pipeline instead of
    // the console.
    NestLogger.overrideLogger(nestPinoLogger);
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it('a bare non-AppError: responds 500 with a generic body, and logs a structured error-level line that never contains the raw message', () => {
    const filter = new AppErrorFilter();
    const { host, statusMock, jsonMock } = createMockHost();

    filter.catch(new Error('boom'), host);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });

    const lines = stream.lines();
    expect(lines.length).toBeGreaterThan(0);

    const errorLine = lines.find((line) => line['level'] === PINO_ERROR_LEVEL);
    expect(errorLine).toBeDefined();

    // The whole captured line, not just `.message`/`.msg` -- proving the raw
    // exception message never leaks into ANY field of the structured log
    // line (context, msg, or otherwise).
    const rawLoggedLine = JSON.stringify(errorLine);
    expect(rawLoggedLine).not.toContain('boom');
  });
});
