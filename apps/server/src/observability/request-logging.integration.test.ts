import { Writable } from 'node:stream';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate.js';

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * Real, end-to-end integration test for F0-T8 PR-A's AC1: "Bir API isteğinin
 * logları tek requestId ile uçtan uca takip edilebilir (testle kanıtlı)."
 *
 * Follows the same Testcontainers + `Test.createTestingModule({imports:
 * [AppModule]})` + `supertest` pattern established in
 * `../auth/tenant-isolation.integration.test.ts`: a throwaway Postgres 16
 * container, real migrations, the real `AppModule` (not a hand-picked
 * subset), driven purely over HTTP.
 *
 * The one addition this test needs beyond that pattern is capturing the
 * app's actual log output as structured lines, so it can assert on
 * requestId propagation. Per the approved plan
 * (`giggly-brewing-moore.md`), PR-A wires `nestjs-pino`'s `LoggerModule`
 * inside a new `LoggingModule` (`../observability/logging.module.ts`, not
 * yet written) that `AppModule` imports, configured via a pure factory
 * `buildPinoHttpOptions(env)` so tests can reuse the exact same options with
 * a different `stream`.
 *
 * ============================== RESOLVED BY IMPLEMENTER
 * ==============================
 *
 * 1. `EXPECTED_REQUEST_ID_FIELD` was a placeholder. Verified against the
 *    installed `pino-http@11.0.0`'s `logger.js`: the default
 *    `customAttributeKeys.reqId` key IS literally `'reqId'` — the
 *    placeholder was correct, kept unchanged. What DOES need explicit
 *    configuration is *where* it's bound: pino-http's own default
 *    (`quietReqLogger: false`) never puts `reqId` at the top level at all
 *    (only nested at `req.id`, and only once a full `req` object gets
 *    logged). `logging.module.ts`'s `buildPinoHttpOptions` sets
 *    `quietReqLogger: true` (`quietResLogger: true` too) specifically so
 *    pino-http binds a lean `{ reqId: req.id }` onto every logger derived
 *    from the request — this is what makes `reqId` appear at the top level
 *    of every line, including ones produced by plain `new
 *    Logger(SomeClass.name)` calls (e.g. `AppErrorFilter`) via
 *    `nestjs-pino`'s `AsyncLocalStorage` propagation. Also: pino-http's
 *    default `genReqId` returns a sequential *number*, not a string —
 *    `buildPinoHttpOptions` overrides it with `crypto.randomUUID()` so the
 *    `typeof requestId).toBe('string')` assertions below hold.
 * 2. `.overrideModule(LoggingModule).useModule(...)` does work correctly
 *    with `nestjs-pino`'s `LoggerModule` — verified by an ad hoc script that
 *    boots the real `AppModule` this same way and inspects the captured
 *    stream. No change needed to the override mechanism itself.
 * 3. `app.useLogger(app.get(Logger))` is the correct call, but its ORDER
 *    relative to `app.init()` had to be corrected: calling it *before*
 *    `app.init()` (as originally written) routes Nest's own bootstrap-time
 *    log lines (route mapping, "Nest application successfully started" —
 *    none of which are tied to any HTTP request) into this test's
 *    collecting `stream` too, and those lines have no `reqId` — breaking
 *    the "every captured line has a requestId" assertion below for a reason
 *    unrelated to this test's actual subject. Calling `app.useLogger(...)`
 *    *after* `app.init()` (but still before any request is sent, which is
 *    all `main.ts`'s real ordering actually requires — `bufferLogs: true`
 *    there is what additionally makes bootstrap logs flow through pino in
 *    the real server, an effect this test deliberately avoids by not using
 *    `bufferLogs` here) keeps the captured stream limited to request-scoped
 *    lines only.
 */

