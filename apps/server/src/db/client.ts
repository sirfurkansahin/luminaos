import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema/index.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Creates a Drizzle client backed by a `pg` connection pool.
 *
 * The connection string is accepted as a parameter (rather than read
 * directly from `env` here) so both the running application and the
 * Testcontainers-driven integration tests can point it at different
 * Postgres instances.
 */
export function createDatabaseClient(connectionString: string): Database {
  const pool = new Pool({ connectionString });

  return drizzle(pool, { schema });
}
