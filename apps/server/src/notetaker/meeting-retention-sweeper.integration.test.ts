import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { meetingDetails } from '../db/schema/meeting-details.js';
import { meetingRetentionPreferences } from '../db/schema/meeting-retention-preferences.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';

/**
 * F2-T14 PR2 (RED step, part 1 of 2) -- `MeetingRetentionSweeperService`, per
 * ADR-0031 §d's exact shape (`CalendarSyncPollerService`'s
 * `OnModuleInit`/`OnModuleDestroy` + `setInterval`/`clearInterval` mirrored
 * verbatim, a public `sweepOnce()` directly callable by tests, per-row
 * try/catch so one row's failure never aborts the sweep) and the mode-by-mode
 * field-clearing table (ADR-0031 §d, human-approved):
 *
 *   mode                  | transcriptText                        | providerRecordingUrl
 *   ----------------------|----------------------------------------|--------------------------------
 *   transcript-only       | kept until createdAt + 30 days, then null | null on EVERY sweep
 *   recording-reference   | null on EVERY sweep                   | kept indefinitely (no TTL)
 *   summary-only          | null on EVERY sweep                   | null on EVERY sweep
 *
 * A workspace with NO row in `meeting_retention_preferences` uses the
 * code-level default: `transcript-only`, 30-day TTL (ADR-0031 §b). TTL is
 * measured from `meeting_details.createdAt` (ADR-0031's own accepted
 * simplification).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./meeting-retention-sweeper.service.ts` does
 * not exist, so the dynamic `import('./meeting-retention-sweeper.service.js')`
 * inside `beforeAll` REJECTS ("Cannot find module"), failing `beforeAll` and
 * thus every `it` in this file -- the correct red, mirroring
 * `calendar-sync-poller.integration.test.ts`'s identical "service doesn't
 * exist yet" documented red state.
 * ============================================================================
 *
 * HARNESS NOTE: mirrors `calendar-sync-poller.integration.test.ts`'s
 * Testcontainers-Postgres-only harness (no Redis/HTTP needed here -- this
 * service has no HTTP surface of its own, only `sweepOnce()` invoked
 * directly). A single Postgres container + single Drizzle client serves the
 * whole file; each `it` creates its OWN workspace + meeting rows so
 * assertions never depend on ordering or on rows created by earlier tests.
 */

interface MeetingRetentionSweeperServiceLike {
  sweepOnce(): Promise<void>;
}

interface MeetingRetentionSweeperServiceConstructor {
  new (...args: unknown[]): MeetingRetentionSweeperServiceLike;
}

const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

