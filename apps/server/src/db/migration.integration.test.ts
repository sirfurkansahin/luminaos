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
 *
 * A migration doesn't necessarily `CREATE TABLE` at all — F1-T2 PR-C's
 * migration is a plain `ALTER TABLE ... ADD COLUMN` on an existing table
 * (`objects_view`), the first migration in this codebase to be column-only.
 * F1-T3's security-review follow-up migration is index-only (a partial
 * `CREATE UNIQUE INDEX` on `relations_view` backstopping the "at most one
 * active parent" rule at the DB level — no table or column change at all).
 * `getLastMigrationEffect` therefore parses `CREATE TABLE`,
 * `ALTER TABLE ... ADD COLUMN`, AND `CREATE [UNIQUE] INDEX` statements out of
 * the last migration's SQL, and the rollback test branches its assertions on
 * whichever the last migration actually did (table-count shrinkage,
 * column-disappearance, or index-disappearance, each on an otherwise
 * unchanged table set) rather than assuming every migration creates a table.
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

interface AddedColumn {
  table: string;
  column: string;
}

interface LastMigrationEffect {
  createdTables: string[];
  addedColumns: AddedColumn[];
  addedIndexes: string[];
  droppedNotNullColumns: AddedColumn[];
}

/**
 * Reads `meta/_journal.json` and the `.sql` file of the most recently
 * generated migration (the last entry in the journal), then extracts every
 * table that migration's `CREATE TABLE "tablename" (...)` statements
 * created, every `(table, column)` pair its
 * `ALTER TABLE "tablename" ADD COLUMN "columnname" ...` statements added,
 * every index name its `CREATE [UNIQUE] INDEX "indexname" ...` statements
 * created, AND every `(table, column)` pair its
 * `ALTER TABLE "tablename" ALTER COLUMN "columnname" DROP NOT NULL`
 * statements loosened. This is how the test learns, without any hardcoded
 * table/column/index name, what `runDownMigrations`'s single default
 * rollback step is expected to undo — whether that's whole tables, columns
 * on an existing table, indexes on an existing table, a `NOT NULL`
 * constraint (ADR-0014 §b: intentionally NOT re-imposed by the down script,
 * so this effect has no corresponding after-rollback assertion below, unlike
 * the other three), or (in principle) any combination in the same migration.
 */
function getLastMigrationEffect(): LastMigrationEffect {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')) as MigrationJournal;
  const lastEntry = journal.entries.at(-1);

  if (!lastEntry) {
    throw new Error('Migration journal has no entries; cannot determine the last migration.');
  }

  const sqlFilePath = path.join(MIGRATIONS_FOLDER, `${lastEntry.tag}.sql`);
  const sql = readFileSync(sqlFilePath, 'utf-8');

  const createdTables = [...sql.matchAll(/CREATE TABLE "(\w+)"/g)]
    .map((match) => match[1])
    .filter((tableName): tableName is string => tableName !== undefined);

  const addedColumns = [...sql.matchAll(/ALTER TABLE "(\w+)" ADD COLUMN "(\w+)"/g)]
    .map((match) => (match[1] && match[2] ? { table: match[1], column: match[2] } : undefined))
    .filter((entry): entry is AddedColumn => entry !== undefined);

  const addedIndexes = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX "(\w+)"/g)]
    .map((match) => match[1])
    .filter((indexName): indexName is string => indexName !== undefined);

  const droppedNotNullColumns = [
    ...sql.matchAll(/ALTER TABLE "(\w+)" ALTER COLUMN "(\w+)" DROP NOT NULL/g),
  ]
    .map((match) => (match[1] && match[2] ? { table: match[1], column: match[2] } : undefined))
    .filter((entry): entry is AddedColumn => entry !== undefined);

  if (
    createdTables.length === 0 &&
    addedColumns.length === 0 &&
    addedIndexes.length === 0 &&
    droppedNotNullColumns.length === 0
  ) {
    throw new Error(
      `Neither a "CREATE TABLE", an "ALTER TABLE ... ADD COLUMN", a "CREATE [UNIQUE] INDEX", nor an "ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL" statement was found in ${sqlFilePath}; the extraction regexes may no longer match the generated SQL format.`,
    );
  }

  return { createdTables, addedColumns, addedIndexes, droppedNotNullColumns };
}

