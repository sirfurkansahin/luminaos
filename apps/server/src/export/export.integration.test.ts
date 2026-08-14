import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import ICAL from 'ical.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { calendarAccounts } from '../db/schema/calendar-accounts.js';
import { calendarEventsCache } from '../db/schema/calendar-events-cache.js';
import { documentSnapshots } from '../db/schema/document-snapshots.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T18 PR3 (RED step) additions below -- ADR-0016 §(e): `format=ical`
 * (hand-written RFC5545 `VEVENT` generator, `./ical-generator.ts`, wired
 * through `ExportService`/`ExportController` -- neither exists yet, so
 * EVERY `format=ical` request below is expected to 400 via the SAME zod
 * `format` enum rejection the existing "format is required" test above
 * already exercises for `format=csv` (an unrecognized enum member), NOT via
 * a 404 route-not-found the way PR1's own original RED-state comment
 * describes -- `GET /workspaces/:workspaceId/export` itself already exists
 * (PR1/PR2 merged), only the `'ical'` branch of its `format` handling is
 * new. `ical.js` here is a TEST-ONLY devDependency (already installed, see
 * `apps/server/package.json`) used purely to parse+validate the raw
 * `text/calendar` response bodies below against a real, independent
 * RFC5545 parser -- `ical-generator.ts` itself (the implementation) takes
 * on NO new runtime dependency per ADR-0016 §(e).
 *
 * Only native `timeblock`-type `LuminaObject`s (scheduled via the existing
 * `POST /workspaces/:workspaceId/objects/:objectId/timeblock` route, F1-T12
 * PR5d, already merged) are ever eligible; `calendar_events_cache` rows
 * (third-party-owned, read-only cache) are structurally excluded since
 * `ExportService` only ever reads `LuminaObject`s off `objects_view`.
 */

/**
 * F1-T18 PR1: real, end-to-end integration test for the JSON data-export HTTP
 * surface, mirroring `../fields/field-definitions-security.integration.
 * test.ts`'s exact harness (same Testcontainers Postgres 16 + Redis 7 pair,
 * same dynamic `import('../app.module.js')` AFTER `DATABASE_URL`/`REDIS_URL`
 * are set, same `toCookieHeader`/`registerUser`/`createWorkspace`/
 * `registerAdminWithWorkspace`/`addMemberWithRole` helpers copied verbatim)
 * and `../objects/objects.integration.test.ts`'s object-creation/response-
 * shape conventions. Nothing here is mocked.
 *
 * ============================================================================
 * RED STATE (expected, today): `AppModule` (`../app.module.ts`) does not yet
 * import an `ExportModule` — there is no `export.module.ts`,
 * `export.controller.ts`, or `export.service.ts` yet under
 * `apps/server/src/export/` (this is a brand-new, greenfield directory).
 * Every request below to `/workspaces/:workspaceId/export...` is therefore
 * expected to 404 via Nest's own default "Cannot GET ..." handler (there is
 * no matching route at all), NOT via `AppErrorFilter` mapping an `AppError` —
 * this file's assertions will fail with e.g. "expected 404 to be 200" and the
 * body will be Nest's default `{"message":"Cannot GET /workspaces/.../
 * export","error":"Not Found","statusCode":404}` shape rather than the pinned
 * export envelope. That is the correct red: it means the ROUTE doesn't exist
 * yet, not that test logic itself is wrong. `implementer` must:
 *   - add `ExportModule` (imported by `AppModule`) with `ExportController`/
 *     `ExportService` under `apps/server/src/export/`;
 *   - add a new `getAllForWorkspace(workspaceId: string): Promise<Relation[]>`
 *     public method to `RelationsService` (mirrors its existing
 *     `getActiveRelationsOfKind`, just without the `kind` filter — needed so
 *     `ExportService` can fetch every relation in a workspace, not just one
 *     kind).
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely, per
 * ADR-0016 `docs/adr/ADR-0016-veri-disa-aktarma-rbac-kapsam.md`):
 *
 * `GET /workspaces/:workspaceId/export?format=json[&objectId=]`, guarded by
 * `@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)` at the class level
 * — the SAME guard stack as `ObjectsController`/`RelationsController`, NO
 * role gate beyond plain membership (ADR-0016 §a's central decision: a
 * `guest` succeeds here, unlike `FieldsController`'s admin-gated schema
 * routes).
 *
 * Query params, validated via a zod schema + `ZodValidationPipe` (`.strict()`):
 * - `format` — required, only `'json'` accepted in this PR; missing/unknown
 *   -> 400.
 * - `objectId` — optional string; narrows the export to a single object (and
 *   only relations/field-definitions touching it) when given, whole-workspace
 *   otherwise. A nonexistent `objectId` -> 404.
 *
 * Response body (200, no wrapper envelope — this shape IS the top-level
 * body):
 * ```
 * {
 *   workspaceId: string,
 *   exportedAt: string (ISO-8601),
 *   objects: ObjectWithFieldValues[],
 *   fieldDefinitions: Record<ObjectType, FieldDefinition[]>,
 *   relations: Relation[],
 * }
 * ```
 *
 * `objects`/`fieldDefinitions` inherit the SAME `lifecycle != 'deleted'` base
 * predicate and the SAME role-based `fieldValues`/`fieldDefinitions`
 * filtering that every other read path (`ObjectsService.list`,
 * `FieldsController`'s `GET /fields`) already applies — the export endpoint
 * must not leak a shape or value the caller couldn't already see elsewhere.
 * `relations` excludes any relation whose counterpart object is not present
 * in the same export's `objects` (soft-deleted counterpart), mirroring
 * `RelationsService.getRelated`'s "suspended when counterpart deleted"
 * behavior.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface FieldPermissionsBody {
  owner: string;
  admin: string;
  member: string;
  guest: string;
}

interface ObjectContentBody {
  format: string;
  text: string;
}

interface ObjectBody {
  id: string;
  type: string;
  workspaceId: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lifecycle: string;
  fieldValues: Record<string, unknown>;
  /**
   * F1-T18 PR2 (ADR-0016 §d): only present for `type === 'doc'` objects,
   * derived from the doc's latest Yjs snapshot via
   * `extractMarkdownFromYjsUpdate`. Absent (not merely empty) for every other
   * object type.
   */
  content?: ObjectContentBody;
}

