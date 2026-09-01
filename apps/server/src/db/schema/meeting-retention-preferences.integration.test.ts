import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  hasPostgresConstraintViolation,
  hasPostgresErrorCode,
} from '../../common/postgres-error.js';
import { createDatabaseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { meetingRetentionPreferences } from './meeting-retention-preferences.js';
import { workspaces } from './workspaces.js';

import type { Database } from '../client.js';

/**
 * F2-T14 PR1 (RED step) — `meeting_retention_preferences` table schema/
 * migration ONLY (ADR-0031 §a, `docs/adr/ADR-0031-toplanti-saklama-tercihi-
 * ve-aksiyon-onerisi.md`). This PR is deliberately narrow: no
 * `MeetingRetentionSweeperService`, no CRUD endpoint exist yet (those are
 * PR2+) — this file proves only that the table itself, its Postgres enum,
 * its workspace-uniqueness index, and its real FK to `workspaces` exist and
 * behave exactly as ADR-0031 §a's literal schema sketch specifies.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely, this
 * is ADR-0031 §a's schema sketch verbatim):
 *
 * `apps/server/src/db/schema/meeting-retention-preferences.ts` (new), exporting:
 *   - `meetingRetentionModeEnum` — Postgres enum `meeting_retention_mode`:
 *     `'recording-reference' | 'transcript-only' | 'summary-only'`.
 *   - `meetingRetentionPreferences` — `pgTable('meeting_retention_preferences', ...)`:
 *       - `id` uuid PK, `default(sql\`gen_random_uuid()\`)`.
 *       - `workspaceId` (`workspace_id`) uuid NOT NULL, a REAL FK to
 *         `workspaces.id` with `onDelete: 'cascade'` (unlike
 *         `meeting_details.objectId`'s FK-less `objects_view` reference —
 *         `workspaces` is a physical table, ADR-0031 Bağlam madde 2).
 *       - `mode` `meetingRetentionModeEnum` NOT NULL.
 *       - `updatedAt` (`updated_at`) timestamptz NOT NULL, `defaultNow()`.
 *     Index: `uniqueIndex('meeting_retention_preferences_workspace_id_idx').on(
 *     table.workspaceId)` — the "workspace-başına EN FAZLA bir satır" v0
 *     invariant (ADR-0031 §a), enforced at the DB level, not just application
 *     code.
 *   Plus an up+down migration (CLAUDE.md's "never a migration without a down
 *   script" rule — enforced automatically for every migration by
 *   `runMigrations`'s `assertEveryMigrationHasADownScript` check, already
 *   exercised generically by the existing `../migration.integration.test.ts`
 *   file, which needs NO changes for this PR).
 *
 * ----------------------------------------------------------------------------
 * HARNESS NOTE: mirrors `./meeting-details.integration.test.ts`'s (F2-T13
 * PR1) lean pattern exactly — no Nest app, no Redis container: a throwaway
 * Postgres 16 Testcontainer, `runMigrations`, then a plain Drizzle `Database`
 * client used directly (no HTTP, no DI container).
 *
 * `meetingRetentionPreferences` is imported TYPED from
 * `./meeting-retention-preferences.js` (a single, static, top-level import —
 * not queried via the raw `pg` driver) because that schema file's existence
 * and exact shape ARE this PR's primary deliverable. The invalid-enum-value
 * insert attempt (test 4 below) intentionally goes through the raw
 * `db.$client.query` escape hatch instead of the typed Drizzle insert
 * builder, since a real invalid enum literal is (correctly) not assignable
 * to the typed column at compile time — same rationale as
 * `./meeting-details.integration.test.ts`'s tests 5/6.
 *
 * A real `workspaces` row is seeded directly via `db.insert(workspaces)`
 * (no HTTP `/workspaces` call — this file never boots a Nest app) for every
 * test that needs a valid FK target; `workspaces.id`/`createdAt`/`updatedAt`
 * all have DB-level defaults, so only `name`/`slug` need supplying.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): this file fails at MODULE RESOLUTION time
 * (before any Testcontainer even starts) because `./meeting-retention-
 * preferences.js` does not exist yet — this is the first, unavoidable RED
 * signal. Once the schema file exists but before its migration is
 * generated/applied, the failure mode shifts to every test below rejecting
 * with a real Postgres error (`relation "meeting_retention_preferences" does
 * not exist`).
 * ============================================================================
 */

let workspaceSeedCounter = 0;

async function seedWorkspace(db: Database): Promise<string> {
  workspaceSeedCounter += 1;
  const [inserted] = await db
    .insert(workspaces)
    .values({
      name: `meeting-retention-preferences-test-workspace-${workspaceSeedCounter.toString()}`,
      slug: `mrp-test-ws-${Date.now().toString()}-${workspaceSeedCounter.toString()}-${Math.random().toString(36).slice(2)}`,
    })
    .returning();

  if (inserted === undefined) {
    throw new Error('Failed to seed a workspace row for the test.');
  }

  return inserted.id;
}

describe('F2-T14 PR1 (RED step): meeting_retention_preferences table schema/migration (real Postgres via Testcontainers, no Nest app)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  it('1. after migrations, "meeting_retention_preferences" exists with EXACTLY the columns ADR-0031 §a specifies (no more, no fewer)', async () => {
    const result = await db.$client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'meeting_retention_preferences'
       ORDER BY column_name`,
    );
    const columnNames = result.rows.map((row) => row.column_name).sort();

    expect(columnNames).toEqual(['id', 'mode', 'updated_at', 'workspace_id'].sort());
  });

  it('2. "mode" column is backed by a REAL Postgres enum type (meeting_retention_mode), not plain varchar/text', async () => {
    const result = await db.$client.query<{ column_name: string; udt_name: string }>(
      `SELECT column_name, udt_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'meeting_retention_preferences'
         AND column_name = 'mode'`,
    );

    expect(result.rows[0]?.udt_name).toBe('meeting_retention_mode');
  });

  it('3. nullability matches ADR-0031 §a exactly: workspaceId/mode/updatedAt all NOT NULL', async () => {
    const result = await db.$client.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'meeting_retention_preferences'`,
    );
    const nullableByColumn = new Map(
      result.rows.map((row) => [row.column_name, row.is_nullable === 'YES']),
    );

    expect(nullableByColumn.get('workspace_id')).toBe(false);
    expect(nullableByColumn.get('mode')).toBe(false);
    expect(nullableByColumn.get('updated_at')).toBe(false);
  });

  it('4. a valid insert with mode="recording-reference" succeeds', async () => {
    const workspaceId = await seedWorkspace(db);

    const [inserted] = await db
      .insert(meetingRetentionPreferences)
      .values({ workspaceId, mode: 'recording-reference' })
      .returning();

    expect(inserted).toBeDefined();
    expect(inserted?.workspaceId).toBe(workspaceId);
    expect(inserted?.mode).toBe('recording-reference');
    expect(inserted?.updatedAt).toBeInstanceOf(Date);
  });

  it('5. a valid insert with mode="transcript-only" succeeds', async () => {
    const workspaceId = await seedWorkspace(db);

    const [inserted] = await db
      .insert(meetingRetentionPreferences)
      .values({ workspaceId, mode: 'transcript-only' })
      .returning();

    expect(inserted?.mode).toBe('transcript-only');
  });

  it('6. a valid insert with mode="summary-only" succeeds', async () => {
    const workspaceId = await seedWorkspace(db);

    const [inserted] = await db
      .insert(meetingRetentionPreferences)
      .values({ workspaceId, mode: 'summary-only' })
      .returning();

    expect(inserted?.mode).toBe('summary-only');
  });

  it('7. an INVALID "mode" value (not in the meeting_retention_mode enum) is rejected by Postgres itself', async () => {
    const workspaceId = await seedWorkspace(db);

    await expect(
      db.$client.query(
        `INSERT INTO meeting_retention_preferences (workspace_id, mode) VALUES ($1, $2)`,
        [workspaceId, 'delete-everything'],
      ),
    ).rejects.toSatisfy((error: unknown) => hasPostgresErrorCode(error, '22P02'));
  });

  it('8. the workspace_id unique index is real: a second row for the SAME workspaceId fails with a uniqueness violation (ADR-0031 §a — workspace-başına en fazla bir satır)', async () => {
    const workspaceId = await seedWorkspace(db);

    await db.insert(meetingRetentionPreferences).values({ workspaceId, mode: 'transcript-only' });

    await expect(
      db.insert(meetingRetentionPreferences).values({ workspaceId, mode: 'summary-only' }),
    ).rejects.toSatisfy((error: unknown) =>
      hasPostgresConstraintViolation(error, 'meeting_retention_preferences_workspace_id_idx'),
    );
  });

  it('9. the workspaceId FK constraint is real: inserting with a non-existent workspaceId fails with a foreign-key violation', async () => {
    const nonExistentWorkspaceId = '00000000-0000-0000-0000-000000000000';

    await expect(
      db
        .insert(meetingRetentionPreferences)
        .values({ workspaceId: nonExistentWorkspaceId, mode: 'transcript-only' }),
    ).rejects.toSatisfy((error: unknown) => hasPostgresErrorCode(error, '23503'));
  });
});