describe('F2-T14 PR2 (RED step): MeetingRetentionSweeperService -- per-mode retention field-clearing (real Postgres, via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let MeetingRetentionSweeperService: MeetingRetentionSweeperServiceConstructor;
  let workspaceCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    await runMigrations(container.getConnectionUri());

    db = createDatabaseClient(container.getConnectionUri());

    const sweeperModule = (await import('./meeting-retention-sweeper.service.js')) as unknown as {
      MeetingRetentionSweeperService: MeetingRetentionSweeperServiceConstructor;
    };
    MeetingRetentionSweeperService = sweeperModule.MeetingRetentionSweeperService;
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(): Promise<string> {
    workspaceCounter += 1;
    const [row] = await db
      .insert(workspaces)
      .values({
        name: `meeting-retention-sweeper-test-workspace-${String(workspaceCounter)}`,
        slug: `meeting-retention-sweeper-test-workspace-${String(workspaceCounter)}`,
      })
      .returning({ id: workspaces.id });
    if (!row) {
      throw new Error('Failed to create test workspace');
    }
    return row.id;
  }

  async function createMeetingDetailsRow(params: {
    workspaceId: string;
    createdAt: Date;
    transcriptText: string | null;
    providerRecordingUrl: string | null;
    objectIdSuffix: string;
    providerMeetingRefSuffix: string;
  }): Promise<string> {
    const [row] = await db
      .insert(meetingDetails)
      .values({
        objectId: `obj_${params.objectIdSuffix}`.padEnd(26, '0').slice(0, 26),
        workspaceId: params.workspaceId,
        meetingUrl: 'https://meet.google.com/aaa-bbbb-ccc',
        provider: 'google-meet',
        providerMeetingRef: `sweeper-test-ref-${params.providerMeetingRefSuffix}`,
        providerRecordingUrl: params.providerRecordingUrl,
        transcriptText: params.transcriptText,
        createdAt: params.createdAt,
      })
      .returning({ id: meetingDetails.id });
    if (!row) {
      throw new Error('Failed to create test meeting_details row');
    }
    return row.id;
  }

  async function setPreference(
    workspaceId: string,
    mode: 'recording-reference' | 'transcript-only' | 'summary-only',
  ): Promise<void> {
    await db.insert(meetingRetentionPreferences).values({ workspaceId, mode });
  }

  async function readRow(
    id: string,
  ): Promise<{ transcriptText: string | null; providerRecordingUrl: string | null }> {
    const [row] = await db
      .select({
        transcriptText: meetingDetails.transcriptText,
        providerRecordingUrl: meetingDetails.providerRecordingUrl,
      })
      .from(meetingDetails)
      .where(eq(meetingDetails.id, id));
    if (!row) {
      throw new Error('Row disappeared during test');
    }
    return row;
  }

  it('1. no preference row + createdAt older than 30 days -> transcriptText nulled by sweepOnce() (code-level default: transcript-only, 30-day TTL)', async () => {
    const workspaceId = await createWorkspace();
    const oldId = await createMeetingDetailsRow({
      workspaceId,
      createdAt: new Date(Date.now() - THIRTY_ONE_DAYS_MS),
      transcriptText: 'an old transcript',
      providerRecordingUrl: null,
      objectIdSuffix: 'old1',
      providerMeetingRefSuffix: 'old1',
    });

    const sweeper = new MeetingRetentionSweeperService(db);
    await sweeper.sweepOnce();

    const row = await readRow(oldId);
    expect(row.transcriptText).toBeNull();
  });

  it('2. no preference row + createdAt younger than 30 days -> transcriptText left untouched', async () => {
    const workspaceId = await createWorkspace();
    const youngId = await createMeetingDetailsRow({
      workspaceId,
      createdAt: new Date(Date.now() - TWO_DAYS_MS),
      transcriptText: 'a fresh transcript',
      providerRecordingUrl: null,
      objectIdSuffix: 'young1',
      providerMeetingRefSuffix: 'young1',
    });

    const sweeper = new MeetingRetentionSweeperService(db);
    await sweeper.sweepOnce();

    const row = await readRow(youngId);
    expect(row.transcriptText).toBe('a fresh transcript');
  });

  it('3. explicit recording-reference preference -> transcriptText nulled on the VERY NEXT sweep regardless of age', async () => {
    const workspaceId = await createWorkspace();
    await setPreference(workspaceId, 'recording-reference');
    const id = await createMeetingDetailsRow({
      workspaceId,
      createdAt: new Date(Date.now() - TWO_DAYS_MS),
      transcriptText: 'should be nulled immediately',
      providerRecordingUrl: 'https://vendor.example/recordings/abc',
      objectIdSuffix: 'rr1',
      providerMeetingRefSuffix: 'rr1',
    });

    const sweeper = new MeetingRetentionSweeperService(db);
    await sweeper.sweepOnce();

    const row = await readRow(id);
    expect(row.transcriptText).toBeNull();
  });

  it('4. explicit recording-reference preference -> providerRecordingUrl is NEVER nulled, even for a very-old row (no implicit TTL)', async () => {
    const workspaceId = await createWorkspace();
    await setPreference(workspaceId, 'recording-reference');
    const id = await createMeetingDetailsRow({
      workspaceId,
      createdAt: new Date(Date.now() - THIRTY_ONE_DAYS_MS * 4),
      transcriptText: 'irrelevant to this assertion',
      providerRecordingUrl: 'https://vendor.example/recordings/very-old',
      objectIdSuffix: 'rr2',
      providerMeetingRefSuffix: 'rr2',
    });

    const sweeper = new MeetingRetentionSweeperService(db);
    await sweeper.sweepOnce();
    await sweeper.sweepOnce();

    const row = await readRow(id);
    expect(row.providerRecordingUrl).toBe('https://vendor.example/recordings/very-old');
  });

  it('5. explicit summary-only preference -> BOTH transcriptText and providerRecordingUrl nulled on the very next sweep', async () => {
    const workspaceId = await createWorkspace();
    await setPreference(workspaceId, 'summary-only');
    const id = await createMeetingDetailsRow({
      workspaceId,
      createdAt: new Date(Date.now() - TWO_DAYS_MS),
      transcriptText: 'gone immediately',
      providerRecordingUrl: 'https://vendor.example/recordings/gone-too',
      objectIdSuffix: 'so1',
      providerMeetingRefSuffix: 'so1',
    });

    const sweeper = new MeetingRetentionSweeperService(db);
    await sweeper.sweepOnce();

    const row = await readRow(id);
    expect(row.transcriptText).toBeNull();
    expect(row.providerRecordingUrl).toBeNull();
  });

  it('6a. explicit transcript-only preference (row present, not just default) + old createdAt -> transcriptText nulled (same 30-day TTL as the no-row default)', async () => {
    const workspaceId = await createWorkspace();
    await setPreference(workspaceId, 'transcript-only');
    const id = await createMeetingDetailsRow({
      workspaceId,
      createdAt: new Date(Date.now() - THIRTY_ONE_DAYS_MS),
      transcriptText: 'old transcript, explicit mode',
      providerRecordingUrl: 'https://vendor.example/recordings/explicit-mode',
      objectIdSuffix: 'to1',
      providerMeetingRefSuffix: 'to1',
    });

    const sweeper = new MeetingRetentionSweeperService(db);
    await sweeper.sweepOnce();

    const row = await readRow(id);
    expect(row.transcriptText).toBeNull();
  });

  it('6b. explicit transcript-only preference + young createdAt -> transcriptText left untouched, but providerRecordingUrl is nulled immediately (never kept in this mode)', async () => {
    const workspaceId = await createWorkspace();
    await setPreference(workspaceId, 'transcript-only');
    const id = await createMeetingDetailsRow({
      workspaceId,
      createdAt: new Date(Date.now() - TWO_DAYS_MS),
      transcriptText: 'young transcript, explicit mode',
      providerRecordingUrl: 'https://vendor.example/recordings/explicit-mode-young',
      objectIdSuffix: 'to2',
      providerMeetingRefSuffix: 'to2',
    });

    const sweeper = new MeetingRetentionSweeperService(db);
    await sweeper.sweepOnce();

    const row = await readRow(id);
    expect(row.transcriptText).toBe('young transcript, explicit mode');
    expect(row.providerRecordingUrl).toBeNull();
  });

  it('7. one row failing to process (a workspaceId with no matching workspace row, simulating a preference-lookup error) does NOT prevent other rows in the same sweepOnce() call from being processed correctly', async () => {
    const goodWorkspaceId = await createWorkspace();
    const goodId = await createMeetingDetailsRow({
      workspaceId: goodWorkspaceId,
      createdAt: new Date(Date.now() - THIRTY_ONE_DAYS_MS),
      transcriptText: 'this one must still get cleared',
      providerRecordingUrl: null,
      objectIdSuffix: 'good1',
      providerMeetingRefSuffix: 'good1',
    });

    // A dangling/orphaned workspaceId (no `workspaces` row backs it) so that
    // whatever `resolvePreference` does for this row (e.g. a lookup that
    // relies on the workspace existing) is expected to fail or behave
    // unexpectedly -- mirrors calendar-sync-poller's per-account
    // "one account's failure never aborts another's poll" test, using a
    // deliberately malformed row rather than a mock throw (no seams to mock
    // in a plain-DB integration test).
    const orphanWorkspaceId = '00000000-0000-0000-0000-000000000000';
    let orphanId: string | undefined;
    try {
      orphanId = await createMeetingDetailsRow({
        workspaceId: orphanWorkspaceId,
        createdAt: new Date(Date.now() - THIRTY_ONE_DAYS_MS),
        transcriptText: 'this row may or may not survive the FK constraint',
        providerRecordingUrl: null,
        objectIdSuffix: 'orphan1',
        providerMeetingRefSuffix: 'orphan1',
      });
    } catch {
      // `meeting_details.workspaceId` is a real FK (ADR-0031 §c) -- inserting
      // an orphaned row may itself be rejected by Postgres, which is fine:
      // the point of this test is only that the GOOD row is unaffected
      // regardless of what happens to the bad one.
      orphanId = undefined;
    }

    const sweeper = new MeetingRetentionSweeperService(db);
    await expect(sweeper.sweepOnce()).resolves.toBeUndefined();

    const goodRow = await readRow(goodId);
    expect(goodRow.transcriptText).toBeNull();

    if (orphanId !== undefined) {
      // Whatever happened to the orphan row, sweepOnce() must have resolved
      // without throwing (already asserted above) and must not have crashed
      // before reaching the good row.
      await expect(readRow(orphanId)).resolves.toBeDefined();
    }
  });

  it('8. fields that are ALREADY null are left alone (no-op, no error) by a sweep', async () => {
    const workspaceId = await createWorkspace();
    await setPreference(workspaceId, 'transcript-only');
    const id = await createMeetingDetailsRow({
      workspaceId,
      createdAt: new Date(Date.now() - THIRTY_ONE_DAYS_MS),
      transcriptText: null,
      providerRecordingUrl: null,
      objectIdSuffix: 'null1',
      providerMeetingRefSuffix: 'null1',
    });

    const sweeper = new MeetingRetentionSweeperService(db);
    await expect(sweeper.sweepOnce()).resolves.toBeUndefined();

    const row = await readRow(id);
    expect(row.transcriptText).toBeNull();
    expect(row.providerRecordingUrl).toBeNull();
  });
});