interface ObjectEnvelope {
  object: ObjectBody;
}

interface FieldDefinitionBody {
  id: string;
  key: string;
  objectType: string;
}

interface FieldDefinitionEnvelope {
  fieldDefinition: FieldDefinitionBody;
}

interface RelationBody {
  id: string;
  workspaceId: string;
  fromId: string;
  toId: string;
  kind: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface RelationEnvelope {
  relation: RelationBody;
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

interface ExportBody {
  workspaceId: string;
  exportedAt: string;
  objects: ObjectBody[];
  fieldDefinitions: Record<string, FieldDefinitionBody[]>;
  relations: RelationBody[];
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

const EDIT_ALL_PERMISSIONS: FieldPermissionsBody = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'edit',
};

const HIDDEN_FOR_GUEST_PERMISSIONS: FieldPermissionsBody = {
  owner: 'edit',
  admin: 'edit',
  member: 'edit',
  guest: 'hidden',
};

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `export-test-user-${String(emailCounter)}@example.com`;
}

/**
 * F1-T18 PR2 additions (ADR-0016 §d) below. Builds a real Yjs full-state
 * update (mirrors `../docs/yjs-to-markdown.test.ts`'s own `buildUpdate`
 * helper and `../docs/yjs-plain-text.test.ts`'s `buildUpdate`) for direct
 * insertion into `document_snapshots` via `rawDb`, exercising the SAME
 * `'document-store'` fragment key `extractMarkdownFromYjsUpdate` reads.
 */
function buildDocSnapshotBuffer(populate: (fragment: Y.XmlFragment) => void): Buffer {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment('document-store');
  populate(fragment);
  return Buffer.from(Y.encodeStateAsUpdate(ydoc));
}

/**
 * Populates a fragment with the real BlockNote tree shape (a single
 * top-level `blockGroup` wrapping one `blockContainer` wrapping one
 * `paragraph`) holding `text` — the minimum real structure
 * `extractMarkdownFromYjsUpdate` needs to render `text` back out verbatim
 * (see `../docs/yjs-to-markdown.test.ts` for the full fixture-shape
 * rationale). Deliberately NOT imported from that unit test file — each test
 * file stays self-contained per this repo's convention.
 */
function populateSimpleDoc(text: string): (fragment: Y.XmlFragment) => void {
  return (fragment) => {
    const paragraph = new Y.XmlElement('paragraph');
    const xmlText = new Y.XmlText();
    xmlText.insert(0, text);
    paragraph.insert(0, [xmlText]);

    const container = new Y.XmlElement('blockContainer');
    container.insert(0, [paragraph]);

    const group = new Y.XmlElement('blockGroup');
    group.insert(0, [container]);

    fragment.insert(0, [group]);
  };
}

describe('Data export (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
    rawDb = createDatabaseClient(container.getConnectionUri());
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

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

  async function registerAdminWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const { cookie } = await registerUser();
    const workspaceId = await createWorkspace(cookie, `Export Workspace ${String(emailCounter)}`);
    return { cookie, workspaceId };
  }

  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<string> {
    const { cookie, userId } = await registerUser();
    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return cookie;
  }

