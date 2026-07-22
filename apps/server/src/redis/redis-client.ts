import { Redis } from 'ioredis';

/**
 * Creates an `ioredis` client for the given connection string.
 *
 * The connection string is accepted as a parameter (rather than read
 * directly from `env` here) so both the running application and any
 * Testcontainers-driven integration tests can point it at different Redis
 * instances — mirrors `db/client.ts`'s `createDatabaseClient` exactly.
 *
 * Imported as the named `{ Redis }` export (not the default export):
 * `ioredis`'s type declarations re-export the `Redis` class through a chain
 * (`export { default } from './Redis'` + `export { default as Redis } from
 * './Redis'`) that, under this repo's `module`/`moduleResolution: NodeNext`
 * (no `exports` field in `ioredis`'s own `package.json`, so TypeScript treats
 * its `.d.ts` as CommonJS-implied-format), makes the DEFAULT import resolve
 * to the whole module namespace rather than the `Redis` class itself (`TS2709
 * Cannot use namespace 'Redis' as a type`) — the named import does not hit
 * that resolution quirk.
 */
export function createRedisClient(url: string): Redis {
  return new Redis(url);
}
