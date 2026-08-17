import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { memberships } from '../db/schema/memberships.js';
import { memoryRecords } from '../db/schema/memory-records.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { StoredEvent } from '../event-store/event-store.service.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T5 PR2 (RED step) — Memory Passport CRUD: event-sourced,
 * self-service, per-(workspace,user) memory records with a tombstone-based
 * delete (ADR-0022, `docs/adr/ADR-0022-memory-passport.md`). Mirrors
 * `../context/desktop-signal-consents.integration.test.ts`'s Testcontainers
 * harness EXACTLY (Postgres 16 + Redis 7, `runMigrations`, dynamic
 * `import('../app.module.js')` AFTER env vars are set,
 * `Test.createTestingModule`, supertest), plus `desktop-signals.integration
 * .test.ts`'s `addMemberWithRole` convention for a second user sharing the
 * SAME workspace (cross-user-same-workspace isolation).
 *
 * PR1 (`packages/memory`, already shipped) exports `MemoryRecord` and three
 * `.strict()` zod payload schemas (`memoryRecordAddedPayloadSchema`
 * `{content}`, `memoryRecordEditedPayloadSchema` `{content}`,
 * `memoryRecordDeletedPayloadSchema` `{}`) — this PR consumes them, it does
 * not redefine them.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * A. `db/schema/memory-records.ts` (new) — `memory_records` table, exported
 *    as `memoryRecords`: `id` varchar(26) PK (ULID, app-minted, mirrors
 *    `desktop_signal_consents.id`), `workspaceId` uuid NOT NULL FK ->
 *    `workspaces.id` (cascade), `userId` uuid NOT NULL FK -> `users.id`
 *    (cascade), `content` text NOT NULL, `kaynakOlayId` uuid NOT NULL
 *    (column `kaynak_olay_id`), `createdAt`/`updatedAt` timestamptz NOT
 *    NULL, `deletedAt` timestamptz NULLABLE (ADR-0022 Karar d — the
 *    tombstone column). Plus a migration (up+down, CLAUDE.md).
 *
 * B. `memory/memory-record.projection.ts` (new) — `MemoryRecordProjection
 *    implements Projection`: `handles = ['MemoryRecordAdded',
 *    'MemoryRecordEdited', 'MemoryRecordDeleted']`.
 *      - `MemoryRecordAdded` -> inserts a new row: `kaynakOlayId =
 *        event.id` (self-reference, ADR-0022 Karar b — NEVER the record's
 *        own newly-minted `id`, the EVENT's id), `content =
 *        payload.content`, `deletedAt = null`, `createdAt = updatedAt =
 *        event.occurredAt`.
 *      - `MemoryRecordEdited` -> `content` is FULLY REPLACED by
 *        `payload.content` (no merge/patch, ADR-0022 Karar e),
 *        `updatedAt = event.occurredAt`.
 *      - `MemoryRecordDeleted` -> `deletedAt = event.occurredAt` on the
 *        matching row. The row is NEVER physically `DELETE`d (ADR-0022
 *        Karar d, the critical tombstone contract).
 *
 * C. `memory/memory-records.service.ts` (new) — `@Injectable()
 *    MemoryRecordsService`:
 *      - `streamId` is a per-record `randomUUID()`, NOT a deterministic
 *        derivation (ADR-0022 Karar c, a deliberate divergence from
 *        `DesktopSignalConsentsService.streamIdFor`'s triple-keyed
 *        determinism — there is no natural-key uniqueness constraint on a
 *        memory record, a user may hold unboundedly many independent ones).
 *      - `create(workspaceId, userId, content)`: mints a fresh `streamId`,
 *        opens the stream with `MemoryRecordAdded {content}` at
 *        `expectedVersion=0` (actor `{type:'user', id:userId}`),
 *        synchronously `projectionRunner.catchUp(...)`, reads back and
 *        returns the full row.
 *      - `list(workspaceId, userId)`: rows filtered by BOTH `workspaceId`
 *        AND `userId` (ADR-0022 Karar f) AND `deletedAt IS NULL` (Karar d).
 *      - `edit(workspaceId, userId, recordId, content)`: the target row
 *        MUST already be filtered by `(workspaceId, userId, id=recordId,
 *        deletedAt IS NULL)` before any event is appended — a record
 *        belonging to a different user or workspace, or already
 *        tombstoned, is treated as NOT FOUND (`NotFoundError`,
 *        `@luminaos/shared`, 404) and no event is written.
 *      - `delete(workspaceId, userId, recordId)`: same
 *        existence/ownership check as `edit`, appends
 *        `MemoryRecordDeleted {}`.
 *
 * D. `memory/memory-records.controller.ts` (new) — `@Controller(
 *    'workspaces/:workspaceId/memory')`, `@UseGuards(SessionAuthGuard,
 *    WorkspaceMembershipGuard)` on all four routes, identity ALWAYS
 *    `req.user.id` (never the body):
 *      - `@Get()` -> `service.list(workspaceId, req.user.id)`, 200,
 *        `{records: MemoryRecordBody[]}`.
 *      - `@Post()` body `{content}` (zod-validated, NOT `.strict()` — a
 *        `userId`/`workspaceId` key in the body, if present, is silently
 *        ignored, mirroring `grant-desktop-signal-consent.schema.ts`'s
 *        convention) -> `service.create(workspaceId, req.user.id,
 *        body.content)`, 201, `{record: MemoryRecordBody}`.
 *      - `@Patch(':id')` body `{content}` (same non-`.strict()` DTO) ->
 *        `service.edit(workspaceId, req.user.id, params.id, body.content)`,
 *        200, `{record: MemoryRecordBody}`.
 *      - `@Delete(':id')` -> `service.delete(workspaceId, req.user.id,
 *        params.id)`, 200/204.
 *
 * E. `memory/memory.module.ts` (new), wired into `app.module.ts`'s
 *    `imports` array.
 *
 * `MemoryRecordBody` (HTTP JSON shape, dates as ISO strings): `{id,
 * workspaceId, userId, content, kaynakOlayId, createdAt, updatedAt,
 * deletedAt}`.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `MemoryModule` does not exist and is not
 * imported into `AppModule`, so EVERY route this file hits
 * (`/workspaces/:workspaceId/memory...`) 404s as an unmatched route
 * (Nest's default 404) — including the unauthenticated/non-member cases
 * (test #10) which expect 401/403 but will actually see 404 today. This
 * file also fails at MODULE RESOLUTION time (before any HTTP call runs)
 * because `../db/schema/memory-records.js` does not exist yet — this is
 * the first, unavoidable RED signal, resolved only once that schema file
 * (and its migration) exist.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface MemoryRecordBody {
  id: string;
  workspaceId: string;
  userId: string;
  content: string;
  kaynakOlayId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface RecordEnvelope {
  record: MemoryRecordBody;
}

interface RecordsListEnvelope {
  records: MemoryRecordBody[];
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

/** See `../auth/tenant-isolation.integration.test.ts` for the full rationale
 * behind this exact helper (copied verbatim per established convention). */
function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `memory-record-test-user-${String(emailCounter)}@example.com`;
}

function freshContent(label: string): string {
  emailCounter += 1;
  return `${label} :: unique-content-${String(emailCounter)}-${Date.now().toString()}`;
}

describe('F2-T5 PR2 (RED step): MemoryRecordsService/Controller/Projection — event-sourced, self-service, tombstoned memory records (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    // Imported only after DATABASE_URL/REDIS_URL are set, per the
    // established convention in every other integration test file here.
    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
    rawDb = createDatabaseClient(container.getConnectionUri());
    eventStore = app.get(EventStoreService);
    projectionRunner = app.get(ProjectionRunner);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  // ---- HTTP helpers -------------------------------------------------------

  async function registerUser(): Promise<{ cookie: string; userId: string }> {
    const email = freshEmail();
    const response = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(201);
    const cookie = toCookieHeader(response.get('Set-Cookie'));
    const userId = (response.body as UserEnvelope).user.id;
    return { cookie, userId };
  }

  async function createWorkspace(cookie: string, name: string): Promise<string> {
    const response = await request(server).post('/workspaces').set('Cookie', cookie).send({ name });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  async function registerOwnerWithWorkspace(): Promise<{
    cookie: string;
    userId: string;
    workspaceId: string;
  }> {
    const { cookie, userId } = await registerUser();
    const workspaceId = await createWorkspace(
      cookie,
      `Memory record test workspace ${String(emailCounter)}`,
    );
    return { cookie, userId, workspaceId };
  }

  /** Registers a brand-new user and inserts a `memberships` row for them in
   * `workspaceId` DIRECTLY via the raw DB connection (no HTTP invite
   * endpoint exists in this codebase yet — mirrors
   * `desktop-signals.integration.test.ts`'s `addMemberWithRole` convention
   * exactly). Returns their session cookie and userId. */
  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<{ cookie: string; userId: string }> {
    const { cookie, userId } = await registerUser();
    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return { cookie, userId };
  }

  function memoryUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/memory`;
  }

  async function createRecord(
    cookie: string,
    workspaceId: string,
    body: { content: string; userId?: string; workspaceId?: string },
  ): Promise<request.Response> {
    return request(server).post(memoryUrl(workspaceId)).set('Cookie', cookie).send(body);
  }

  async function listRecords(cookie: string, workspaceId: string): Promise<request.Response> {
    return request(server).get(memoryUrl(workspaceId)).set('Cookie', cookie);
  }

  async function editRecord(
    cookie: string,
    workspaceId: string,
    recordId: string,
    body: { content: string; userId?: string },
  ): Promise<request.Response> {
    return request(server)
      .patch(`${memoryUrl(workspaceId)}/${recordId}`)
      .set('Cookie', cookie)
      .send(body);
  }

  async function deleteRecord(
    cookie: string,
    workspaceId: string,
    recordId: string,
  ): Promise<request.Response> {
    return request(server)
      .delete(`${memoryUrl(workspaceId)}/${recordId}`)
      .set('Cookie', cookie);
  }

  /** Finds the `MemoryRecordAdded` event (across the whole workspace's log)
   * whose payload content matches `content` exactly — used instead of a
   * hardcoded/derived `streamId` because PR2's `streamId` is a per-record
   * `randomUUID()` (ADR-0022 Karar c), not something a test can
   * independently re-derive the way `desktop-signal-consents` tests do. */
  async function findAddedEvent(workspaceId: string, content: string): Promise<StoredEvent> {
    const events = await eventStore.readByWorkspace(workspaceId, 0);
    const match = events.find(
      (event) => event.type === 'MemoryRecordAdded' && event.payload['content'] === content,
    );
    if (!match) {
      throw new Error(`No MemoryRecordAdded event found with content "${content}"`);
    }
    return match;
  }

  it('1. POST {content} -> 201, record has the given content, a non-empty kaynakOlayId, deletedAt null, createdAt/updatedAt filled', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const content = freshContent('first memory');

    const response = await createRecord(cookie, workspaceId, { content });

    expect(response.status).toBe(201);
    const record = (response.body as RecordEnvelope).record;
    expect(record.content).toBe(content);
    expect(typeof record.kaynakOlayId).toBe('string');
    expect(record.kaynakOlayId.length).toBeGreaterThan(0);
    expect(record.deletedAt).toBeNull();
    expect(record.createdAt).toBeDefined();
    expect(record.updatedAt).toBeDefined();
  });

  it('2. kaynakOlayId is a TRUE self-reference: it equals the id of the MemoryRecordAdded event that created the record (ADR-0022 Karar b)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const content = freshContent('self-reference memory');

    const response = await createRecord(cookie, workspaceId, { content });
    expect(response.status).toBe(201);
    const record = (response.body as RecordEnvelope).record;

    const addedEvent = await findAddedEvent(workspaceId, content);
    expect(record.kaynakOlayId).toBe(addedEvent.id);
  });

  it('3. GET / lists created records for the calling user in the workspace', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const content = freshContent('listed memory');
    const created = await createRecord(cookie, workspaceId, { content });
    const createdId = (created.body as RecordEnvelope).record.id;

    const response = await listRecords(cookie, workspaceId);

    expect(response.status).toBe(200);
    const ids = (response.body as RecordsListEnvelope).records.map((r) => r.id);
    expect(ids).toContain(createdId);
  });

  it('4. PATCH :id fully REPLACES content (no merge/patch), and updates updatedAt (ADR-0022 Karar e)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const originalContent = freshContent('before edit');
    const created = await createRecord(cookie, workspaceId, { content: originalContent });
    const record = (created.body as RecordEnvelope).record;

    await new Promise((resolve) => setTimeout(resolve, 5));

    const newContent = freshContent('after edit, fully replaced');
    const response = await editRecord(cookie, workspaceId, record.id, { content: newContent });

    expect(response.status).toBe(200);
    const edited = (response.body as RecordEnvelope).record;
    expect(edited.content).toBe(newContent);
    expect(edited.content).not.toContain(originalContent);
    expect(edited.updatedAt).not.toBe(record.updatedAt);
    expect(edited.createdAt).toBe(record.createdAt);
  });

  it('5. DELETE :id tombstones the record: the row is NOT physically removed (still present via raw DB, deletedAt set) — ADR-0022 Karar d, the critical tombstone test', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const content = freshContent('to be tombstoned');
    const created = await createRecord(cookie, workspaceId, { content });
    const record = (created.body as RecordEnvelope).record;

    const response = await deleteRecord(cookie, workspaceId, record.id);
    expect([200, 204]).toContain(response.status);

    const rows = await rawDb.select().from(memoryRecords).where(eq(memoryRecords.id, record.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).not.toBeNull();
    expect(rows[0]?.content).toBe(content);
  });

  it('6. after DELETE, the record never appears again in GET / (tombstone-invisibility, ADR-0022 Karar d)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const content = freshContent('vanishes after delete');
    const created = await createRecord(cookie, workspaceId, { content });
    const record = (created.body as RecordEnvelope).record;

    await deleteRecord(cookie, workspaceId, record.id);

    const response = await listRecords(cookie, workspaceId);
    expect(response.status).toBe(200);
    const ids = (response.body as RecordsListEnvelope).records.map((r) => r.id);
    expect(ids).not.toContain(record.id);
  });

  it("7. cross-user isolation (same workspace): a DIFFERENT member cannot edit or delete another user's memory record — treated as not found, and the original row is untouched", async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const { cookie: otherCookie } = await addMemberWithRole(workspaceId, 'member');

    const content = freshContent('owner-only memory');
    const created = await createRecord(ownerCookie, workspaceId, { content });
    const record = (created.body as RecordEnvelope).record;

    const editAttempt = await editRecord(otherCookie, workspaceId, record.id, {
      content: 'attacker-edited content',
    });
    expect(editAttempt.status).toBe(404);

    const deleteAttempt = await deleteRecord(otherCookie, workspaceId, record.id);
    expect(deleteAttempt.status).toBe(404);

    const rows = await rawDb.select().from(memoryRecords).where(eq(memoryRecords.id, record.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe(content);
    expect(rows[0]?.deletedAt).toBeNull();
  });

  it("8. cross-user isolation: a DIFFERENT member's GET / never lists another user's memory records", async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const { cookie: otherCookie } = await addMemberWithRole(workspaceId, 'member');

    const content = freshContent('owner-only listed memory');
    const created = await createRecord(ownerCookie, workspaceId, { content });
    const record = (created.body as RecordEnvelope).record;

    const response = await listRecords(otherCookie, workspaceId);
    expect(response.status).toBe(200);
    const ids = (response.body as RecordsListEnvelope).records.map((r) => r.id);
    expect(ids).not.toContain(record.id);
  });

  it("9. cross-workspace isolation: a record created in workspace A is invisible/unreachable via workspace B's routes, even to a member of B (ADR-0022 Karar f)", async () => {
    const { cookie: cookieA, workspaceId: workspaceIdA } = await registerOwnerWithWorkspace();
    const { cookie: cookieB, workspaceId: workspaceIdB } = await registerOwnerWithWorkspace();

    const content = freshContent('workspace A only');
    const created = await createRecord(cookieA, workspaceIdA, { content });
    const record = (created.body as RecordEnvelope).record;

    const listInB = await listRecords(cookieB, workspaceIdB);
    expect(listInB.status).toBe(200);
    expect((listInB.body as RecordsListEnvelope).records.map((r) => r.id)).not.toContain(record.id);

    const editInB = await editRecord(cookieB, workspaceIdB, record.id, { content: 'hijacked' });
    expect(editInB.status).toBe(404);

    const deleteInB = await deleteRecord(cookieB, workspaceIdB, record.id);
    expect(deleteInB.status).toBe(404);
  });

  it('10. unauthenticated -> 401 on every route; authenticated non-member -> 403', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const { cookie: outsiderCookie } = await registerUser();
    const created = await createRecord(ownerCookie, workspaceId, {
      content: freshContent('guard test'),
    });
    const record = (created.body as RecordEnvelope).record;

    const unauthGet = await request(server).get(memoryUrl(workspaceId));
    expect(unauthGet.status).toBe(401);

    const unauthPost = await request(server).post(memoryUrl(workspaceId)).send({ content: 'x' });
    expect(unauthPost.status).toBe(401);

    const unauthPatch = await request(server)
      .patch(`${memoryUrl(workspaceId)}/${record.id}`)
      .send({ content: 'x' });
    expect(unauthPatch.status).toBe(401);

    const unauthDelete = await request(server).delete(`${memoryUrl(workspaceId)}/${record.id}`);
    expect(unauthDelete.status).toBe(401);

    const nonMemberGet = await listRecords(outsiderCookie, workspaceId);
    expect(nonMemberGet.status).toBe(403);

    const nonMemberPost = await createRecord(outsiderCookie, workspaceId, { content: 'x' });
    expect(nonMemberPost.status).toBe(403);
  });

  it('11. self-service by construction: a fake userId in the POST/PATCH body is IGNORED — identity always comes from the session (req.user.id)', async () => {
    const {
      cookie: sessionCookie,
      userId: sessionUserId,
      workspaceId,
    } = await registerOwnerWithWorkspace();
    const { userId: otherUserId } = await registerUser();

    const content = freshContent('spoofed userId attempt');
    const response = await createRecord(sessionCookie, workspaceId, {
      content,
      userId: otherUserId,
    });
    expect(response.status).toBe(201);

    const rows = await rawDb
      .select()
      .from(memoryRecords)
      .where(eq(memoryRecords.workspaceId, workspaceId));
    const persisted = rows.find((row) => row.content === content);
    expect(persisted).toBeDefined();
    expect(persisted?.userId).toBe(sessionUserId);
    expect(persisted?.userId).not.toBe(otherUserId);
  });

  it('12. editing or deleting a nonexistent recordId fails cleanly (404), not a 500 or silent success', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const bogusId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

    const editResponse = await editRecord(cookie, workspaceId, bogusId, { content: 'no-op' });
    expect(editResponse.status).toBe(404);

    const deleteResponse = await deleteRecord(cookie, workspaceId, bogusId);
    expect(deleteResponse.status).toBe(404);
  });

  it('13. per-record streamId is a random, independent UUID — NOT deterministically derived from (workspaceId, userId) — ADR-0022 Karar c, a deliberate divergence from DesktopSignalConsentsService', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const contentOne = freshContent('independent stream one');
    const contentTwo = freshContent('independent stream two');

    await createRecord(cookie, workspaceId, { content: contentOne });
    await createRecord(cookie, workspaceId, { content: contentTwo });

    const eventOne = await findAddedEvent(workspaceId, contentOne);
    const eventTwo = await findAddedEvent(workspaceId, contentTwo);

    expect(eventOne.streamId).not.toBe(eventTwo.streamId);
  });

  it('14. full event-log lifecycle: add/edit/delete append sequentially to the SAME per-record stream, with the exact expected payloads and versions (proves the event log, not just the projection, is correct)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const originalContent = freshContent('lifecycle original');
    const created = await createRecord(cookie, workspaceId, { content: originalContent });
    const record = (created.body as RecordEnvelope).record;

    const addedEvent = await findAddedEvent(workspaceId, originalContent);
    const streamId = addedEvent.streamId;

    const editedContent = freshContent('lifecycle edited');
    await editRecord(cookie, workspaceId, record.id, { content: editedContent });
    await deleteRecord(cookie, workspaceId, record.id);

    const streamEvents = await eventStore.readStream(streamId);
    expect(streamEvents).toHaveLength(3);

    expect(streamEvents[0]?.type).toBe('MemoryRecordAdded');
    expect(streamEvents[0]?.version).toBe(1);
    expect(streamEvents[0]?.payload['content']).toBe(originalContent);

    expect(streamEvents[1]?.type).toBe('MemoryRecordEdited');
    expect(streamEvents[1]?.version).toBe(2);
    expect(streamEvents[1]?.payload['content']).toBe(editedContent);

    expect(streamEvents[2]?.type).toBe('MemoryRecordDeleted');
    expect(streamEvents[2]?.version).toBe(3);
    expect(streamEvents[2]?.payload).toEqual({});

    // Tombstone timestamp comes from the deleting event's own occurredAt,
    // not "now" at read time (ADR-0022 Karar d).
    const rows = await rawDb.select().from(memoryRecords).where(eq(memoryRecords.id, record.id));
    expect(rows[0]?.deletedAt?.toISOString()).toBe(streamEvents[2]?.occurredAt.toISOString());
  });

  it('15. rebuild-determinism (F0-T6 AC4): a projectionRunner.rebuild reproduces the exact same content/deletedAt state from the event log', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const originalContent = freshContent('rebuild original');
    const created = await createRecord(cookie, workspaceId, { content: originalContent });
    const record = (created.body as RecordEnvelope).record;

    const editedContent = freshContent('rebuild edited');
    await editRecord(cookie, workspaceId, record.id, { content: editedContent });

    const secondRecord = await createRecord(cookie, workspaceId, {
      content: freshContent('rebuild untouched sibling'),
    });
    const sibling = (secondRecord.body as RecordEnvelope).record;
    await deleteRecord(cookie, workspaceId, sibling.id);

    const snapshot = async (): Promise<
      { id: string; content: string; deletedAt: string | null }[]
    > => {
      const rows = await rawDb
        .select()
        .from(memoryRecords)
        .where(eq(memoryRecords.workspaceId, workspaceId));
      return rows
        .map((row) => ({
          id: row.id,
          content: row.content,
          deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    };

    const beforeRebuild = await snapshot();

    const { MemoryRecordProjection } = await import('./memory-record.projection.js');
    await projectionRunner.rebuild(new MemoryRecordProjection());

    const afterRebuild = await snapshot();

    expect(afterRebuild).toEqual(beforeRebuild);
  });
});
