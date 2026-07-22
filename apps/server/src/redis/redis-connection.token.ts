/**
 * The Nest DI token for the shared ioredis client. Deliberately factored out
 * of `redis.module.ts` into its own zero-dependency module — mirrors
 * `db/database-connection.token.ts`'s exact reasoning: a consumer that only
 * needs this token for `@Inject(REDIS_CONNECTION)` must not be forced to
 * transitively pull in `redis.module.ts`'s top-level `env` import, which
 * validates `REDIS_URL` and calls `process.exit(1)` if it's missing — a real
 * Nest-app boot-time concern that has nothing to do with merely referencing
 * this constant.
 */
export const REDIS_CONNECTION = 'REDIS_CONNECTION';
