import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import { MigrationIntegrityError } from './migration-integrity.error.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.join(currentDir, 'migrations');
const DOWN_FOLDER = path.join(MIGRATIONS_FOLDER, 'down');
const JOURNAL_PATH = path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json');

const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations';

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

interface Journal {
  entries: JournalEntry[];
}

interface AppliedMigrationRow {
  id: number;
  hash: string;
  created_at: string;
}

function readJournal(): Journal {
  if (!existsSync(JOURNAL_PATH)) {
    throw new MigrationIntegrityError(`Cannot find migrations journal at ${JOURNAL_PATH}`);
  }

  return JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8')) as Journal;
}

function splitStatements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Reverses the most recently applied `steps` migrations (most recent first),
 * each via its paired hand-authored `down/*.down.sql` script, then removes
 * the corresponding row from drizzle's own migrations-tracking table so a
 * subsequent `runMigrations` re-applies it cleanly.
 */
export async function runDownMigrations(connectionString: string, steps = 1): Promise<void> {
  const journal = readJournal();
  const pool = new Pool({ connectionString });

  try {
    const trackingTableExists = await pool.query<{ exists: boolean }>(
      `select exists (
         select 1 from information_schema.tables
         where table_schema = $1 and table_name = $2
       ) as "exists"`,
      [MIGRATIONS_SCHEMA, MIGRATIONS_TABLE],
    );

    if (!trackingTableExists.rows[0]?.exists) {
      return;
    }

    const appliedResult = await pool.query<AppliedMigrationRow>(
      `select id, hash, created_at from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" order by created_at desc limit $1`,
      [steps],
    );

    for (const appliedMigration of appliedResult.rows) {
      const createdAtMillis = Number(appliedMigration.created_at);
      const journalEntry = journal.entries.find((entry) => entry.when === createdAtMillis);

      if (!journalEntry) {
        throw new MigrationIntegrityError(
          `Applied migration with created_at=${String(createdAtMillis)} has no matching entry in ${JOURNAL_PATH}`,
        );
      }

      const downFilePath = path.join(DOWN_FOLDER, `${journalEntry.tag}.down.sql`);

      if (!existsSync(downFilePath)) {
        throw new MigrationIntegrityError(
          `Missing down script for migration "${journalEntry.tag}": ${downFilePath}`,
        );
      }

      const downSql = readFileSync(downFilePath, 'utf-8');
      const statements = splitStatements(downSql);

      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        for (const statement of statements) {
          await client.query(statement);
        }
        await client.query(
          `delete from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" where id = $1`,
          [appliedMigration.id],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const { env } = await import('../config/env.js');
  await runDownMigrations(env.databaseUrl);
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(`Rollback failed: ${String(error)}\n`);
      process.exit(1);
    });
}
