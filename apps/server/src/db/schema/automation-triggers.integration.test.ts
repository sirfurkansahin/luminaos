import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasPostgresErrorCode } from '../../common/postgres-error.js';
import { createDatabaseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { automationTriggerMatches } from './automation-trigger-matches.js';
import { automationTriggers } from './automation-triggers.js';
import { workspaces } from './workspaces.js';

import type { Database } from '../client.js';

/**
 * F2-T15 PR1 (RED step) — `automation_triggers` + `automation_trigger_matches`
 * table schema/migration ONLY (ADR-0032 Şema Taslağı,
 * `docs/adr/ADR-0032-tetikleyici-kosul-aksiyon-cekirdegi.md`). This PR is
 * deliberately narrow: no `AutomationTriggersService`/controller/projection
 * exist yet (those are PR2+) — this file proves only that both tables exist
 * and behave exactly as ADR-0032's literal schema sketch specifies.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely, this
 * is ADR-0032's schema sketch verbatim):
 *
 * `apps/server/src/db/schema/automation-triggers.ts` (new), exporting
 * `automationTriggers` — `pgTable('automation_triggers', ...)`:
 *   - `id` varchar(26) PK (a ULID, business identity).
 *   - `streamId` (`stream_id`) uuid NOT NULL UNIQUE.
 *   - `workspaceId` (`workspace_id`) uuid NOT NULL, a REAL FK to
 *     `workspaces.id` with `onDelete: 'cascade'`.
 *   - `kind` varchar(20) NOT NULL (`'scheduled' | 'condition'`).
 *   - `spec` jsonb NOT NULL (discriminated `ScheduleSpec | ConditionSpec`).
 *   - `lastFiredAt` (`last_fired_at`) timestamptz, NULLABLE (only
 *     'scheduled' triggers use it).
 *   - `lifecycle` varchar(20) NOT NULL, `default('active')`.
 *   - `createdAt`/`updatedAt` (`created_at`/`updated_at`) timestamptz NOT
 *     NULL.
 *   Indexes: `(workspace_id, lifecycle)` and `(workspace_id, kind, lifecycle)`.
 *
 * `apps/server/src/db/schema/automation-trigger-matches.ts` (new), exporting
 * `automationTriggerMatches` — `pgTable('automation_trigger_matches', ...)`:
 *   - `triggerId` (`trigger_id`) varchar(26) NOT NULL.
 *   - `objectId` (`object_id`) varchar(26) NOT NULL — deliberately FK-less
 *     (a direct reference into `objects_view`, an event-log projection, not
 *     a physical FK-able table — same rationale as `meeting_details.object_id`).
 *   - `matchedAt` (`matched_at`) timestamptz NOT NULL, `defaultNow()`.
 *   Composite PK: `(trigger_id, object_id)` — the ADR-0032 §b dedup
 *   mechanism's core DB-level guarantee.
 *   Plus an up+down migration (CLAUDE.md's "never a migration without a down
 *   script" rule — enforced automatically for every migration by
 *   `runMigrations`'s `assertEveryMigrationHasADownScript` check, already
 *   exercised generically by the existing `../migration.integration.test.ts`
 *   file, which needs NO changes for this PR).
 *
 * ----------------------------------------------------------------------------
 * HARNESS NOTE: mirrors `./meeting-retention-preferences.integration.test.ts`'s
 * (F2-T14 PR1) lean pattern exactly — no Nest app, no Redis container: a
 * throwaway Postgres 16 Testcontainer, `runMigrations`, then a plain Drizzle
 * `Database` client used directly (no HTTP, no DI container).
 *
 * Both `automationTriggers` and `automationTriggerMatches` are imported
 * TYPED from their respective (not-yet-existing) schema files (single,
 * static, top-level imports — not queried via the raw `pg` driver) because
 * those schema files' existence and exact shape ARE this PR's primary
 * deliverable.
 *
 * A real `workspaces` row is seeded directly via `db.insert(workspaces)` for
 * every test that needs a valid FK target; `workspaces.id`/`createdAt`/
 * `updatedAt` all have DB-level defaults, so only `name`/`slug` need
 * supplying.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): this file fails at MODULE RESOLUTION time
 * (before any Testcontainer even starts) because `./automation-triggers.js`/
 * `./automation-trigger-matches.js` do not exist yet — this is the first,
 * unavoidable RED signal. Once the schema files exist but before their
 * migration is generated/applied, the failure mode shifts to every test
 * below rejecting with a real Postgres error (`relation
 * "automation_triggers" does not exist`).
 * ============================================================================
 */

let workspaceSeedCounter = 0;

async function seedWorkspace(db: Database): Promise<string> {
  workspaceSeedCounter += 1;
  const [inserted] = await db
    .insert(workspaces)
    .values({
      name: `automation-triggers-test-workspace-${workspaceSeedCounter.toString()}`,
      slug: `at-test-ws-${Date.now().toString()}-${workspaceSeedCounter.toString()}-${Math.random().toString(36).slice(2)}`,
    })
    .returning();

  if (inserted === undefined) {
    throw new Error('Failed to seed a workspace row for the test.');
  }

  return inserted.id;
}

const SCHEDULE_SPEC = {
  kind: 'scheduled',
  intervalMinutes: 60,
  actionTemplate: { title: 'Weekly review' },
};

describe('F2-T15 PR1 (RED step): automation_triggers / automation_trigger_matches table schema/migration (real Postgres via Testcontainers, no Nest app)', () => {
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

  it('1. a valid automation_triggers row can be inserted and read back with matching column values', async () => {
    const workspaceId = await seedWorkspace(db);
    const triggerId = ulid();
    const streamId = '11111111-2222-4333-8444-555555555501';
    const now = new Date();

    const [inserted] = await db
      .insert(automationTriggers)
      .values({
        id: triggerId,
        streamId,
        workspaceId,
        kind: 'scheduled',
        spec: SCHEDULE_SPEC,
        lifecycle: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    expect(inserted).toBeDefined();
    expect(inserted?.id).toBe(triggerId);
    expect(inserted?.streamId).toBe(streamId);
    expect(inserted?.workspaceId).toBe(workspaceId);
    expect(inserted?.kind).toBe('scheduled');
    expect(inserted?.spec).toEqual(SCHEDULE_SPEC);
    expect(inserted?.lastFiredAt).toBeNull();
    expect(inserted?.lifecycle).toBe('active');
    expect(inserted?.createdAt).toBeInstanceOf(Date);
    expect(inserted?.updatedAt).toBeInstanceOf(Date);

    const [read] = await db
      .select()
      .from(automationTriggers)
      .where(eq(automationTriggers.id, triggerId));

    expect(read?.workspaceId).toBe(workspaceId);
    expect(read?.kind).toBe('scheduled');
  });

  it('2. a valid automation_trigger_matches row can be inserted and read back with matching column values', async () => {
    const workspaceId = await seedWorkspace(db);
    const triggerId = ulid();
    const objectId = ulid();

    const [inserted] = await db
      .insert(automationTriggers)
      .values({
        id: triggerId,
        streamId: '11111111-2222-4333-8444-555555555502',
        workspaceId,
        kind: 'scheduled',
        spec: SCHEDULE_SPEC,
        lifecycle: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    expect(inserted).toBeDefined();

    const [insertedMatch] = await db
      .insert(automationTriggerMatches)
      .values({ triggerId, objectId })
      .returning();

    expect(insertedMatch).toBeDefined();
    expect(insertedMatch?.triggerId).toBe(triggerId);
    expect(insertedMatch?.objectId).toBe(objectId);
    expect(insertedMatch?.matchedAt).toBeInstanceOf(Date);

    const [read] = await db
      .select()
      .from(automationTriggerMatches)
      .where(eq(automationTriggerMatches.triggerId, triggerId));

    expect(read?.objectId).toBe(objectId);
  });

  it('3. the workspaceId FK constraint is real: inserting an automation_triggers row with a nonexistent workspaceId fails with a foreign-key violation', async () => {
    const nonExistentWorkspaceId = '00000000-0000-0000-0000-000000000000';

    await expect(
      db.insert(automationTriggers).values({
        id: ulid(),
        streamId: '11111111-2222-4333-8444-555555555503',
        workspaceId: nonExistentWorkspaceId,
        kind: 'scheduled',
        spec: SCHEDULE_SPEC,
        lifecycle: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toSatisfy((error: unknown) => hasPostgresErrorCode(error, '23503'));
  });

  it('4. deleting the referenced workspace cascades to delete its automation_triggers rows (onDelete: cascade)', async () => {
    const workspaceId = await seedWorkspace(db);
    const triggerId = ulid();

    await db.insert(automationTriggers).values({
      id: triggerId,
      streamId: '11111111-2222-4333-8444-555555555504',
      workspaceId,
      kind: 'scheduled',
      spec: SCHEDULE_SPEC,
      lifecycle: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));

    const remaining = await db
      .select()
      .from(automationTriggers)
      .where(eq(automationTriggers.id, triggerId));

    expect(remaining).toHaveLength(0);
  });

  it("5. automation_trigger_matches' composite PK is real: two rows with the same (trigger_id, object_id) pair fail with a uniqueness violation (ADR-0032 §b dedup guarantee)", async () => {
    const workspaceId = await seedWorkspace(db);
    const triggerId = ulid();
    const objectId = ulid();

    await db.insert(automationTriggers).values({
      id: triggerId,
      streamId: '11111111-2222-4333-8444-555555555505',
      workspaceId,
      kind: 'condition',
      spec: {
        kind: 'condition',
        objectType: 'task',
        fieldKey: 'title',
        pattern: 'urgent',
        flags: '',
        actionTemplate: { title: 'Escalate' },
      },
      lifecycle: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(automationTriggerMatches).values({ triggerId, objectId });

    await expect(
      db.insert(automationTriggerMatches).values({ triggerId, objectId }),
    ).rejects.toSatisfy((error: unknown) => hasPostgresErrorCode(error, '23505'));
  });

  it('6. the streamId uniqueness constraint is real: two automation_triggers rows with the same streamId fail with a uniqueness violation', async () => {
    const workspaceIdA = await seedWorkspace(db);
    const workspaceIdB = await seedWorkspace(db);
    const sharedStreamId = '11111111-2222-4333-8444-555555555506';

    await db.insert(automationTriggers).values({
      id: ulid(),
      streamId: sharedStreamId,
      workspaceId: workspaceIdA,
      kind: 'scheduled',
      spec: SCHEDULE_SPEC,
      lifecycle: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      db.insert(automationTriggers).values({
        id: ulid(),
        streamId: sharedStreamId,
        workspaceId: workspaceIdB,
        kind: 'scheduled',
        spec: SCHEDULE_SPEC,
        lifecycle: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toSatisfy((error: unknown) => hasPostgresErrorCode(error, '23505'));
  });

  it('7. "lifecycle" defaults to \'active\' when not explicitly provided on insert', async () => {
    const workspaceId = await seedWorkspace(db);

    const [inserted] = await db
      .insert(automationTriggers)
      .values({
        id: ulid(),
        streamId: '11111111-2222-4333-8444-555555555507',
        workspaceId,
        kind: 'scheduled',
        spec: SCHEDULE_SPEC,
        createdAt: new Date(),
        updatedAt: new Date(),
        // `lifecycle` deliberately omitted.
      })
      .returning();

    expect(inserted?.lifecycle).toBe('active');
  });
});
