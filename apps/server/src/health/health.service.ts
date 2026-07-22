import type { HealthCheckPayload } from '@luminaos/shared';

import { SERVER_VERSION } from './version.js';

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Structural (not the real Drizzle `Database`/`ioredis` `Redis` types) --
 * `HealthService` only ever needs to know how to ask each dependency "are
 * you alive", so it depends on the narrowest shape that lets it do that.
 * Both the real production types are structurally assignable to these, so
 * `health.module.ts` can wire the real `DATABASE_CONNECTION`/
 * `REDIS_CONNECTION` instances straight through with zero adapter code.
 */
export interface HealthDatabaseProbe {
  execute(query: unknown): Promise<unknown>;
}

export interface HealthRedisProbe {
  ping(): Promise<string>;
}

export interface HealthServiceOptions {
  /**
   * Upper bound, in milliseconds, each individual probe (db OR redis) is
   * allowed to take before being treated as failed ('error') even if its
   * underlying promise never settles. Defaults to 2000.
   */
  timeoutMs?: number;
}

type ProbeStatus = 'ok' | 'error';

/**
 * Races `promise` against a timer -- if `promise` neither resolves nor
 * rejects within `timeoutMs`, the returned promise rejects instead of
 * staying pending forever. This is what lets `HealthService.check()` always
 * resolve, even when a DB/Redis connection has hung rather than cleanly
 * failed (e.g. a stopped container that never sends a TCP RST).
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs.toString()}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function probeDatabase(db: HealthDatabaseProbe, timeoutMs: number): Promise<ProbeStatus> {
  try {
    await withTimeout(db.execute('SELECT 1'), timeoutMs);
    return 'ok';
  } catch {
    return 'error';
  }
}

async function probeRedis(redis: HealthRedisProbe, timeoutMs: number): Promise<ProbeStatus> {
  try {
    await withTimeout(redis.ping(), timeoutMs);
    return 'ok';
  } catch {
    return 'error';
  }
}

/**
 * Plain, framework-agnostic-shaped class -- Nest wiring (the real
 * `Database`/`ioredis` clients, injected via `@Inject(DATABASE_CONNECTION)`/
 * `@Inject(REDIS_CONNECTION)`) is `health.module.ts`'s job, not this class's.
 */
export class HealthService {
  private readonly timeoutMs: number;

  constructor(
    private readonly db: HealthDatabaseProbe,
    private readonly redis: HealthRedisProbe,
    options?: HealthServiceOptions,
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async check(): Promise<HealthCheckPayload> {
    // `Promise.allSettled` (rather than `Promise.all`) so one probe's
    // failure never short-circuits the other -- both `withTimeout`-wrapped
    // probe functions above already never reject (they catch internally and
    // resolve to 'error'), so every settlement here is always 'fulfilled' in
    // practice; `allSettled` is used anyway as defense-in-depth against a
    // future probe function that might reject directly.
    const [dbResult, redisResult] = await Promise.allSettled([
      probeDatabase(this.db, this.timeoutMs),
      probeRedis(this.redis, this.timeoutMs),
    ]);

    const db: ProbeStatus = dbResult.status === 'fulfilled' ? dbResult.value : 'error';
    const redis: ProbeStatus = redisResult.status === 'fulfilled' ? redisResult.value : 'error';

    const status: HealthCheckPayload['status'] = db === 'ok' && redis === 'ok' ? 'ok' : 'degraded';

    return { status, checks: { db, redis }, version: SERVER_VERSION };
  }
}
