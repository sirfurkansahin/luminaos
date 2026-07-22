import { Inject, Logger, Module } from '@nestjs/common';

import { createDatabaseClient, type Database } from './client.js';
import { DATABASE_CONNECTION } from './database-connection.token.js';
import { env } from '../config/env.js';
import { TRACER, TracingModule } from '../observability/tracing.module.js';

import type { OnModuleDestroy } from '@nestjs/common';
import type { Tracer } from '@opentelemetry/api';

export { DATABASE_CONNECTION };

const logger = new Logger('DbModule');

/**
 * Attaches an `error` listener to the pool's underlying `pg.Pool`.
 *
 * `pg.Pool` forwards any error from a client it manages — including one that
 * occurs on a client with an ACTIVE query, not just an idle one — as an
 * `error` event on the pool itself. Node's `EventEmitter` throws
 * (`uncaughtException`) when an `error` event has zero listeners, which
 * otherwise crashes the whole process the moment the underlying Postgres
 * connection is torn down abruptly (e.g. a live connection drop in
 * production, or F0-T8 PR-C's `health.integration.test.ts` AC4 test — the
 * first in this codebase to stop a Testcontainers Postgres container WHILE
 * the app is still live/serving).
 *
 * The listener logs a single, deliberately STATIC (non-interpolated)
 * warning — never the raw `error.message`/`.stack`, which could carry
 * connection-string-shaped content (CLAUDE.md: never log raw error content
 * for non-`AppError`s, same reasoning as `AppErrorFilter`). This is a
 * signal for operators, not a duplicate of the actual failure handling:
 * the query that triggered the error is *separately* surfaced to its
 * caller through the normal rejected promise (which `HealthService`'s
 * `withTimeout`-wrapped probe already catches and reports as `checks.db:
 * 'error'`).
 */
function logUnhandledPoolErrors(db: Database): void {
  db.$client.on('error', () => {
    logger.warn('Postgres pool reported a client-level error.');
  });
}

@Module({
  imports: [TracingModule],
  providers: [
    {
      provide: DATABASE_CONNECTION,
      useFactory: (tracer: Tracer): Database => {
        const db = createDatabaseClient(env.databaseUrl, tracer);
        logUnhandledPoolErrors(db);
        return db;
      },
      inject: [TRACER],
    },
  ],
  exports: [DATABASE_CONNECTION],
})
export class DbModule implements OnModuleDestroy {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  // Closes the underlying `pg` Pool when Nest tears the module down (e.g.
  // `app.close()` in tests). Without this the pool's sockets stay open after
  // the app shuts down, racing against Testcontainers' `container.stop()`
  // and surfacing as an unhandled "terminating connection due to
  // administrator command" error from the driver.
  async onModuleDestroy(): Promise<void> {
    await this.db.$client.end();
  }
}