async function getPublicTableNames(client: Client): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(TABLES_QUERY);
  return result.rows.map((row) => row.table_name);
}

async function getColumnNames(client: Client, tableName: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [tableName],
  );
  return result.rows.map((row) => row.column_name);
}

async function getIndexNames(client: Client): Promise<string[]> {
  const result = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
  );
  return result.rows.map((row) => row.indexname);
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

  it('rolls back the last migration and removes what it added', async () => {
    await runMigrations(connectionString);
    const tableNamesBeforeDown = await getPublicTableNames(client);

    // `runDownMigrations` defaults to reversing only the single most
    // recently applied migration. Rather than hardcoding which table(s)/
    // column(s) that touches (fragile — it changes every time a new
    // migration is added), derive it from the migrations folder itself:
    // whatever the actual last migration's own `.sql` file created/added is
    // what must be undone by the down step below.
    const effect = getLastMigrationEffect();

    const columnsBeforeDownByTable = new Map<string, string[]>(
      await Promise.all(
        effect.addedColumns.map(async ({ table }): Promise<[string, string[]]> => [
          table,
          await getColumnNames(client, table),
        ]),
      ),
    );

    const indexNamesBeforeDown = effect.addedIndexes.length > 0 ? await getIndexNames(client) : [];

    await runDownMigrations(connectionString);
    const tableNamesAfterDown = await getPublicTableNames(client);

    // The down step must never ADD a table that didn't exist before it ran.
    for (const tableName of tableNamesAfterDown) {
      expect(tableNamesBeforeDown).toContain(tableName);
    }

    if (effect.createdTables.length > 0) {
      // The last migration created whole table(s) — the down step must
      // strictly shrink the table count and remove exactly those tables.
      expect(tableNamesAfterDown.length).toBeLessThan(tableNamesBeforeDown.length);

      const removedTables = tableNamesBeforeDown.filter(
        (table) => !tableNamesAfterDown.includes(table),
      );

      expect(removedTables.length).toBeGreaterThan(0);
      for (const createdTable of effect.createdTables) {
        expect(removedTables).toContain(createdTable);
      }
    }

    if (effect.addedColumns.length > 0) {
      // The last migration only added column(s) to (an) already-existing
      // table(s) — the table set itself is unchanged, but each added column
      // must be gone from its table afterward.
      expect(tableNamesAfterDown).toEqual(tableNamesBeforeDown);

      for (const { table, column } of effect.addedColumns) {
        const columnsBeforeDown = columnsBeforeDownByTable.get(table) ?? [];
        const columnsAfterDown = await getColumnNames(client, table);

        expect(columnsBeforeDown).toContain(column);
        expect(columnsAfterDown).not.toContain(column);
      }
    }

    if (effect.addedIndexes.length > 0) {
      // The last migration added index(es). If it did NOT also create
      // whole table(s) (the `createdTables` branch above already asserted
      // the table-set shrinkage for that case, e.g. F1-T5's
      // `ai_usage_records` migration, which creates both a table and an
      // index in the same file), the table set itself must be unchanged —
      // only the index(es) should disappear.
      if (effect.createdTables.length === 0) {
        expect(tableNamesAfterDown).toEqual(tableNamesBeforeDown);
      }

      const indexNamesAfterDown = await getIndexNames(client);

      for (const indexName of effect.addedIndexes) {
        expect(indexNamesBeforeDown).toContain(indexName);
        expect(indexNamesAfterDown).not.toContain(indexName);
      }
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
