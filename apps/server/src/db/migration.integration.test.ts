import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations, runDownMigrations } from './migrate.js';

/**
 * Real integration test: spins up a throwaway Postgres 16 container via
 * Testcontainers (no mocking) and proves that:
 *   1. `runMigrations` applies every migration in `src/db/migrations/`.
 *   2. `runDownMigrations` reverses the most recent migration using its
 *      paired hand-authored `down/*.down.sql` file (CLAUDE.md hard rule:
 *      every migration needs a working down script).
 *   3. The up/down cycle is actually reversible (re-applying restores state),
 *      not a one-way trapdoor.
 *
 * Test isolation strategy: each `it` block re-runs `runMigrations(uri)` at
 * its start (migrations are expected to be idempotent — applying an
 * already-applied migration is a no-op) rather than relying on execution
 * order/state leaking from a previous `it`. This keeps each test
 * independently readable and resilient to reordering, at the cost of a
 * little redundant work against the same container.
 *
 * Note on the rollback assertion: this test intentionally does not assume
 * which specific table(s) belong to "the last migration" — the implementer
 * may ship all 4 tables in one migration or split them across several. The
 * rollback test instead asserts, migration-layout-agnostically, that (a) the
 * table set strictly shrinks and (b) it's no longer the full expected set —
 * i.e. `runDownMigrations` demonstrably undid real schema state.
 */

const TABLES_QUERY = `
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
  ORDER BY table_name
`;

const EXPECTED_TABLES = ['memberships', 'sessions', 'users', 'workspaces'];

async function getPublicTableNames(client: Client): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(TABLES_QUERY);
  return result.rows.map((row) => row.table_name);
}

describe('database migrations (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let connectionString: string;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    connectionString = container.getConnectionUri();

    client = new Client({ connectionString });
    await client.connect();
  }, 60_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  }, 60_000);

  it('applies all migrations, creating the expected tables', async () => {
    await runMigrations(connectionString);

    const tableNames = await getPublicTableNames(client);

    for (const expectedTable of EXPECTED_TABLES) {
      expect(tableNames).toContain(expectedTable);
    }
  }, 30_000);

  it('rolls back the last migration and removes its tables', async () => {
    await runMigrations(connectionString);
    const tableNamesBeforeDown = await getPublicTableNames(client);

    await runDownMigrations(connectionString);
    const tableNamesAfterDown = await getPublicTableNames(client);

    // The down step must strictly shrink the schema (it removed something,
    // and added nothing) and must leave the schema short of the full
    // expected set — proof that `runDownMigrations` actually reversed real
    // migration state rather than being a no-op.
    expect(tableNamesAfterDown.length).toBeLessThan(tableNamesBeforeDown.length);
    for (const tableName of tableNamesAfterDown) {
      expect(tableNamesBeforeDown).toContain(tableName);
    }
    expect(EXPECTED_TABLES.every((table) => tableNamesAfterDown.includes(table))).toBe(false);
  }, 30_000);

  it('re-applying migrations after a rollback restores the tables', async () => {
    await runMigrations(connectionString);
    await runDownMigrations(connectionString);

    await runMigrations(connectionString);

    const tableNames = await getPublicTableNames(client);

    for (const expectedTable of EXPECTED_TABLES) {
      expect(tableNames).toContain(expectedTable);
    }
  }, 30_000);
});
