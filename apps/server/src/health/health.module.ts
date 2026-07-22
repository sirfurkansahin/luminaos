import { Inject, Module } from '@nestjs/common';

import { HealthService } from './health.service.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { DbModule } from '../db/db.module.js';
import { REDIS_CONNECTION } from '../redis/redis-connection.token.js';
import { RedisModule } from '../redis/redis.module.js';

import type { HealthDatabaseProbe, HealthRedisProbe } from './health.service.js';
import type { Database } from '../db/client.js';
// Named import, not default: see `redis/redis-client.ts`'s doc comment for
// why the default import resolves to the whole module namespace (`TS2709`)
// under this repo's `module`/`moduleResolution: NodeNext`.
import type { Redis } from 'ioredis';

@Module({
  imports: [DbModule, RedisModule],
  providers: [
    {
      provide: HealthService,
      useFactory: (db: HealthDatabaseProbe, redis: HealthRedisProbe): HealthService =>
        new HealthService(db, redis),
      inject: [DATABASE_CONNECTION, REDIS_CONNECTION],
    },
  ],
  exports: [HealthService],
})
export class HealthModule {
  // Referenced only for its `@Inject` decorator parameter types below, to
  // keep the real Drizzle `Database`/`ioredis` `Redis` types imported and
  // structurally checked against `HealthDatabaseProbe`/`HealthRedisProbe`
  // at compile time (mirrors `DbModule`'s own constructor-injection style).
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly _db: Database,
    @Inject(REDIS_CONNECTION) private readonly _redis: Redis,
  ) {}
}
