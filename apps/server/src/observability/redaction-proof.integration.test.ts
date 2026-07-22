import { Writable } from 'node:stream';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate.js';

import type { INestApplication, Type } from '@nestjs/common';

/** The minimal shape this test needs from nestjs-pino's `Logger`. */
interface MinimalPinoLogger {
  log(obj: unknown, msg?: string): void;
}

/**
 * Real, end-to-end integration test for F0-T8 PR-A's AC2: "Log çıktısında
 * e-posta/şifre/token asla düz görünmez (bilerek loglanmaya çalışılır,
 * maskelendiği kanıtlanır)."
 *
 * Same app-boot + log-capturing-stream setup as
 * `./request-logging.integration.test.ts` (see that file's header comment
 * for the open questions around `.overrideModule()` + nestjs-pino's
 * `LoggerModule` that implementer needs to verify). Duplicated here rather
 * than extracted into a shared helper: only two call sites exist, and this
 * subagent's write access is restricted to `*.test.ts`/`*.spec.ts` files, so
 * a shared non-test helper module could not be created even if desired.
 *
 * Unlike the requestId test, this one does not need to correlate multiple
 * log lines by an id -- it deliberately logs a single object containing an
 * email/password/token/nested-apiKey (and one deliberately-benign field) via
 * the app's real `Logger`, then inspects the raw captured bytes.
 *
 * ASSUMPTION FOR IMPLEMENTER: `app.get(Logger)` (the `Logger` class exported
 * by `nestjs-pino`) is assumed to be the idiomatic way to obtain a
 * `LoggerService`-compatible instance wired to the same pino/stream
 * configuration as the rest of the app, per nestjs-pino's own docs pattern
 * (`app.useLogger(app.get(Logger))`). If `logging.module.ts` exposes the
 * logger under a different token/pattern, update this test's lookup, not
 * its assertions.
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

const LEAKED_EMAIL = 'leak@example.com';
const LEAKED_PASSWORD = 'hunter2';
const LEAKED_TOKEN = 'abc123';
const LEAKED_NESTED_API_KEY = 'sk-live-xyz';
const BENIGN_NOTE = 'this is fine';
const REDACTED_MARKER = '[REDACTED]';

// `Logger`'s class reference (from `nestjs-pino`, not installed yet) is
// captured as a module-scoped variable here so both `beforeAll` (which needs
// it to call `app.useLogger(...)`) and the `it` block (which needs it to
// call `app.get(Logger)`) reference the exact same class/token — `app.get()`
// looks providers up by identity, so re-importing or guessing a different
// token here would silently resolve the wrong instance. Typed as
// `Type<MinimalPinoLogger>` (Nest's own class-token type) rather than `any`,
// per CLAUDE.md's "any yasak" rule -- the assignment from the dynamically
// imported (and, until implemented, unresolvable) `nestjs-pino` module is
// still flagged by `no-unsafe-assignment` below, which is expected/inherent
// until that module exists.
let LoggerClass: Type<MinimalPinoLogger>;

describe('PII redaction proof (real Postgres + real app Logger, via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let stream: CollectingStream;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    await runMigrations(container.getConnectionUri());

    // None of these three modules/packages exist yet
    // ('./logging.module.js', 'nestjs-pino') -- this test is expected to
    // fail with "Cannot find module" until PR-A's implementation lands.
    const { AppModule } = await import('../app.module.js');
    const { LoggingModule, buildPinoHttpOptions } = await import('./logging.module.js');
    const { Logger, LoggerModule } = await import('nestjs-pino');
    const { env } = await import('../config/env.js');

    LoggerClass = Logger;
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
    // for why `app.useLogger()` is called after (not before) `app.init()`:
    // `init()` itself emits Nest's bootstrap-time log lines through the
    // *default* console logger this way, keeping this test's collecting
    // `stream` limited to the single deliberate `logger.log(...)` call the
    // `it` block below makes.
    await app.init();
    app.useLogger(app.get(Logger));
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  }, 60_000);

  it('masks a deliberately-logged email/password/token/nested apiKey, while leaving a benign field in plain text', () => {
    const logger = app.get(LoggerClass);

    logger.log(
      {
        email: LEAKED_EMAIL,
        password: LEAKED_PASSWORD,
        token: LEAKED_TOKEN,
        nested: { apiKey: LEAKED_NESTED_API_KEY },
        note: BENIGN_NOTE,
      },
      'redaction-proof-test',
    );

    const output = stream.raw();

    // 1. None of the raw sensitive values ever appear in the captured
    // output, in any form.
    expect(output).not.toContain(LEAKED_EMAIL);
    expect(output).not.toContain(LEAKED_PASSWORD);
    expect(output).not.toContain(LEAKED_TOKEN);
    expect(output).not.toContain(LEAKED_NESTED_API_KEY);

    // 2. The values were masked, not silently dropped -- the AC's wording is
    // "maskelendiği kanıtlanır" (proven to be masked), not "proven to be
    // omitted". A `[REDACTED]` marker must be present for each sensitive
    // field that was logged.
    expect(output).toContain(REDACTED_MARKER);
    const redactedCount = output.split(REDACTED_MARKER).length - 1;
    expect(redactedCount).toBeGreaterThanOrEqual(4);

    // 3. Redaction is targeted, not an overly-broad "hide everything"
    // behavior -- a non-sensitive field logged alongside the sensitive ones
    // must still appear in plain text.
    expect(output).toContain(BENIGN_NOTE);
  });
});
