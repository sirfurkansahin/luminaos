import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newObjectId } from '@luminaos/core-objects';

import {
  hasPostgresConstraintViolation,
  hasPostgresErrorCode,
} from '../../common/postgres-error.js';
import { createDatabaseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { meetingDetails } from './meeting-details.js';

import type { Database } from '../client.js';

/**
 * F2-T13 PR1 (RED step) — `meeting` `ObjectType` + `meeting_details` table
 * schema/migration ONLY (ADR-0030 §b/§d, `docs/adr/ADR-0030-notetaker-botu-
 * mimarisi.md`). This PR is deliberately narrow: no `MeetingsService`, no
 * controller, no webhook, no `MeetingBotClient` exist yet (those are PR2-PR5)
 * — this file proves only that the `meeting_details` table itself, its two
 * Postgres enums, and its two unique indexes exist and behave exactly as
 * ADR-0030 §d's literal schema sketch specifies.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely, this
 * is ADR-0030 §d's schema sketch verbatim):
 *
 * `apps/server/src/db/schema/meeting-details.ts` (new), exporting:
 *   - `meetingProviderEnum` — Postgres enum `meeting_provider`:
 *     `'google-meet' | 'zoom' | 'microsoft-teams'`.
 *   - `meetingStatusEnum` — Postgres enum `meeting_status`:
 *     `'sunuldu' | 'beklemede' | 'kaydedildi' | 'basarisiz'`.
 *   - `meetingDetails` — `pgTable('meeting_details', ...)`:
 *       - `id` uuid PK, `default(sql\`gen_random_uuid()\`)`.
 *       - `objectId` (`object_id`) varchar(26) NOT NULL — the `meeting`
 *         LuminaObject's ULID, deliberately NOT a real FK (mirrors
 *         `timeblock_external_pushes.object_id` — `objects_view` is an
 *         event-log projection, not an FK-able physical table, ADR-0030
 *         Bağlam madde 2).
 *       - `meetingUrl` (`meeting_url`) text NOT NULL.
 *       - `provider` `meetingProviderEnum` NOT NULL.
 *       - `status` `meetingStatusEnum` NOT NULL, `default('sunuldu')`.
 *       - `providerMeetingRef` (`provider_meeting_ref`) text NOT NULL.
 *       - `providerRecordingUrl` (`provider_recording_url`) text, NULLABLE.
 *       - `transcriptText` (`transcript_text`) text, NULLABLE.
 *       - `createdAt` (`created_at`) timestamptz NOT NULL, `defaultNow()`.
 *     Indexes: `uniqueIndex('meeting_details_provider_meeting_ref_idx').on(
 *     table.providerMeetingRef)` and
 *     `uniqueIndex('meeting_details_object_id_idx').on(table.objectId)` — the
 *     v0 invariant "one `meeting` object = exactly one detail row" (ADR-0030
 *     §d) AND the future webhook's exact-match `providerMeetingRef` lookup
 *     safety, both enforced at the DB level, not just application code.
 *   Plus an up+down migration (CLAUDE.md's "never a migration without a down
 *   script" rule — enforced automatically for every migration by
 *   `runMigrations`'s `assertEveryMigrationHasADownScript` check, already
 *   exercised generically, migration-layout-agnostically, by the existing
 *   `./migration.integration.test.ts` file, which needs NO changes for this
 *   PR).
 *
 * `packages/core-objects` (modified, separately RED-tested in
 * `packages/core-objects/src/object-type-registry.test.ts`): `'meeting'`
 * added to `ObjectType` (`lumina-object.ts`) and to `objectTypeRegistry` as
 * `{titleRequired: true}` (`object-type-registry.ts`).
 *
 * ----------------------------------------------------------------------------
 * HARNESS NOTE: unlike most integration tests in this codebase, this file
 * does NOT boot a Nest application or a Redis container — there is no
 * service/controller/module for this PR to wire up yet. It mirrors
 * `../event-store/event-store.integration.test.ts`'s leaner pattern instead:
 * a throwaway Postgres 16 Testcontainer, `runMigrations`, then a plain
 * Drizzle `Database` client used directly (no HTTP, no DI container).
 *
 * `meetingDetails` is imported TYPED from `./meeting-details.js` (a single,
 * static, top-level import — not queried via the raw `pg` driver) because
 * that schema file's existence and exact shape ARE this PR's primary
 * deliverable — mirrors `../memory/memory-records.integration.test.ts`'s
 * identical rationale for `../db/schema/memory-records.js` in that PR's own
 * RED step. Invalid-enum-value insert attempts (tests 5/6 below) intentionally
 * go through the raw `db.$client.query` escape hatch instead of the typed
 * Drizzle insert builder, since a real invalid enum literal is (correctly)
 * not assignable to the typed column at compile time — the raw path is how
 * this test proves the enum is a REAL Postgres constraint, not just a
 * TypeScript-level union with no DB enforcement.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): this file fails at MODULE RESOLUTION time
 * (before any Testcontainer even starts) because `./meeting-details.js` does
 * not exist yet — this is the first, unavoidable RED signal. Once the schema
 * file exists but before its migration is generated/applied, the failure mode
 * shifts to every test below rejecting with a real Postgres error
 * (`relation "meeting_details" does not exist`).
 *
 * EXPECTED LINT STATE (today): `pnpm lint` reports a SINGLE isolated
 * `import-x/no-unresolved` finding at the `./meeting-details.js` import above,
 * plus its natural cascade (`@typescript-eslint/no-unsafe-*` at every site
 * that touches the resulting `any`-typed `meetingDetails` binding or an
 * insert's returned row) — same "one isolated, EXPECTED finding" convention
 * as `../mcp-server/mcp-client-grants.service.test.ts`'s header comment.
 * These clear on their own once `implementer` adds the real schema file; no
 * further edits to THIS test file are needed for that.
 * ============================================================================
 */

function freshProviderMeetingRef(label: string): string {
  return `mock-bot-${label}-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`;
}

describe('F2-T13 PR1 (RED step): meeting_details table schema/migration (real Postgres via Testcontainers, no Nest app)', () => {
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

  it('1. after migrations, "meeting_details" exists with EXACTLY the columns ADR-0030 §d specifies (no more, no fewer)', async () => {
    const result = await db.$client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'meeting_details'
       ORDER BY column_name`,
    );
    const columnNames = result.rows.map((row) => row.column_name).sort();

    expect(columnNames).toEqual(
      [
        'created_at',
        'id',
        'meeting_url',
        'object_id',
        'provider',
        'provider_meeting_ref',
        'provider_recording_url',
        'status',
        'transcript_text',
      ].sort(),
    );
  });

  it('2. "provider" and "status" columns are backed by REAL Postgres enum types (meeting_provider/meeting_status), not plain varchar/text', async () => {
    const result = await db.$client.query<{ column_name: string; udt_name: string }>(
      `SELECT column_name, udt_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'meeting_details'
         AND column_name IN ('provider', 'status')
       ORDER BY column_name`,
    );

    const byColumn = new Map(result.rows.map((row) => [row.column_name, row.udt_name]));
    expect(byColumn.get('provider')).toBe('meeting_provider');
    expect(byColumn.get('status')).toBe('meeting_status');
  });

  it('3. nullability matches ADR-0030 §d exactly: objectId/meetingUrl/provider/status/providerMeetingRef/createdAt NOT NULL; providerRecordingUrl/transcriptText NULLABLE', async () => {
    const result = await db.$client.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'meeting_details'`,
    );
    const nullableByColumn = new Map(
      result.rows.map((row) => [row.column_name, row.is_nullable === 'YES']),
    );

    expect(nullableByColumn.get('object_id')).toBe(false);
    expect(nullableByColumn.get('meeting_url')).toBe(false);
    expect(nullableByColumn.get('provider')).toBe(false);
    expect(nullableByColumn.get('status')).toBe(false);
    expect(nullableByColumn.get('provider_meeting_ref')).toBe(false);
    expect(nullableByColumn.get('created_at')).toBe(false);
    expect(nullableByColumn.get('provider_recording_url')).toBe(true);
    expect(nullableByColumn.get('transcript_text')).toBe(true);
  });

  it('4. a direct Drizzle insert with a valid provider/status enum value succeeds', async () => {
    const objectId = newObjectId();
    const providerMeetingRef = freshProviderMeetingRef('valid-insert');

    const [inserted] = await db
      .insert(meetingDetails)
      .values({
        objectId,
        meetingUrl: 'https://zoom.us/j/1234567890',
        provider: 'zoom',
        status: 'beklemede',
        providerMeetingRef,
      })
      .returning();

    expect(inserted).toBeDefined();
    expect(inserted?.objectId).toBe(objectId);
    expect(inserted?.provider).toBe('zoom');
    expect(inserted?.status).toBe('beklemede');
    expect(inserted?.providerMeetingRef).toBe(providerMeetingRef);
    expect(inserted?.providerRecordingUrl).toBeNull();
    expect(inserted?.transcriptText).toBeNull();
    expect(inserted?.createdAt).toBeInstanceOf(Date);
  });

  it('5. an INVALID "provider" value (not in the meeting_provider enum) is rejected by Postgres itself', async () => {
    const objectId = newObjectId();
    const providerMeetingRef = freshProviderMeetingRef('invalid-provider');

    await expect(
      db.$client.query(
        `INSERT INTO meeting_details (object_id, meeting_url, provider, status, provider_meeting_ref)
         VALUES ($1, $2, $3, 'sunuldu', $4)`,
        [objectId, 'https://meet.google.com/abc-defg-hij', 'webex', providerMeetingRef],
      ),
    ).rejects.toSatisfy((error: unknown) => hasPostgresErrorCode(error, '22P02'));
  });

  it('6. an INVALID "status" value (not in the meeting_status enum) is rejected by Postgres itself', async () => {
    const objectId = newObjectId();
    const providerMeetingRef = freshProviderMeetingRef('invalid-status');

    await expect(
      db.$client.query(
        `INSERT INTO meeting_details (object_id, meeting_url, provider, status, provider_meeting_ref)
         VALUES ($1, $2, 'zoom', $3, $4)`,
        [objectId, 'https://zoom.us/j/1234567890', 'iptal-edildi', providerMeetingRef],
      ),
    ).rejects.toSatisfy((error: unknown) => hasPostgresErrorCode(error, '22P02'));
  });

  it('7. the providerMeetingRef unique index is real: two rows with the SAME providerMeetingRef but DIFFERENT objectId fail with a uniqueness violation (ADR-0030 §d — safe exact-match webhook lookup)', async () => {
    const sharedRef = freshProviderMeetingRef('shared-ref');

    await db.insert(meetingDetails).values({
      objectId: newObjectId(),
      meetingUrl: 'https://meet.google.com/aaa-bbbb-ccc',
      provider: 'google-meet',
      status: 'sunuldu',
      providerMeetingRef: sharedRef,
    });

    await expect(
      db.insert(meetingDetails).values({
        objectId: newObjectId(),
        meetingUrl: 'https://meet.google.com/xxx-yyyy-zzz',
        provider: 'google-meet',
        status: 'sunuldu',
        providerMeetingRef: sharedRef,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      hasPostgresConstraintViolation(error, 'meeting_details_provider_meeting_ref_idx'),
    );
  });

  it('8. the objectId unique index is real: two rows with the SAME objectId but DIFFERENT providerMeetingRef fail with a uniqueness violation (ADR-0030 §d — one meeting object = exactly one detail row)', async () => {
    const sharedObjectId = newObjectId();

    await db.insert(meetingDetails).values({
      objectId: sharedObjectId,
      meetingUrl: 'https://teams.microsoft.com/l/meetup-join/first',
      provider: 'microsoft-teams',
      status: 'sunuldu',
      providerMeetingRef: freshProviderMeetingRef('object-id-first'),
    });

    await expect(
      db.insert(meetingDetails).values({
        objectId: sharedObjectId,
        meetingUrl: 'https://teams.microsoft.com/l/meetup-join/second',
        provider: 'microsoft-teams',
        status: 'sunuldu',
        providerMeetingRef: freshProviderMeetingRef('object-id-second'),
      }),
    ).rejects.toSatisfy((error: unknown) =>
      hasPostgresConstraintViolation(error, 'meeting_details_object_id_idx'),
    );
  });

  it('9. "status" defaults to \'sunuldu\' when not explicitly provided on insert', async () => {
    const objectId = newObjectId();
    const providerMeetingRef = freshProviderMeetingRef('status-default');

    const [inserted] = await db
      .insert(meetingDetails)
      .values({
        objectId,
        meetingUrl: 'https://zoom.us/j/9999999999',
        provider: 'zoom',
        providerMeetingRef,
        // `status` deliberately omitted.
      })
      .returning();

    expect(inserted?.status).toBe('sunuldu');
  });
});