const EXPECTED_REQUEST_ID_FIELD = 'reqId';
const PINO_WARN_LEVEL = 40;

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

  /** Parses everything captured so far as newline-delimited JSON log lines. */
  lines(): Record<string, unknown>[] {
    return this.chunks
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

describe('request logging + requestId propagation (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let stream: CollectingStream;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    await runMigrations(container.getConnectionUri());

    // AppModule (and the LoggingModule it imports) is built only after
    // DATABASE_URL is set, mirroring tenant-isolation.integration.test.ts.
    // NOTE for implementer: none of these three modules/packages exist yet
    // ('./logging.module.js', 'nestjs-pino') -- this test is expected to
    // fail with "Cannot find module" until PR-A's implementation lands.
    const { AppModule } = await import('../app.module.js');
    const { LoggingModule, buildPinoHttpOptions } = await import('./logging.module.js');
    const { Logger, LoggerModule } = await import('nestjs-pino');
    const { env } = await import('../config/env.js');

    stream = new CollectingStream();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideModule(LoggingModule)
      .useModule(
        LoggerModule.forRoot({
          pinoHttp: {
            ...buildPinoHttpOptions(env),
            stream,
          },
        }),
      )
      .compile();

    app = moduleRef.createNestApplication();
    // NOTE for implementer's future readers (corrected during PR-A
    // implementation): `app.useLogger()` is called *after* `app.init()`,
    // not before. `app.init()` itself emits Nest's own bootstrap-time log
    // lines (route mapping, "Nest application successfully started") which
    // are not tied to any HTTP request and therefore never carry a
    // requestId -- calling `useLogger()` first would route those lines into
    // this test's collecting `stream` too and break the "every captured
    // line has a requestId" assertion below on lines that were never meant
    // to have one. Calling it after `init()` (but still before any request
    // is sent) still satisfies main.ts's real intent: every request-time
    // `Logger`/`AppErrorFilter` call goes through pino from the first
    // request onward.
    await app.init();
    app.useLogger(app.get(Logger));
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  }, 60_000);

  it('a single request produces at least one log line, and every log line from it carries the same non-empty request-id field', async () => {
    const server: Server = app.getHttpServer() as Server;

    const response = await request(server).get('/health');
    expect(response.status).toBeLessThan(500);

    const lines = stream.lines();
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const requestId = line[EXPECTED_REQUEST_ID_FIELD];
      expect(typeof requestId).toBe('string');
      expect((requestId as string).length).toBeGreaterThan(0);
    }

    const uniqueRequestIds = new Set(lines.map((line) => line[EXPECTED_REQUEST_ID_FIELD]));
    expect(uniqueRequestIds.size).toBe(1);
  });

  it('two separate requests get different request-ids, and an error-branch log line (AppErrorFilter) inherits its own request id', async () => {
    const server: Server = app.getHttpServer() as Server;

    // `stream` is shared across the whole `describe` block (one real app,
    // one collecting stream, populated in `beforeAll`) -- the previous `it`
    // above already made a request against it, so `stream.lines()` at this
    // point also carries that earlier, unrelated request's line(s). Capture
    // this test's own starting offset so "lines produced by request 1 [of
    // THIS test]" doesn't accidentally include lines from a completely
    // different prior request (which would have its own distinct requestId
    // and break the "exactly one requestId" assertion below for a reason
    // that has nothing to do with this test's actual subject).
    const linesBeforeThisTest = stream.lines().length;

    // Request 1: a plain successful request establishes a baseline requestId.
    await request(server).get('/health');
    const linesAfterFirstRequest = stream.lines().slice(linesBeforeThisTest);
    const firstRequestIds = new Set(
      linesAfterFirstRequest.map((line) => line[EXPECTED_REQUEST_ID_FIELD]),
    );
    expect(firstRequestIds.size).toBe(1);
    const [firstRequestId] = [...firstRequestIds];

    // Request 2: a real wrong-password login, naturally throwing
    // UnauthorizedError (an AppError) and hitting AppErrorFilter's warn
    // branch -- the same scenario already exercised in
    // tenant-isolation.integration.test.ts's step 10.
    const loginResponse = await request(server)
      .post('/auth/login')
      .send({ email: 'nonexistent@example.com', password: 'definitely-wrong' });
    expect(loginResponse.status).toBe(401);

    const allLinesAfterSecondRequest = stream.lines().slice(linesBeforeThisTest);
    const secondRequestLines = allLinesAfterSecondRequest.slice(linesAfterFirstRequest.length);
    expect(secondRequestLines.length).toBeGreaterThan(0);

    const secondRequestIds = new Set(
      secondRequestLines.map((line) => line[EXPECTED_REQUEST_ID_FIELD]),
    );
    expect(secondRequestIds.size).toBe(1);
    const [secondRequestId] = [...secondRequestIds];

    // The core AC1 proof: a fresh request gets a fresh, distinct requestId.
    expect(secondRequestId).not.toBe(firstRequestId);

    // AppErrorFilter's `this.logger.warn(...)` call (see
    // ../common/app-error.filter.ts) must have produced a warn-level line
    // among this second request's captured lines, carrying the SAME
    // requestId as the rest of the request -- proving requestId context
    // propagates into Nest's `Logger`-wrapped filter/service code, not just
    // pino-http's own automatic access-log line.
    const warnLine = secondRequestLines.find((line) => line['level'] === PINO_WARN_LEVEL);
    expect(warnLine).toBeDefined();
    expect(warnLine?.[EXPECTED_REQUEST_ID_FIELD]).toBe(secondRequestId);
  });
});
