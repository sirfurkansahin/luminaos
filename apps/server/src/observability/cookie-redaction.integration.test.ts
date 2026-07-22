import { Writable } from 'node:stream';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate.js';

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * Regression test for a session-cookie leak in pino-http's *automatic*
 * "request completed" access-log line — distinct from, and not covered by,
 * either of this PR's other two tests:
 *
 * - `request-logging.integration.test.ts` proves `reqId` propagation, not
 *   redaction.
 * - `redaction-proof.integration.test.ts` proves `formatters.log()` masks a
 *   *deliberately, manually* logged `{email, password, token, ...}` object —
 *   a plain object literal the app code itself constructs and passes to
 *   `logger.log(...)`.
 *
 * Neither exercises pino-http's own automatic access-log line, which is
 * produced for *every* HTTP response regardless of app code, and which
 * attaches the raw Node `res` object (not yet run through pino's `res`
 * serializer) to the log call. Per `logging.module.ts`'s own doc comment and
 * `redact.ts`'s doc comment: `formatters.log()`'s redaction walker only
 * recurses into plain object literals (`isPlainObject()`); at the point
 * `formatters.log` runs, the raw `res` object is NOT a plain object literal
 * (pino's `res` serializer, which produces the plain `{statusCode, headers}`
 * shape, runs AFTER `formatters.log` — verified in that file's comment), so
 * the walker treats it as an opaque leaf and never looks inside
 * `res.headers`. Separately, `redact.paths` only lists
 * `req.headers.authorization` / `req.headers.cookie` (incoming request
 * headers) — nothing on the response side (`res.headers['set-cookie']`) is
 * covered by either mechanism.
 *
 * Net effect: the real session cookie value (`Set-Cookie`'s `sid=<uuid>`
 * pair — a bearer credential) set by `POST /auth/register` /
 * `POST /auth/login` is emitted in plain text inside pino-http's own
 * "request completed" line, in every captured log stream, on every such
 * request.
 *
 * This test is EXPECTED TO FAIL against the current (buggy)
 * `logging.module.ts` / `redact.ts` — the "cookie must not appear in logs"
 * assertion below is false today. It should start passing once the fix adds
 * response-side cookie redaction (e.g. a `res.headers['set-cookie']`
 * `redact.paths` entry, or a `res` serializer override), without needing any
 * change to this test file.
 *
 * Same Testcontainers Postgres + `.overrideModule(LoggingModule).useModule(
 * LoggerModule.forRoot({...}))` + `app.useLogger(app.get(Logger))`-after-
 * `app.init()` setup as the other two tests in this PR (see
 * `request-logging.integration.test.ts`'s header comment for the full
 * rationale behind that ordering) — kept in its own file rather than
 * appended to `redaction-proof.integration.test.ts` because this test needs
 * a real HTTP request/response round-trip (via `supertest`) to obtain a real,
 * server-issued `Set-Cookie` header, whereas `redaction-proof...` only ever
 * calls `logger.log(...)` directly and never sends an HTTP request at all.
 */

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

  /** The full raw captured output so far, as a single string. */
  raw(): string {
    return this.chunks.join('');
  }
}

const REGISTER_PAYLOAD = {
  email: 'cookie-leak-check@example.com',
  password: 'correct-horse-battery',
};

/**
 * Extracts the first `name=value` pair (e.g. `sid=f81b0039-...`) from a
 * `Set-Cookie` response header, without assuming the session cookie's name —
 * mirrors `tenant-isolation.integration.test.ts`'s `toCookieHeader` helper,
 * but returns only the first cookie's bare pair (not a full `Cookie` request
 * header) since this test needs the exact substring to search the log
 * output for, not a value to send back on a follow-up request.
 */
function extractSessionCookiePair(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);

  const [firstCookie] = setCookie ?? [];
  expect(firstCookie).toBeDefined();

  const pair = (firstCookie ?? '').split(';')[0]?.trim();
  expect(pair).toBeDefined();
  expect(pair?.length).toBeGreaterThan(0);
  expect(pair).toContain('=');

  return pair ?? '';
}

describe('session cookie redaction in pino-http access logs (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let stream: CollectingStream;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    await runMigrations(container.getConnectionUri());

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
    // See ../observability/request-logging.integration.test.ts's beforeAll
    // for why `app.useLogger()` is called after (not before) `app.init()`.
    await app.init();
    app.useLogger(app.get(Logger));
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  }, 60_000);

  it('the raw session-id issued by POST /auth/register never appears in captured log output, while the response status code still does', async () => {
    const server: Server = app.getHttpServer() as Server;

    // A real, naturally-occurring log event: pino-http's own automatic
    // "request completed" access-log line fires on every real response
    // regardless of app code -- nothing here manually constructs or logs a
    // synthetic object.
    const registerResponse = await request(server).post('/auth/register').send(REGISTER_PAYLOAD);

    expect(registerResponse.status).toBe(201);

    const sessionCookiePair = extractSessionCookiePair(registerResponse.get('Set-Cookie'));
    const sessionIdValue = sessionCookiePair.split('=').slice(1).join('=');
    expect(sessionIdValue.length).toBeGreaterThan(0);

    const output = stream.raw();
    expect(output.length).toBeGreaterThan(0);

    // THE REGRESSION: neither the full `sid=<uuid>` pair nor the bare
    // session-id value itself (a live bearer credential, equivalent to an
    // API token) may appear anywhere in the raw captured log text -- not
    // just inside a `Set-Cookie` header field, but anywhere at all (e.g. it
    // must not leak via some other serialized path either).
    expect(output).not.toContain(sessionCookiePair);
    expect(output).not.toContain(sessionIdValue);

    // Completeness check: the fix must be a TARGETED redaction of the cookie
    // value, not a wholesale removal of all `res` logging -- the response's
    // real status code must still be observable in the captured logs.
    expect(output).toContain(`"statusCode":${String(registerResponse.status)}`);
  }, 60_000);
});
