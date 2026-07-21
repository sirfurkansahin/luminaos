import { Inject, Module } from '@nestjs/common';

import { createDatabaseClient, type Database } from './client.js';
import { env } from '../config/env.js';

import type { OnModuleDestroy } from '@nestjs/common';

export const DATABASE_CONNECTION = 'DATABASE_CONNECTION';

@Module({
  providers: [
    {
      provide: DATABASE_CONNECTION,
      useFactory: (): Database => createDatabaseClient(env.databaseUrl),
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
