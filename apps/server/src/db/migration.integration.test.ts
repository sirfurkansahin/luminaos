import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * may ship all 4 tables in one migration or split them across several, and
 * further migrations may be appended after this test is written. Rather than
 * hardcoding any table name (which broke twice historically: once when
 * migration `0001` — `events` — was added, and again when migration `0002` —
 * the projection tables — was added), it derives "what the last migration
 * actually created" directly from `meta/_journal.json` and that migration's
 * own `.sql` file at test-run time. The rollback assertion is therefore
 * genuinely migration-layout-agnostic: it proves `runDownMigrations`
 * demonstrably reversed exactly what the real last migration created,
 * whatever that migration happens to be, now or in the future.
 */

const TABLES_QUERY = `
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
  ORDER BY table_name
`;

const EXPECTED_TABLES = ['memberships', 'sessions', 'users', 'workspaces'];

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.join(currentDir, 'migrations');
const JOURNAL_PATH = path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json');

interface MigrationJournalEntry {
  tag: string;
}

interface MigrationJournal {
  entries: MigrationJournalEntry[];
}

/**
 * Reads `meta/_journal.json` and the `.sql` file of the most recently
 * generated migration (the last entry in the journal), then extracts every
 * table name that migration's `CREATE TABLE "tablename" (...)` statements
 * created. This is how the test learns, without any hardcoded table name,
 * which tables `runDownMigrations`'s single default rollback step is
 * expected to remove.
 */
function getTablesCreatedByLastMigration(): string[] {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')) as MigrationJournal;
  const lastEntry = journal.entries.at(-1);

  if (!lastEntry) {
    throw new Error('Migration journal has no entries; cannot determine the last migration.');
  }

  const sqlFilePath = path.join(MIGRATIONS_FOLDER, `${lastEntry.tag}.sql`);
  const sql = readFileSync(sqlFilePath, 'utf-8');

  const tableNames = [...sql.matchAll(/CREATE TABLE "(\w+)"/g)]
    .map((match) => match[1])
    .filter((tableName): tableName is string => tableName !== undefined);

  if (tableNames.length === 0) {
    throw new Error(
      `No "CREATE TABLE" statements found in ${sqlFilePath}; the extraction regex may no longer match the generated SQL format.`,
    );
  }

  return tableNames;
}

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
    // and added nothing) — proof that `runDownMigrations` actually reversed
    // real migration state rather than being a no-op.
    expect(tableNamesAfterDown.length).toBeLessThan(tableNamesBeforeDown.length);
    for (const tableName of tableNamesAfterDown) {
      expect(tableNamesBeforeDown).toContain(tableName);
    }

    // `runDownMigrations` defaults to reversing only the single most
    // recently applied migration. Rather than hardcoding which table(s)
    // that is (fragile — it changes every time a new migration is added),
    // derive it from the migrations folder itself: whichever tables the
    // actual last migration's own `.sql` file created are the tables that
    // must have been removed by the down step.
    const removedTables = tableNamesBeforeDown.filter(
      (table) => !tableNamesAfterDown.includes(table),
    );
    const expectedRemovedTables = getTablesCreatedByLastMigration();

    expect(removedTables.length).toBeGreaterThan(0);
    for (const expectedRemovedTable of expectedRemovedTables) {
      expect(removedTables).toContain(expectedRemovedTable);
    }
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