  async function createObject(
    cookie: string,
    workspaceId: string,
    objectType: string,
    title: string,
  ): Promise<ObjectBody> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType, title });

    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object;
  }

  async function deleteObject(
    cookie: string,
    workspaceId: string,
    objectId: string,
  ): Promise<void> {
    const response = await request(server)
      .delete(`/workspaces/${workspaceId}/objects/${objectId}`)
      .set('Cookie', cookie);

    expect(response.status).toBe(204);
  }

  async function createReferenceRelation(
    cookie: string,
    workspaceId: string,
    fromId: string,
    toId: string,
  ): Promise<RelationBody> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/relations`)
      .set('Cookie', cookie)
      .send({ fromId, toId, kind: 'reference' });

    expect(response.status).toBe(201);
    return (response.body as RelationEnvelope).relation;
  }

  async function defineField(
    cookie: string,
    workspaceId: string,
    objectType: string,
    key: string,
    permissions: FieldPermissionsBody,
  ): Promise<FieldDefinitionBody> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/object-types/${objectType}/fields`)
      .set('Cookie', cookie)
      .send({
        key,
        label: key,
        fieldType: 'text',
        config: {},
        permissions,
      });

    expect(response.status).toBe(201);
    return (response.body as FieldDefinitionEnvelope).fieldDefinition;
  }

  async function setFieldValue(
    cookie: string,
    workspaceId: string,
    objectId: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    const response = await request(server)
      .patch(`/workspaces/${workspaceId}/objects/${objectId}/fields`)
      .set('Cookie', cookie)
      .send({ values: { [key]: value } });

    expect(response.status).toBe(200);
  }

  function exportUrl(workspaceId: string, query: string): string {
    return `/workspaces/${workspaceId}/export?${query}`;
  }

  /**
   * F1-T18 PR2: inserts a real `document_snapshots` row directly via
   * `rawDb`, bypassing HTTP (there is no snapshot-write HTTP endpoint —
   * snapshots are written by the doc-collab projection, out of scope here).
   * `version` is fixed at `1`: only the latest snapshot per `objectId` is
   * ever read (`MAX(version)`), and these tests never write more than one.
   */
  async function insertDocSnapshot(
    workspaceId: string,
    objectId: string,
    snapshot: Buffer,
  ): Promise<void> {
    await rawDb.insert(documentSnapshots).values({
      objectId,
      version: 1,
      snapshot,
      workspaceId,
      createdAt: new Date(),
    });
  }

  /**
   * F1-T18 PR3: schedules an existing `timeblock`-type object's `start`/
   * `end` via the already-merged (F1-T12 PR5d)
   * `POST /workspaces/:workspaceId/objects/:objectId/timeblock` route --
   * NOT new scope introduced by this file, only reused as a fixture-setup
   * helper for the `format=ical` tests below.
   */
  async function scheduleTimeblock(
    cookie: string,
    workspaceId: string,
    objectId: string,
    start: string,
    end: string,
  ): Promise<void> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects/${objectId}/timeblock`)
      .set('Cookie', cookie)
      .send({ start, end });

    expect(response.status).toBe(200);
  }

  /**
   * F1-T18 PR3: inserts a real `calendar_accounts` row followed by a real
   * `calendar_events_cache` row directly via `rawDb` (there is no HTTP
   * endpoint that writes either -- both are populated by
   * `CalendarSyncPollerService`'s periodic polling, out of scope here,
   * mirroring `insertDocSnapshot`'s own bypass-HTTP rationale). Used ONLY
   * to prove ADR-0016 §(e)'s exclusion-by-construction: these rows must
   * NEVER surface in a `format=ical` response.
   */
  async function insertExternalCalendarEvent(
    workspaceId: string,
    userId: string,
    title: string,
    externalId: string,
    eventStart: Date,
    eventEnd: Date,
  ): Promise<void> {
    const [account] = await rawDb
      .insert(calendarAccounts)
      .values({
        workspaceId,
        userId,
        provider: 'google',
        encryptedAccessToken: 'placeholder-ciphertext',
        encryptedRefreshToken: 'placeholder-ciphertext',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .returning({ id: calendarAccounts.id });

    if (!account) {
      throw new Error('failed to insert calendar_accounts fixture row');
    }

    await rawDb.insert(calendarEventsCache).values({
      calendarAccountId: account.id,
      workspaceId,
      externalId,
      title,
      eventStart,
      eventEnd,
    });
  }

  type ParsedIcalComponent = InstanceType<typeof ICAL.Component>;
  type ParsedIcalEvent = InstanceType<typeof ICAL.Event>;

  /**
   * Parses a raw `format=ical` response body (`response.text`, never
   * `response.body` -- same "not a JSON response" precedent as
   * `format=markdown` above) via the real `ical.js` parser. Mirrors
   * `../export/ical-generator.test.ts`'s own `parseICalendar`/`parseVevents`
   * helpers exactly (each test file stays self-contained per this repo's
   * convention, so this is deliberately duplicated rather than imported).
   */
  function parseICalendar(raw: string): ParsedIcalComponent {
    // `ICAL.parse`'s own shipped `.d.ts` declares its return type as the
    // literal `any` -- narrowed here to `unknown[]` (assignable to
    // `Component`'s own `any[] | string` constructor parameter) rather than
    // left as `any`, per CLAUDE.md's `any` ban.
    const jcalData = ICAL.parse(raw) as unknown[];
    return new ICAL.Component(jcalData);
  }

  function parseVevents(raw: string): ParsedIcalEvent[] {
    const component = parseICalendar(raw);
    return component.getAllSubcomponents('vevent').map((vevent) => new ICAL.Event(vevent));
  }

  // ---------------------------------------------------------------------
  // 1. RBAC — the ADR's central proof: a "guest" caller succeeds (200),
  // no role gate beyond plain workspace membership.
  // ---------------------------------------------------------------------
  it('a "guest" role caller (the LOWEST rank) gets 200 with real data — no role-based gate on export (ADR-0016 §a)', async () => {
    const { cookie: adminCookie, workspaceId } = await registerAdminWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    await createObject(adminCookie, workspaceId, 'task', 'Guest-visible task');

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=json'))
      .set('Cookie', guestCookie);

    expect(response.status).toBe(200);
    const body = response.body as ExportBody;
    expect(body.workspaceId).toBe(workspaceId);
    expect(body.objects.length).toBeGreaterThan(0);
  });

  it('format is required; an unknown/missing format returns 400', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const missingFormatResponse = await request(server)
      .get(`/workspaces/${workspaceId}/export`)
      .set('Cookie', cookie);
    expect(missingFormatResponse.status).toBe(400);

    const unknownFormatResponse = await request(server)
      .get(exportUrl(workspaceId, 'format=csv'))
      .set('Cookie', cookie);
    expect(unknownFormatResponse.status).toBe(400);
  });

  // ---------------------------------------------------------------------
  // 2. Whole-workspace export + 4. nonexistent objectId -> 404 (shared setup).
  // ---------------------------------------------------------------------
  it('whole-workspace export (no objectId) includes every created object across types, and a nonexistent objectId returns 404', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const task = await createObject(cookie, workspaceId, 'task', 'Task A');
    const doc = await createObject(cookie, workspaceId, 'doc', 'Doc B');
    const note = await createObject(cookie, workspaceId, 'note', 'Note C');

    const beforeRequest = new Date();
    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=json'))
      .set('Cookie', cookie);
    const afterRequest = new Date();

    expect(response.status).toBe(200);
    const body = response.body as ExportBody;

    expect(body.workspaceId).toBe(workspaceId);

    const exportedAt = new Date(body.exportedAt);
    expect(exportedAt.toString()).not.toBe('Invalid Date');
    expect(exportedAt.getTime()).toBeGreaterThanOrEqual(beforeRequest.getTime() - 1000);
    expect(exportedAt.getTime()).toBeLessThanOrEqual(afterRequest.getTime() + 1000);

    const exportedIds = body.objects.map((o) => o.id);
    expect(exportedIds).toContain(task.id);
    expect(exportedIds).toContain(doc.id);
    expect(exportedIds).toContain(note.id);

    // 4. Nonexistent objectId -> 404, on an otherwise real workspace.
    const notFoundResponse = await request(server)
      .get(exportUrl(workspaceId, 'format=json&objectId=does-not-exist'))
      .set('Cookie', cookie);
    expect(notFoundResponse.status).toBe(404);
  });

  // ---------------------------------------------------------------------
  // 3. objectId narrowing.
  // ---------------------------------------------------------------------
  it('objectId narrowing: exports exactly the requested object, excluding all others', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const objectOne = await createObject(cookie, workspaceId, 'task', 'Object One');
    const objectTwo = await createObject(cookie, workspaceId, 'task', 'Object Two');

    const response = await request(server)
      .get(exportUrl(workspaceId, `format=json&objectId=${objectOne.id}`))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const body = response.body as ExportBody;

    expect(body.objects).toHaveLength(1);
    expect(body.objects[0]?.id).toBe(objectOne.id);
    expect(body.objects.map((o) => o.id)).not.toContain(objectTwo.id);
  });

  // ---------------------------------------------------------------------
  // 3b. objectId narrowing still includes the narrowed object's OWN
  // relations to objects outside the narrowed set (security-review
  // finding: a same-set-membership filter on both relation endpoints is
  // always empty when the set has exactly one element, since self-relations
  // are rejected by createRelation — narrowing must instead keep relations
  // touching objectId whose COUNTERPART is any valid, visible object in the
  // workspace, not just objects inside the narrowed export itself).
  // ---------------------------------------------------------------------
  it('objectId narrowing still includes relations touching the narrowed object, even though the counterpart object itself is excluded from `objects`', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const objectOne = await createObject(cookie, workspaceId, 'task', 'Object One');
    const objectTwo = await createObject(cookie, workspaceId, 'task', 'Object Two');
    await createReferenceRelation(cookie, workspaceId, objectOne.id, objectTwo.id);

    const response = await request(server)
      .get(exportUrl(workspaceId, `format=json&objectId=${objectOne.id}`))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const body = response.body as ExportBody;

    expect(body.objects).toHaveLength(1);
    expect(body.objects[0]?.id).toBe(objectOne.id);

    const match = body.relations.find(
      (relation) =>
        relation.fromId === objectOne.id &&
        relation.toId === objectTwo.id &&
        relation.kind === 'reference',
    );
    expect(match).toBeDefined();

    // A relation NOT touching the narrowed object must still be excluded.
    const objectThree = await createObject(cookie, workspaceId, 'task', 'Object Three');
    await createReferenceRelation(cookie, workspaceId, objectTwo.id, objectThree.id);

    const secondResponse = await request(server)
      .get(exportUrl(workspaceId, `format=json&objectId=${objectOne.id}`))
      .set('Cookie', cookie);
    const secondBody = secondResponse.body as ExportBody;

    const unrelatedMatch = secondBody.relations.find(
      (relation) => relation.fromId === objectTwo.id && relation.toId === objectThree.id,
    );
    expect(unrelatedMatch).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // 5. lifecycle != 'deleted' inheritance.
  // ---------------------------------------------------------------------
  it('a soft-deleted object is excluded from a whole-workspace export (inherits the same lifecycle != "deleted" predicate as every other read path)', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const survivor = await createObject(cookie, workspaceId, 'task', 'Survivor');
    const doomed = await createObject(cookie, workspaceId, 'task', 'Doomed');

    await deleteObject(cookie, workspaceId, doomed.id);

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=json'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const body = response.body as ExportBody;

    const exportedIds = body.objects.map((o) => o.id);
    expect(exportedIds).toContain(survivor.id);
    expect(exportedIds).not.toContain(doomed.id);
  });

  // ---------------------------------------------------------------------
  // 6. Relations included, in both directions.
  // ---------------------------------------------------------------------
  it('relations between two objects are included in the export', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const objectA = await createObject(cookie, workspaceId, 'task', 'A');
    const objectB = await createObject(cookie, workspaceId, 'task', 'B');

    await createReferenceRelation(cookie, workspaceId, objectA.id, objectB.id);

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=json'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const body = response.body as ExportBody;

    const match = body.relations.find(
      (relation) =>
        relation.fromId === objectA.id &&
        relation.toId === objectB.id &&
        relation.kind === 'reference',
    );
    expect(match).toBeDefined();
  });

  // ---------------------------------------------------------------------
  // 7. Dangling relations excluded when a counterpart is soft-deleted.
  // ---------------------------------------------------------------------
  it('a relation is excluded when its counterpart object is soft-deleted, but the surviving object still appears', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const objectA = await createObject(cookie, workspaceId, 'task', 'Surviving A');
    const objectB = await createObject(cookie, workspaceId, 'task', 'Deleted B');

    await createReferenceRelation(cookie, workspaceId, objectA.id, objectB.id);
    await deleteObject(cookie, workspaceId, objectB.id);

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=json'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const body = response.body as ExportBody;

    const danglingMatch = body.relations.find(
      (relation) => relation.fromId === objectA.id && relation.toId === objectB.id,
    );
    expect(danglingMatch).toBeUndefined();

    const exportedIds = body.objects.map((o) => o.id);
    expect(exportedIds).toContain(objectA.id);
    expect(exportedIds).not.toContain(objectB.id);
  });

  // ---------------------------------------------------------------------
  // 8. Field-definition schema included, role-filtered consistently with
  // fieldValues.
  // ---------------------------------------------------------------------
  it('field definitions are included in the export and role-filtered consistently with fieldValues (hidden-for-guest is omitted from both)', async () => {
    const { cookie: adminCookie, workspaceId } = await registerAdminWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    const secretField = await defineField(
      adminCookie,
      workspaceId,
      'task',
      'secret-export-field',
      HIDDEN_FOR_GUEST_PERMISSIONS,
    );

    const task = await createObject(adminCookie, workspaceId, 'task', 'Task with secret field');
    await setFieldValue(adminCookie, workspaceId, task.id, secretField.key, 'sensitive value');

    // Admin/owner export: definition AND value both present.
    const adminResponse = await request(server)
      .get(exportUrl(workspaceId, 'format=json'))
      .set('Cookie', adminCookie);

    expect(adminResponse.status).toBe(200);
    const adminBody = adminResponse.body as ExportBody;

    const adminTaskDefinitionKeys = (adminBody.fieldDefinitions['task'] ?? []).map((fd) => fd.key);
    expect(adminTaskDefinitionKeys).toContain(secretField.key);

    const adminExportedTask = adminBody.objects.find((o) => o.id === task.id);
    expect(adminExportedTask).toBeDefined();
    expect(adminExportedTask?.fieldValues).toHaveProperty(secretField.key);

    // Guest export: definition AND value both omitted (must not leak the
    // SHAPE of a field the caller can't see the VALUE of either).
    const guestResponse = await request(server)
      .get(exportUrl(workspaceId, 'format=json'))
      .set('Cookie', guestCookie);

    expect(guestResponse.status).toBe(200);
    const guestBody = guestResponse.body as ExportBody;

    const guestTaskDefinitionKeys = (guestBody.fieldDefinitions['task'] ?? []).map((fd) => fd.key);
    expect(guestTaskDefinitionKeys).not.toContain(secretField.key);

    const guestExportedTask = guestBody.objects.find((o) => o.id === task.id);
    expect(guestExportedTask).toBeDefined();
    expect(guestExportedTask?.fieldValues).not.toHaveProperty(secretField.key);
  });

  // ---------------------------------------------------------------------
  // 9. Multiple object types -> grouped fieldDefinitions.
  // ---------------------------------------------------------------------
  it('fieldDefinitions is grouped separately per object type present in the export', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const taskField = await defineField(
      cookie,
      workspaceId,
      'task',
      'task-only-field',
      EDIT_ALL_PERMISSIONS,
    );
    const docField = await defineField(
      cookie,
      workspaceId,
      'doc',
      'doc-only-field',
      EDIT_ALL_PERMISSIONS,
    );

    await createObject(cookie, workspaceId, 'task', 'A task');
    await createObject(cookie, workspaceId, 'doc', 'A doc');

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=json'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const body = response.body as ExportBody;

    const taskKeys = (body.fieldDefinitions['task'] ?? []).map((fd) => fd.key);
    const docKeys = (body.fieldDefinitions['doc'] ?? []).map((fd) => fd.key);

    expect(taskKeys).toContain(taskField.key);
    expect(taskKeys).not.toContain(docField.key);

    expect(docKeys).toContain(docField.key);
    expect(docKeys).not.toContain(taskField.key);
  });

  it('guard stack: unauthenticated requests are rejected with 401, non-members with 403', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerAdminWithWorkspace();

    const noSessionResponse = await request(server).get(exportUrl(workspaceId, 'format=json'));
    expect(noSessionResponse.status).toBe(401);

    const { cookie: outsiderCookie } = await registerUser();
    const outsiderResponse = await request(server)
      .get(exportUrl(workspaceId, 'format=json'))
      .set('Cookie', outsiderCookie);
    expect(outsiderResponse.status).toBe(403);

    const ownerResponse = await request(server)
      .get(exportUrl(workspaceId, 'format=json'))
      .set('Cookie', ownerCookie);
    expect(ownerResponse.status).toBe(200);
  });

  // =======================================================================
  // F1-T18 PR2 (ADR-0016 §d): format=markdown HTTP behavior.
  // =======================================================================

  it('format=markdown requires objectId; a missing objectId returns 400', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=markdown'))
      .set('Cookie', cookie);

    expect(response.status).toBe(400);
  });

  it('format=markdown with an objectId of the wrong type (e.g. a task, not a doc) returns 400', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();
    const task = await createObject(cookie, workspaceId, 'task', 'Not a doc');

    const response = await request(server)
      .get(exportUrl(workspaceId, `format=markdown&objectId=${task.id}`))
      .set('Cookie', cookie);

    expect(response.status).toBe(400);
  });

  it('format=markdown with a nonexistent objectId returns 404', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=markdown&objectId=does-not-exist'))
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
  });

  it('format=markdown for a doc object with a real snapshot returns 200, Content-Type text/markdown, and the converted Markdown as the raw text body', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();
    const doc = await createObject(cookie, workspaceId, 'doc', 'A real doc');

    const snapshot = buildDocSnapshotBuffer(populateSimpleDoc('Integration test content'));
    await insertDocSnapshot(workspaceId, doc.id, snapshot);

    const response = await request(server)
      .get(exportUrl(workspaceId, `format=markdown&objectId=${doc.id}`))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.type).toContain('text/markdown');
    expect(response.text).toBe('Integration test content');
  });

  it('format=markdown for a doc object with NO snapshot yet returns 200 with an empty string body (not 404 — an unedited doc is a valid empty document)', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();
    const doc = await createObject(cookie, workspaceId, 'doc', 'Doc without a snapshot');

    const response = await request(server)
      .get(exportUrl(workspaceId, `format=markdown&objectId=${doc.id}`))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.text).toBe('');
  });

  it('format=markdown: a "guest" role caller succeeds for a doc they have workspace access to — same RBAC as JSON export (ADR-0016 §a)', async () => {
    const { cookie: adminCookie, workspaceId } = await registerAdminWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');
    const doc = await createObject(adminCookie, workspaceId, 'doc', 'Guest-visible doc');

    const snapshot = buildDocSnapshotBuffer(populateSimpleDoc('Guest can read this'));
    await insertDocSnapshot(workspaceId, doc.id, snapshot);

    const response = await request(server)
      .get(exportUrl(workspaceId, `format=markdown&objectId=${doc.id}`))
      .set('Cookie', guestCookie);

    expect(response.status).toBe(200);
    expect(response.text).toBe('Guest can read this');
  });

  // =======================================================================
  // F1-T18 PR2: JSON export enrichment with doc content.
  // =======================================================================

  it('format=json enriches a doc-type object with content: { format: "markdown", text } derived from its Yjs snapshot', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();
    const doc = await createObject(cookie, workspaceId, 'doc', 'Doc with content');

    const snapshot = buildDocSnapshotBuffer(populateSimpleDoc('Enriched doc body'));
    await insertDocSnapshot(workspaceId, doc.id, snapshot);

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=json'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const body = response.body as ExportBody;

    const exportedDoc = body.objects.find((o) => o.id === doc.id);
    expect(exportedDoc).toBeDefined();
    expect(exportedDoc?.content).toEqual({ format: 'markdown', text: 'Enriched doc body' });
  });

  it('format=json: a doc-type object with NO snapshot has content: { format: "markdown", text: "" } — present but empty, not omitted', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();
    const doc = await createObject(
      cookie,
      workspaceId,
      'doc',
      'Doc without snapshot for json export',
    );

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=json'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const body = response.body as ExportBody;

    const exportedDoc = body.objects.find((o) => o.id === doc.id);
    expect(exportedDoc).toBeDefined();
    expect(exportedDoc?.content).toEqual({ format: 'markdown', text: '' });
  });

  it('format=json: a task-type object has no content field at all (content is doc-specific, absent not empty)', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();
    const task = await createObject(cookie, workspaceId, 'task', 'Just a task');

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=json'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const body = response.body as ExportBody;

    const exportedTask = body.objects.find((o) => o.id === task.id);
    expect(exportedTask).toBeDefined();
    expect(exportedTask?.content).toBeUndefined();
  });

  // =======================================================================
  // Security-review follow-up (F1-T18 PR2): a real object id belonging to a
  // DIFFERENT workspace must 404, not leak, for both format=json&objectId=
  // and format=markdown&objectId= -- the existing "nonexistent objectId"
  // tests above only prove an id that never existed anywhere 404s; these
  // prove the SAME 404 for an id that is real but scoped elsewhere.
  // =======================================================================
  it('format=json&objectId= for an object belonging to a DIFFERENT workspace returns 404, not the object', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();
    const { cookie: otherCookie, workspaceId: otherWorkspaceId } =
      await registerAdminWithWorkspace();
    const foreignObject = await createObject(otherCookie, otherWorkspaceId, 'task', 'Not yours');

    const response = await request(server)
      .get(exportUrl(workspaceId, `format=json&objectId=${foreignObject.id}`))
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
  });

  it('format=markdown&objectId= for a doc belonging to a DIFFERENT workspace returns 404, not its content', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();
    const { cookie: otherCookie, workspaceId: otherWorkspaceId } =
      await registerAdminWithWorkspace();
    const foreignDoc = await createObject(otherCookie, otherWorkspaceId, 'doc', 'Not yours either');

    const snapshot = buildDocSnapshotBuffer(
      populateSimpleDoc('Secret content from another workspace'),
    );
    await insertDocSnapshot(otherWorkspaceId, foreignDoc.id, snapshot);

    const response = await request(server)
      .get(exportUrl(workspaceId, `format=markdown&objectId=${foreignDoc.id}`))
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
  });

  // =======================================================================
  // F1-T18 PR3 (ADR-0016 §e): format=ical HTTP behavior.
  // =======================================================================

  // A. RBAC: same "no role gate" proof as JSON/Markdown, for ical.
  it('format=ical: a "guest" role caller succeeds (200) for a workspace they have access to — same RBAC as JSON/Markdown export (ADR-0016 §a)', async () => {
    const { cookie: adminCookie, workspaceId } = await registerAdminWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');
    const timeblock = await createObject(
      adminCookie,
      workspaceId,
      'timeblock',
      'Guest-visible block',
    );
    await scheduleTimeblock(
      adminCookie,
      workspaceId,
      timeblock.id,
      '2026-08-20T09:00:00.000Z',
      '2026-08-20T10:00:00.000Z',
    );

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=ical'))
      .set('Cookie', guestCookie);

    expect(response.status).toBe(200);
  });

  // B. Whole-workspace export: only scheduled timeblocks, never a task.
  it('format=ical whole-workspace export includes only scheduled timeblock objects, excluding a co-existing task', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const blockOne = await createObject(cookie, workspaceId, 'timeblock', 'Block One');
    await scheduleTimeblock(
      cookie,
      workspaceId,
      blockOne.id,
      '2026-08-21T09:00:00.000Z',
      '2026-08-21T09:30:00.000Z',
    );
    const blockTwo = await createObject(cookie, workspaceId, 'timeblock', 'Block Two');
    await scheduleTimeblock(
      cookie,
      workspaceId,
      blockTwo.id,
      '2026-08-21T11:00:00.000Z',
      '2026-08-21T11:30:00.000Z',
    );
    const task = await createObject(cookie, workspaceId, 'task', 'Not a timeblock');

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=ical'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const events = parseVevents(response.text);
    expect(events).toHaveLength(2);

    const uids = events.map((event) => event.uid);
    expect(uids).toContain(`${blockOne.id}@luminaos`);
    expect(uids).toContain(`${blockTwo.id}@luminaos`);
    expect(uids).not.toContain(`${task.id}@luminaos`);
  });

  // C. objectId narrowing.
  it('format=ical&objectId= narrows to exactly the requested timeblock', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const blockOne = await createObject(cookie, workspaceId, 'timeblock', 'Narrow target');
    await scheduleTimeblock(
      cookie,
      workspaceId,
      blockOne.id,
      '2026-08-22T09:00:00.000Z',
      '2026-08-22T09:30:00.000Z',
    );
    const blockTwo = await createObject(cookie, workspaceId, 'timeblock', 'Not the target');
    await scheduleTimeblock(
      cookie,
      workspaceId,
      blockTwo.id,
      '2026-08-22T11:00:00.000Z',
      '2026-08-22T11:30:00.000Z',
    );

    const response = await request(server)
      .get(exportUrl(workspaceId, `format=ical&objectId=${blockOne.id}`))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const events = parseVevents(response.text);
    expect(events).toHaveLength(1);
    expect(events[0]?.uid).toBe(`${blockOne.id}@luminaos`);
  });

  // D. Wrong type -> 400.
  it('format=ical&objectId= pointing to a task-type object (not timeblock) returns 400', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();
    const task = await createObject(cookie, workspaceId, 'task', 'Wrong type for ical');

    const response = await request(server)
      .get(exportUrl(workspaceId, `format=ical&objectId=${task.id}`))
      .set('Cookie', cookie);

    expect(response.status).toBe(400);
  });

  // E. Nonexistent objectId -> 404.
  it('format=ical&objectId= for a nonexistent objectId returns 404', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=ical&objectId=does-not-exist'))
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
  });

  // F. Cross-workspace objectId -> 404 (mirrors the JSON/Markdown precedent
  // at the bottom of this file).
  it('format=ical&objectId= for a timeblock belonging to a DIFFERENT workspace returns 404, not the event', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();
    const { cookie: otherCookie, workspaceId: otherWorkspaceId } =
      await registerAdminWithWorkspace();
    const foreignBlock = await createObject(
      otherCookie,
      otherWorkspaceId,
      'timeblock',
      'Not yours either',
    );
    await scheduleTimeblock(
      otherCookie,
      otherWorkspaceId,
      foreignBlock.id,
      '2026-08-23T09:00:00.000Z',
      '2026-08-23T09:30:00.000Z',
    );

    const response = await request(server)
      .get(exportUrl(workspaceId, `format=ical&objectId=${foreignBlock.id}`))
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
  });

  // G. Unscheduled timeblock: excluded workspace-wide, and a valid empty
  // calendar (not an error) when narrowed directly to it.
  it('format=ical: an unscheduled timeblock object is excluded workspace-wide, and narrowing to it directly yields a VALID EMPTY calendar (200, 0 VEVENTs), not an error', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();

    const scheduled = await createObject(cookie, workspaceId, 'timeblock', 'Scheduled');
    await scheduleTimeblock(
      cookie,
      workspaceId,
      scheduled.id,
      '2026-08-24T09:00:00.000Z',
      '2026-08-24T09:30:00.000Z',
    );
    const unscheduled = await createObject(cookie, workspaceId, 'timeblock', 'Never scheduled');

    const wholeWorkspaceResponse = await request(server)
      .get(exportUrl(workspaceId, 'format=ical'))
      .set('Cookie', cookie);

    expect(wholeWorkspaceResponse.status).toBe(200);
    const wholeWorkspaceEvents = parseVevents(wholeWorkspaceResponse.text);
    expect(wholeWorkspaceEvents.map((event) => event.uid)).not.toContain(
      `${unscheduled.id}@luminaos`,
    );
    expect(wholeWorkspaceEvents.map((event) => event.uid)).toContain(`${scheduled.id}@luminaos`);

    const narrowedResponse = await request(server)
      .get(exportUrl(workspaceId, `format=ical&objectId=${unscheduled.id}`))
      .set('Cookie', cookie);

    expect(narrowedResponse.status).toBe(200);
    expect(() => parseICalendar(narrowedResponse.text)).not.toThrow();
    const narrowedEvents = parseVevents(narrowedResponse.text);
    expect(narrowedEvents).toHaveLength(0);
  });

  // H. External calendar cache events never leak into iCal export.
  it('format=ical: cached external calendar events (calendar_events_cache) never appear, even alongside a real native timeblock in the same workspace', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();
    const { userId } = await registerUser();

    const nativeBlock = await createObject(cookie, workspaceId, 'timeblock', 'Native block');
    await scheduleTimeblock(
      cookie,
      workspaceId,
      nativeBlock.id,
      '2026-08-25T09:00:00.000Z',
      '2026-08-25T09:30:00.000Z',
    );

    await insertExternalCalendarEvent(
      workspaceId,
      userId,
      'External Meeting (should never appear)',
      'external-evt-should-not-leak',
      new Date('2026-08-25T14:00:00.000Z'),
      new Date('2026-08-25T15:00:00.000Z'),
    );

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=ical'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    const events = parseVevents(response.text);

    expect(events).toHaveLength(1);
    expect(events[0]?.uid).toBe(`${nativeBlock.id}@luminaos`);
    expect(events.map((event) => event.summary)).not.toContain(
      'External Meeting (should never appear)',
    );
  });

  // I. UID determinism across two SEPARATE real HTTP calls.
  it('format=ical: UID is deterministic across two separate HTTP export calls for the same timeblock', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();
    const block = await createObject(cookie, workspaceId, 'timeblock', 'Determinism target');
    await scheduleTimeblock(
      cookie,
      workspaceId,
      block.id,
      '2026-08-26T09:00:00.000Z',
      '2026-08-26T09:30:00.000Z',
    );

    const firstResponse = await request(server)
      .get(exportUrl(workspaceId, `format=ical&objectId=${block.id}`))
      .set('Cookie', cookie);
    const secondResponse = await request(server)
      .get(exportUrl(workspaceId, `format=ical&objectId=${block.id}`))
      .set('Cookie', cookie);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    const firstEvents = parseVevents(firstResponse.text);
    const secondEvents = parseVevents(secondResponse.text);

    expect(firstEvents).toHaveLength(1);
    expect(secondEvents).toHaveLength(1);
    expect(firstEvents[0]?.uid).toBe(secondEvents[0]?.uid);
    expect(firstEvents[0]?.uid).toBe(`${block.id}@luminaos`);
  });

  // J. Content-Type header.
  it('format=ical: a successful response has Content-Type containing text/calendar', async () => {
    const { cookie, workspaceId } = await registerAdminWithWorkspace();
    const block = await createObject(cookie, workspaceId, 'timeblock', 'Content-Type check');
    await scheduleTimeblock(
      cookie,
      workspaceId,
      block.id,
      '2026-08-27T09:00:00.000Z',
      '2026-08-27T09:30:00.000Z',
    );

    const response = await request(server)
      .get(exportUrl(workspaceId, 'format=ical'))
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.type).toContain('text/calendar');
  });
});
