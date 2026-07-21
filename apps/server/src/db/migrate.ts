import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { MigrationIntegrityError } from './migration-integrity.error.js';

// Re-exported here so callers (and the integration test suite) can import
// both migration directions from a single module, while the down-migration
// implementation itself still lives in its own file (and is independently
// runnable as `tsx src/db/migrate-down.ts`).
export { runDownMigrations } from './migrate-down.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.join(currentDir, 'migrations');
const DOWN_FOLDER = path.join(MIGRATIONS_FOLDER, 'down');

/**
 * Verifies that every migration `.sql` file (excluding the `meta/` folder
 * that drizzle-kit generates) has a matching hand-authored down script.
 * This operationalizes CLAUDE.md's hard rule: "never write a migration
 * without a down script." Fails fast rather than silently proceeding.
 */
function assertEveryMigrationHasADownScript(): void {
  if (!existsSync(MIGRATIONS_FOLDER)) {
    return;
  }

  const migrationFiles = readdirSync(MIGRATIONS_FOLDER).filter((file) => file.endsWith('.sql'));

  const missingDownScripts = migrationFiles.filter((file) => {
    const migrationName = file.replace(/\.sql$/, '');
    const downFilePath = path.join(DOWN_FOLDER, `${migrationName}.down.sql`);
    return !existsSync(downFilePath);
  });

  if (missingDownScripts.length > 0) {
    throw new MigrationIntegrityError(
      `The following migrations are missing a paired down script in ${DOWN_FOLDER}: ${missingDownScripts.join(', ')}`,
    );
  }
}

export async function runMigrations(connectionString: string): Promise<void> {
  assertEveryMigrationHasADownScript();

  const pool = new Pool({ connectionString });

  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const { env } = await import('../config/env.js');
  await runMigrations(env.databaseUrl);
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(`Migration failed: ${String(error)}\n`);
      process.exit(1);
    });
}
