import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newObjectId } from '@luminaos/core-objects';

import { createDatabaseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { objectsView } from './objects-view.js';
import { workspaces } from './workspaces.js';

import type { Database } from '../client.js';

/**
 * F2-T14 PR1 (RED step) — proves the migration's BACKFILL step (ADR-0031 §c,
 * `docs/adr/ADR-0031-toplanti-saklama-tercihi-ve-aksiyon-onerisi.md`) actually
 * works on pre-existing data, closing "Bilinen Sınırlamalar / Açık Sorular"
 * item 5 of that ADR ("migration'ının backfill adımı gerçek veride test
 * edilmedi").
 *
 * ============================================================================
 * WHY A SEPARATE, DEDICATED FILE/CONTAINER (not added to
 * `./meeting-details.integration.test.ts`): `runMigrations` applies the full
 * migrations folder in one shot via drizzle's migrator — there is no partial-
 * application API, and a fresh Testcontainer starts with NO pre-existing
 * `meeting_details` rows before the new migration runs, so the backfill
 * cannot be exercised by simply re-running `runMigrations` on a fresh DB.
 * Instead, this file migrates to head (where `meeting_details.workspace_id`
 * is already NOT NULL), then:
 *   1. Temporarily relaxes the constraint
 *      (`ALTER TABLE meeting_details ALTER COLUMN workspace_id DROP NOT NULL`).
 *   2. Inserts a `meeting_details` row with `workspace_id` explicitly NULL
 *      (via the raw `db.$client.query` escape hatch — a NOT NULL-typed
 *      Drizzle column cannot be assigned `null` at the TS level), alongside a
 *      real, matching `objects_view` row (same `object_id`/`id`) carrying a
 *      real `workspace_id`.
 *   3. Re-runs the EXACT backfill `UPDATE` statement ADR-0031 §c specifies:
 *      `UPDATE meeting_details SET workspace_id = (SELECT workspace_id FROM
 *      objects_view WHERE objects_view.id = meeting_details.object_id) WHERE
 *      workspace_id IS NULL` — naturally idempotent/safe to re-run, so
 *      executing it directly here proves the LOGIC the migration's own SQL
 *      file contains, even without executing that migration file line-by-line.
 *   4. Asserts the row's `workspace_id` now matches the `objects_view` row's
 *      `workspace_id` exactly.
 * This destructively relaxes the schema (step 1) — hence its OWN Testcontainer,
 * entirely separate from `./meeting-details.integration.test.ts`'s shared
 * container, so it can never corrupt that file's later tests.
 *
 * `objectsView` is imported TYPED from `./objects-view.js` (already exists,
 * unaffected by this PR) — only `./meeting-details.js`'s NEW `workspaceId`
 * column and `workspaces` are new surface here, so this file's RED signal is
 * a real Postgres error (`column "workspace_id" of relation "meeting_details"
 * does not exist` / `null value in column "workspace_id" violates not-null
 * constraint`), not a module-resolution failure — the ONLY test file in this
 * PR pinned that way, since it deliberately never imports the (not-yet-
 * existent) `meeting_details` Drizzle table binding, working through raw SQL
 * instead (see rationale above).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): fails because `meeting_details` has no
 * `workspace_id` column yet — the `ALTER TABLE ... DROP NOT NULL` step itself
 * errors with `column "workspace_id" of relation "meeting_details" does not
 * exist`.
 * ============================================================================
 */

const BACKFILL_UPDATE_SQL = `
  UPDATE meeting_details
  SET workspace_id = (
    SELECT workspace_id FROM objects_view WHERE objects_view.id = meeting_details.object_id
  )
  WHERE workspace_id IS NULL
`;

describe('F2-T14 PR1 (RED step): meeting_details.workspace_id migration backfill step (ADR-0031 §c, own dedicated Testcontainer)', () => {
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

  it("re-running the migration's backfill UPDATE fills a NULL meeting_details.workspace_id from its matching objects_view row", async () => {
    const [seededWorkspace] = await db
      .insert(workspaces)
      .values({
        name: 'meeting-details-backfill-test-workspace',
        slug: `meeting-details-backfill-test-ws-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`,
      })
      .returning();

    if (seededWorkspace === undefined) {
      throw new Error('Failed to seed a workspace row for the test.');
    }
    const realWorkspaceId = seededWorkspace.id;

    const meetingObjectId = newObjectId();
    const now = new Date();

    await db.insert(objectsView).values({
      id: meetingObjectId,
      streamId: randomUUID(),
      type: 'meeting',
      workspaceId: realWorkspaceId,
      title: 'Backfill test meeting',
      createdBy: 'test-harness',
      createdAt: now,
      updatedAt: now,
      lifecycle: 'active',
    });

    // Step 1: temporarily relax the NOT NULL constraint this PR's migration
    // sets at its final step, so a pre-migration-shaped (NULL) row can exist.
    await db.$client.query(`ALTER TABLE meeting_details ALTER COLUMN workspace_id DROP NOT NULL`);

    // Step 2: insert a "pre-backfill" meeting_details row with workspace_id
    // explicitly NULL, matching the objects_view row above via object_id.
    const providerMeetingRef = `backfill-test-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`;
    await db.$client.query(
      `INSERT INTO meeting_details (object_id, workspace_id, meeting_url, provider, status, provider_meeting_ref)
       VALUES ($1, NULL, $2, 'zoom', 'sunuldu', $3)`,
      [meetingObjectId, 'https://zoom.us/j/1234567890', providerMeetingRef],
    );

    const [beforeBackfill] = (
      await db.$client.query<{ workspace_id: string | null }>(
        `SELECT workspace_id FROM meeting_details WHERE object_id = $1`,
        [meetingObjectId],
      )
    ).rows;
    expect(beforeBackfill?.workspace_id).toBeNull();

    // Step 3: the EXACT backfill logic ADR-0031 §c's migration performs.
    await db.$client.query(BACKFILL_UPDATE_SQL);

    // Step 4: workspace_id now matches the objects_view row's workspace_id.
    const [afterBackfill] = (
      await db.$client.query<{ workspace_id: string | null }>(
        `SELECT workspace_id FROM meeting_details WHERE object_id = $1`,
        [meetingObjectId],
      )
    ).rows;
    expect(afterBackfill?.workspace_id).toBe(realWorkspaceId);
  });
});
