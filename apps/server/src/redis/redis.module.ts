import { Inject, Logger, Module } from '@nestjs/common';

import { createRedisClient } from './redis-client.js';
import { REDIS_CONNECTION } from './redis-connection.token.js';
import { env } from '../config/env.js';

import type { OnModuleDestroy } from '@nestjs/common';
// Named import, not default: see `redis-client.ts`'s doc comment for why
// the default import resolves to the whole module namespace (`TS2709`)
// under this repo's `module`/`moduleResolution: NodeNext`.
import type { Redis } from 'ioredis';

export { REDIS_CONNECTION };

const logger = new Logger('RedisModule');

/**
 * Mirrors `db/db.module.ts`'s `logUnhandledPoolErrors` — for consistency,
 * not crash-prevention: ioredis's own default error path (`silentEmit`)
 * already checks for listeners before emitting and falls back to its own
 * `console.error` rather than throwing, so this isn't required to avoid a
 * crash. It exists so a live Redis connection error is funneled through the
 * structured pino pipeline (PR-A) — the one thing ioredis's own raw
 * `console.error` fallback bypasses — instead of being the sole remaining
 * unstructured-output path in the app. Deliberately STATIC (non-
 * interpolated) message, same reasoning as the DB counterpart: never log a
 * raw error's `.message`/`.stack`, which could carry connection-string-
 * shaped content.
 */
function logUnhandledRedisErrors(redis: Redis): void {
  redis.on('error', () => {
    logger.warn('Redis client reported a connection error.');
  });
}

@Module({
  providers: [
    {
      provide: REDIS_CONNECTION,
      useFactory: (): Redis => {
        const redis = createRedisClient(env.redisUrl);
        logUnhandledRedisErrors(redis);
        return redis;
      },
    },
  ],
  exports: [REDIS_CONNECTION],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  // Closes the underlying ioredis connection when Nest tears the module
  // down (e.g. `app.close()` in tests) — mirrors `DbModule`'s
  // `onModuleDestroy`, which closes the `pg` pool for the same reason.
  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
