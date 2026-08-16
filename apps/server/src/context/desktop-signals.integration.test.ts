import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextGraphProjection } from './context-graph.projection.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { contextGraphEdges } from '../db/schema/context-graph-edges.js';
import { contextGraphNodes } from '../db/schema/context-graph-nodes.js';
import { memberships } from '../db/schema/memberships.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T3 PR2 (RED step) — masaüstü sinyal ingestion + `ContextGraphProjection`
 * `person-topic`/`person-time` genişletmesi (ADR-0020 Karar b, d, h, h.0,
 * `docs/adr/ADR-0020-masaustu-sinyal-toplayicilar.md`). Combines
 * `desktop-signal-consents.integration.test.ts`'s FULL-Nest-app HTTP harness
 * (register/login/create-workspace helpers, real `SessionAuthGuard`) with
 * `context-graph.projection.integration.test.ts`'s direct
 * `projectionRunner.catchUp(contextGraphProjection)`/`rebuild(...)` +
 * `contextGraphNodes`/`contextGraphEdges` raw-row inspection style, because
 * this PR needs BOTH a real authenticated HTTP surface (for the new
 * `POST /workspaces/:workspaceId/context/desktop-signals` endpoint AND the
 * already-shipped PR1 `desktop-signal-consents` grant/revoke endpoints) AND
 * synchronous, test-driven control over `ContextGraphProjection`'s catch-up
 * (per ADR-0020 Karar b.3, the real write path does NOT call `catchUp`
 * synchronously — it relies on the already-shipped `ContextGraphSyncWorker`'s
 * 5s interval, which this test suite does not want to sleep through).
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * A. `context/desktop-signals.service.ts` (new) — `@Injectable()
 *    DesktopSignalsService`, `capture(workspaceId, userId, signalType,
 *    value): Promise<void>`:
 *      - Reads `desktopSignalConsentsService.get(workspaceId, userId,
 *        signalType)`. If it's `null`, OR `revokedAt` is non-null, throws
 *        `ForbiddenError` (`@luminaos/shared`, 403) — NO event is written.
 *      - Otherwise appends a `DesktopSignalCaptured` event (payload
 *        `{signalType, value}`, `actor: {type:'user', id: userId}`,
 *        `streamType: 'desktop-signal'`) to the event store, `streamId`
 *        deterministically derived from `(workspaceId, userId, signalType)`
 *        via a SEPARATE namespace constant from
 *        `DESKTOP_SIGNAL_CONSENT_UUID_NAMESPACE` (mirrors
 *        `DesktopSignalConsentsService.streamIdFor`'s pattern; this test file
 *        does NOT pin the exact namespace literal since ADR-0020 does not fix
 *        one — it only requires ingestion be rejected/accepted correctly and
 *        the resulting event be readable via `eventStore.readByWorkspace`,
 *        which every test below uses instead of a hardcoded `streamId`).
 *      - Does NOT call `projectionRunner.catchUp` synchronously (Karar b.3)
 *        — every test below drives `ContextGraphProjection` catch-up
 *        directly and explicitly instead of relying on the write path.
 *
 * B. `context/desktop-signals.controller.ts` (new) — `@Controller(
 *    'workspaces/:workspaceId/context/desktop-signals')`,
 *    `@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)`, `@Post()`
 *    body `{signalType, value}` (zod-validated, NOT `.strict()` — same
 *    self-service-by-construction contract as PR1's consent DTO: `userId` is
 *    ALWAYS `req.user.id`, never taken from the body) ->
 *    `service.capture(workspaceId, req.user.id, body.signalType,
 *    body.value)`, 200/201 on success, propagates `ForbiddenError` as 403.
 *
 * C. `context/desktop-signals.module.ts` (new), wired into `app.module.ts`'s
 *    `imports` array (alongside PR1's already-wired
 *    `DesktopSignalConsentsModule`).
 *
 * D. `context/context-graph.projection.ts` (EXISTING FILE, EDITED not
 *    rewritten) — `handles[]` gains `'DesktopSignalCaptured'` AND
 *    `'DesktopSignalConsentRevoked'`. New `apply()` cases (ADR-0020 Karar h,
 *    h.0 — reusing `getOrCreateNode`/`createEdgeIfAbsent`/`toUtcDayKey`
 *    exactly as they exist today, no signature changes):
 *      - `DesktopSignalCaptured`: creates/reuses a `person` node
 *        (`naturalKey = actor.id`), a `time` node (`naturalKey =
 *        toUtcDayKey(occurredAt)`), and a `topic` node (`naturalKey =
 *        payload.value`). FULL-REFRESH (Karar h.4, KRİTİK): before adding the
 *        new `person-topic` edge, deletes EVERY existing
 *        `context_graph_edges` row matching `(workspaceId,
 *        edgeType='person-topic', fromNodeId=personNodeId,
 *        sourceFieldKey=signalType)`, then
 *        `createEdgeIfAbsent(..., 'person-topic', personNodeId, topicNodeId,
 *        signalType, null, occurredAt)`. Also creates/reuses a `person-time`
 *        edge via `createEdgeIfAbsent(..., 'person-time', personNodeId,
 *        timeNodeId, signalType, null, occurredAt)` — `sourceFieldKey =
 *        signalType`, NOT `null` (Karar h.5 correction — this is what makes
 *        revoke's selective deletion below possible).
 *      - `DesktopSignalConsentRevoked` (Karar h.0, KRİTİK): reads
 *        `payload.signalType` and `actor.id`; looks up the existing `person`
 *        node for `(workspaceId, 'person', actor.id)` (no-op if it doesn't
 *        exist); deletes every `context_graph_edges` row matching
 *        `(workspaceId, edgeType='person-topic', fromNodeId=personNodeId,
 *        sourceFieldKey=signalType)` AND `(workspaceId,
 *        edgeType='person-time', fromNodeId=personNodeId,
 *        sourceFieldKey=signalType)`. Must NOT touch any other user's edges,
 *        nor the SAME user's edges for a DIFFERENT `signalType`. Must NOT
 *        delete the `topic`/`time` NODES themselves, only the edges.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `DesktopSignalsModule` does not exist and is
 * not wired into `AppModule`, so every `POST
 * .../context/desktop-signals` call 404s (Nest's default unmatched-route
 * 404) instead of 403/200/201 — this makes essentially every test below fail
 * at the HTTP-assertion step. `ContextGraphProjection.handles` does not yet
 * include `'DesktopSignalCaptured'`/`'DesktopSignalConsentRevoked'`, so even
 * once routes exist (implementer's next step), `catchUp()` silently no-ops on
 * those event types (falls through to `default: return;`) until the
 * `apply()` cases above are added — this is what makes the person/topic/time
 * node and edge assertions fail even after the HTTP layer is wired, and is
 * the intended second RED signal this file is designed to catch.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

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
  return `desktop-signal-ingestion-test-user-${String(emailCounter)}@example.com`;
}

describe('F2-T3 PR2 (RED step): DesktopSignalsService/Controller ingestion + ContextGraphProjection person-topic/person-time extension (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let contextGraphProjection: ContextGraphProjection;

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
    contextGraphProjection = new ContextGraphProjection();
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
      `Desktop signal ingestion test workspace ${String(emailCounter)}`,
    );
    return { cookie, userId, workspaceId };
  }

  /** Registers a brand-new user and inserts a `memberships` row for them in
   * `workspaceId` DIRECTLY via the raw DB connection (no HTTP invite
   * endpoint exists in this codebase yet -- mirrors
   * `field-definitions.integration.test.ts`'s `addMemberWithRole`
   * convention exactly). Returns their session cookie and userId. */
  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<{ cookie: string; userId: string }> {
    const { cookie, userId } = await registerUser();
    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return { cookie, userId };
  }

  function consentsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/context/desktop-signal-consents`;
  }

  function signalsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/context/desktop-signals`;
  }

  /** PR1's already-shipped grant endpoint — used here purely as setup. */
  async function grantConsent(
    cookie: string,
    workspaceId: string,
    signalType: string,
  ): Promise<request.Response> {
    const response = await request(server)
      .post(consentsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ signalType });
    expect([200, 201]).toContain(response.status);
    return response;
  }

  /** PR1's already-shipped revoke endpoint — used here purely as setup. */
  async function revokeConsent(
    cookie: string,
    workspaceId: string,
    signalType: string,
  ): Promise<request.Response> {
    const response = await request(server)
      .delete(`${consentsUrl(workspaceId)}/${signalType}`)
      .set('Cookie', cookie);
    expect([200, 204]).toContain(response.status);
    return response;
  }

  /** This PR's new ingestion endpoint under test. */
  async function captureSignal(
    cookie: string,
    workspaceId: string,
    signalType: string,
    value: string,
  ): Promise<request.Response> {
    return request(server)
      .post(signalsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ signalType, value });
  }

  // ---- ContextGraphProjection / raw-row helpers ---------------------------

  async function catchUpContextGraph(): Promise<void> {
    await projectionRunner.catchUp(contextGraphProjection);
  }

  async function findNode(
    workspaceId: string,
    nodeType: string,
    naturalKey: string,
  ): Promise<typeof contextGraphNodes.$inferSelect | undefined> {
    const rows = await rawDb
      .select()
      .from(contextGraphNodes)
      .where(
        and(
          eq(contextGraphNodes.workspaceId, workspaceId),
          eq(contextGraphNodes.nodeType, nodeType),
          eq(contextGraphNodes.naturalKey, naturalKey),
        ),
      );
    return rows[0];
  }

  async function findEdge(
    workspaceId: string,
    edgeType: string,
    fromNodeId: string,
    toNodeId: string,
    sourceFieldKey: string,
  ): Promise<typeof contextGraphEdges.$inferSelect | undefined> {
    const rows = await rawDb
      .select()
      .from(contextGraphEdges)
      .where(
        and(
          eq(contextGraphEdges.workspaceId, workspaceId),
          eq(contextGraphEdges.edgeType, edgeType),
          eq(contextGraphEdges.fromNodeId, fromNodeId),
          eq(contextGraphEdges.toNodeId, toNodeId),
          eq(contextGraphEdges.sourceFieldKey, sourceFieldKey),
        ),
      );
    return rows[0];
  }

  /** Every `person-topic`/`person-time` edge scoped to a given (person, signalType) pair, regardless of the target node. */
  async function findEdgesFromPerson(
    workspaceId: string,
    edgeType: string,
    personNodeId: string,
    signalType: string,
  ): Promise<(typeof contextGraphEdges.$inferSelect)[]> {
    return rawDb
      .select()
      .from(contextGraphEdges)
      .where(
        and(
          eq(contextGraphEdges.workspaceId, workspaceId),
          eq(contextGraphEdges.edgeType, edgeType),
          eq(contextGraphEdges.fromNodeId, personNodeId),
          eq(contextGraphEdges.sourceFieldKey, signalType),
        ),
      );
  }

  async function getNodeById(
    id: string,
  ): Promise<typeof contextGraphNodes.$inferSelect | undefined> {
    const rows = await rawDb.select().from(contextGraphNodes).where(eq(contextGraphNodes.id, id));
    return rows[0];
  }

  async function hasDesktopSignalCapturedEvent(workspaceId: string): Promise<boolean> {
    const events = await eventStore.readByWorkspace(workspaceId, 0);
    return events.some((event) => event.type === 'DesktopSignalCaptured');
  }

  // ---- 1. rıza olmadan red -------------------------------------------------

  describe('1. no consent granted -> 403, no DesktopSignalCaptured event, no context_graph_edges row', () => {
    it('POST desktop-signals without any prior grant is rejected and produces zero graph rows', async () => {
      const { cookie, userId, workspaceId } = await registerOwnerWithWorkspace();

      const response = await captureSignal(cookie, workspaceId, 'active-window', 'VS Code');
      expect(response.status).toBe(403);

      expect(await hasDesktopSignalCapturedEvent(workspaceId)).toBe(false);

      await catchUpContextGraph();
      expect(await findNode(workspaceId, 'person', userId)).toBeUndefined();
      expect(await findNode(workspaceId, 'topic', 'VS Code')).toBeUndefined();
    });

    it('POST desktop-signals after consent was revoked is also rejected (revokedAt non-null counts as no active consent)', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await grantConsent(cookie, workspaceId, 'active-window');
      await revokeConsent(cookie, workspaceId, 'active-window');

      const response = await captureSignal(cookie, workspaceId, 'active-window', 'VS Code');
      expect(response.status).toBe(403);

      expect(await hasDesktopSignalCapturedEvent(workspaceId)).toBe(false);

      // person node MAY exist from the (irrelevant to signal capture) consent
      // grant/revoke flow itself -- PR1 never touches context_graph tables --
      // so this asserts on the topic node's absence only, the unambiguous
      // signal that no DesktopSignalCaptured-derived row was written.
      await catchUpContextGraph();
      expect(await findNode(workspaceId, 'topic', 'VS Code')).toBeUndefined();
    });
  });

  // ---- 2. consent granted -> full node/edge derivation ---------------------

  describe('2. consent granted -> POST succeeds and catchUp derives person/time/topic nodes + person-topic/person-time edges', () => {
    it('creates a person node, a time node, a topic node (naturalKey=value), and both edges scoped by sourceFieldKey=signalType', async () => {
      const { cookie, userId, workspaceId } = await registerOwnerWithWorkspace();
      await grantConsent(cookie, workspaceId, 'active-window');

      const response = await captureSignal(cookie, workspaceId, 'active-window', 'VS Code');
      expect([200, 201]).toContain(response.status);

      await catchUpContextGraph();

      const personNode = await findNode(workspaceId, 'person', userId);
      expect(personNode).toBeDefined();

      const topicNode = await findNode(workspaceId, 'topic', 'VS Code');
      expect(topicNode).toBeDefined();

      const personTopicEdge =
        personNode && topicNode
          ? await findEdge(
              workspaceId,
              'person-topic',
              personNode.id,
              topicNode.id,
              'active-window',
            )
          : undefined;
      expect(personTopicEdge).toBeDefined();

      const personTimeEdges = personNode
        ? await findEdgesFromPerson(workspaceId, 'person-time', personNode.id, 'active-window')
        : [];
      expect(personTimeEdges).toHaveLength(1);

      const timeNode = personTimeEdges[0]
        ? await getNodeById(personTimeEdges[0].toNodeId)
        : undefined;
      expect(timeNode?.nodeType).toBe('time');
    });
  });

  // ---- 3. full-refresh -------------------------------------------------

  describe('3. full-refresh (ADR-0020 Karar h.4): a second capture with a DIFFERENT value for the SAME signalType replaces the person-topic edge', () => {
    it('the stale person-topic edge (old value) is gone; the fresh one (new value) is present', async () => {
      const { cookie, userId, workspaceId } = await registerOwnerWithWorkspace();
      await grantConsent(cookie, workspaceId, 'active-window');

      await captureSignal(cookie, workspaceId, 'active-window', 'VS Code');
      await catchUpContextGraph();

      await captureSignal(cookie, workspaceId, 'active-window', 'Chrome');
      await catchUpContextGraph();

      const personNode = await findNode(workspaceId, 'person', userId);
      const staleTopicNode = await findNode(workspaceId, 'topic', 'VS Code');
      const freshTopicNode = await findNode(workspaceId, 'topic', 'Chrome');
      expect(freshTopicNode).toBeDefined();

      const staleEdge =
        personNode && staleTopicNode
          ? await findEdge(
              workspaceId,
              'person-topic',
              personNode.id,
              staleTopicNode.id,
              'active-window',
            )
          : undefined;
      expect(staleEdge).toBeUndefined();

      const freshEdge =
        personNode && freshTopicNode
          ? await findEdge(
              workspaceId,
              'person-topic',
              personNode.id,
              freshTopicNode.id,
              'active-window',
            )
          : undefined;
      expect(freshEdge).toBeDefined();

      const allActiveWindowTopicEdges = personNode
        ? await findEdgesFromPerson(workspaceId, 'person-topic', personNode.id, 'active-window')
        : [];
      expect(allActiveWindowTopicEdges).toHaveLength(1);
    });
  });

  // ---- 4. signal-type isolation (even across full-refresh) -----------------

  describe('4. signal-type isolation: person-topic full-refresh is scoped by sourceFieldKey=signalType, never cross-contaminating another signalType', () => {
    it('refreshing "active-window" does not touch the independently-created "calendar-status" edge', async () => {
      const { cookie, userId, workspaceId } = await registerOwnerWithWorkspace();
      await grantConsent(cookie, workspaceId, 'active-window');
      await grantConsent(cookie, workspaceId, 'calendar-status');

      await captureSignal(cookie, workspaceId, 'active-window', 'VS Code');
      await captureSignal(cookie, workspaceId, 'calendar-status', 'busy');
      await catchUpContextGraph();

      const personNode = await findNode(workspaceId, 'person', userId);
      const calendarTopicNode = await findNode(workspaceId, 'topic', 'busy');
      const edgeBefore =
        personNode && calendarTopicNode
          ? await findEdge(
              workspaceId,
              'person-topic',
              personNode.id,
              calendarTopicNode.id,
              'calendar-status',
            )
          : undefined;
      expect(edgeBefore).toBeDefined();

      // Full-refresh "active-window" (a second, different value).
      await captureSignal(cookie, workspaceId, 'active-window', 'Terminal');
      await catchUpContextGraph();

      const edgeAfter =
        personNode && calendarTopicNode
          ? await findEdge(
              workspaceId,
              'person-topic',
              personNode.id,
              calendarTopicNode.id,
              'calendar-status',
            )
          : undefined;
      expect(edgeAfter).toBeDefined();

      const activeWindowTopicNode = await findNode(workspaceId, 'topic', 'Terminal');
      const activeWindowEdge =
        personNode && activeWindowTopicNode
          ? await findEdge(
              workspaceId,
              'person-topic',
              personNode.id,
              activeWindowTopicNode.id,
              'active-window',
            )
          : undefined;
      expect(activeWindowEdge).toBeDefined();
    });
  });

  // ---- 5. revoke -> retroactive deletion (KRİTİK, Karar h.0) ----------------

  describe("5. revoke -> retroactive deletion of that signalType's person-topic/person-time edges only (ADR-0020 Karar h.0)", () => {
    it('revoking "active-window" deletes ITS person-topic/person-time edges but leaves "calendar-status" edges (same user) untouched', async () => {
      const { cookie, userId, workspaceId } = await registerOwnerWithWorkspace();
      await grantConsent(cookie, workspaceId, 'active-window');
      await grantConsent(cookie, workspaceId, 'calendar-status');

      await captureSignal(cookie, workspaceId, 'active-window', 'VS Code');
      await captureSignal(cookie, workspaceId, 'calendar-status', 'busy');
      await catchUpContextGraph();

      const personNode = await findNode(workspaceId, 'person', userId);
      if (!personNode) {
        throw new Error('person node not found after capturing signals (setup)');
      }

      // Sanity: both signal types produced edges before revoke.
      expect(
        await findEdgesFromPerson(workspaceId, 'person-topic', personNode.id, 'active-window'),
      ).toHaveLength(1);
      expect(
        await findEdgesFromPerson(workspaceId, 'person-time', personNode.id, 'active-window'),
      ).toHaveLength(1);
      expect(
        await findEdgesFromPerson(workspaceId, 'person-topic', personNode.id, 'calendar-status'),
      ).toHaveLength(1);
      expect(
        await findEdgesFromPerson(workspaceId, 'person-time', personNode.id, 'calendar-status'),
      ).toHaveLength(1);

      await revokeConsent(cookie, workspaceId, 'active-window');
      await catchUpContextGraph();

      expect(
        await findEdgesFromPerson(workspaceId, 'person-topic', personNode.id, 'active-window'),
      ).toHaveLength(0);
      expect(
        await findEdgesFromPerson(workspaceId, 'person-time', personNode.id, 'active-window'),
      ).toHaveLength(0);

      // Untouched: the other signalType's edges for the SAME user survive.
      expect(
        await findEdgesFromPerson(workspaceId, 'person-topic', personNode.id, 'calendar-status'),
      ).toHaveLength(1);
      expect(
        await findEdgesFromPerson(workspaceId, 'person-time', personNode.id, 'calendar-status'),
      ).toHaveLength(1);

      // The topic NODE itself is not deleted, only the edge (ADR-0020 Karar
      // h.0: "topic/time düğümlerinin kendisi SİLİNMEZ").
      expect(await findNode(workspaceId, 'topic', 'VS Code')).toBeDefined();
    });

    it("revoking one user's signal does not affect a DIFFERENT user's edges for the same signalType", async () => {
      const { cookie: cookieA, userId: userA, workspaceId } = await registerOwnerWithWorkspace();
      const { cookie: cookieB, userId: userB } = await addMemberWithRole(workspaceId, 'member');

      await grantConsent(cookieA, workspaceId, 'active-window');
      await grantConsent(cookieB, workspaceId, 'active-window');

      await captureSignal(cookieA, workspaceId, 'active-window', 'VS Code');
      await captureSignal(cookieB, workspaceId, 'active-window', 'VS Code');
      await catchUpContextGraph();

      const personA = await findNode(workspaceId, 'person', userA);
      const personB = await findNode(workspaceId, 'person', userB);
      if (!personA || !personB) {
        throw new Error('both person nodes must exist after setup captures');
      }

      await revokeConsent(cookieA, workspaceId, 'active-window');
      await catchUpContextGraph();

      expect(
        await findEdgesFromPerson(workspaceId, 'person-topic', personA.id, 'active-window'),
      ).toHaveLength(0);
      expect(
        await findEdgesFromPerson(workspaceId, 'person-topic', personB.id, 'active-window'),
      ).toHaveLength(1);
    });
  });

  // ---- 6. cross-user isolation ----------------------------------------------

  describe('6. cross-user isolation: two users in the same workspace get independent person-topic edges', () => {
    it("user A's captured signal never creates an edge on user B's person node", async () => {
      const { cookie: cookieA, userId: userA, workspaceId } = await registerOwnerWithWorkspace();
      const { cookie: cookieB, userId: userB } = await addMemberWithRole(workspaceId, 'member');

      await grantConsent(cookieA, workspaceId, 'active-window');
      await grantConsent(cookieB, workspaceId, 'active-window');

      await captureSignal(cookieA, workspaceId, 'active-window', 'Shared App Name');
      await captureSignal(cookieB, workspaceId, 'active-window', 'Shared App Name');
      await catchUpContextGraph();

      const personA = await findNode(workspaceId, 'person', userA);
      const personB = await findNode(workspaceId, 'person', userB);
      const sharedTopic = await findNode(workspaceId, 'topic', 'Shared App Name');
      expect(personA).toBeDefined();
      expect(personB).toBeDefined();
      expect(sharedTopic).toBeDefined();
      expect(personA?.id).not.toBe(personB?.id);

      const edgeA =
        personA && sharedTopic
          ? await findEdge(workspaceId, 'person-topic', personA.id, sharedTopic.id, 'active-window')
          : undefined;
      const edgeB =
        personB && sharedTopic
          ? await findEdge(workspaceId, 'person-topic', personB.id, sharedTopic.id, 'active-window')
          : undefined;
      expect(edgeA).toBeDefined();
      expect(edgeB).toBeDefined();

      const allEdgesIntoSharedTopic = sharedTopic
        ? await rawDb
            .select()
            .from(contextGraphEdges)
            .where(
              and(
                eq(contextGraphEdges.workspaceId, workspaceId),
                eq(contextGraphEdges.edgeType, 'person-topic'),
                eq(contextGraphEdges.toNodeId, sharedTopic.id),
              ),
            )
        : [];
      expect(allEdgesIntoSharedTopic).toHaveLength(2);
      expect(new Set(allEdgesIntoSharedTopic.map((edge) => edge.fromNodeId)).size).toBe(2);
    });
  });

  // ---- 7. cross-workspace isolation ------------------------------------------

  describe('7. cross-workspace isolation: identical signal values in two different workspaces never share/leak topic nodes or edges', () => {
    it('two independent workspaces each get their own topic node and person-topic edge for the same value string', async () => {
      const {
        cookie: cookieA,
        userId: userA,
        workspaceId: workspaceA,
      } = await registerOwnerWithWorkspace();
      const {
        cookie: cookieB,
        userId: userB,
        workspaceId: workspaceB,
      } = await registerOwnerWithWorkspace();

      await grantConsent(cookieA, workspaceA, 'active-window');
      await grantConsent(cookieB, workspaceB, 'active-window');

      await captureSignal(cookieA, workspaceA, 'active-window', 'Cross Workspace App');
      await captureSignal(cookieB, workspaceB, 'active-window', 'Cross Workspace App');
      await catchUpContextGraph();

      const topicNodesNamedSame = await rawDb
        .select()
        .from(contextGraphNodes)
        .where(
          and(
            eq(contextGraphNodes.nodeType, 'topic'),
            eq(contextGraphNodes.naturalKey, 'Cross Workspace App'),
          ),
        );
      const relevantTopicNodes = topicNodesNamedSame.filter(
        (node) => node.workspaceId === workspaceA || node.workspaceId === workspaceB,
      );
      expect(relevantTopicNodes).toHaveLength(2);
      expect(new Set(relevantTopicNodes.map((node) => node.workspaceId)).size).toBe(2);

      const personA = await findNode(workspaceA, 'person', userA);
      const personB = await findNode(workspaceB, 'person', userB);
      const topicA = await findNode(workspaceA, 'topic', 'Cross Workspace App');
      const topicB = await findNode(workspaceB, 'topic', 'Cross Workspace App');
      if (!personA || !personB || !topicA || !topicB) {
        throw new Error('setup nodes missing for cross-workspace isolation test');
      }

      // Cross-workspace edges must never exist.
      expect(
        await findEdge(workspaceA, 'person-topic', personA.id, topicB.id, 'active-window'),
      ).toBeUndefined();
      expect(
        await findEdge(workspaceB, 'person-topic', personB.id, topicA.id, 'active-window'),
      ).toBeUndefined();

      // Each workspace only sees its own edge.
      expect(
        await findEdge(workspaceA, 'person-topic', personA.id, topicA.id, 'active-window'),
      ).toBeDefined();
      expect(
        await findEdge(workspaceB, 'person-topic', personB.id, topicB.id, 'active-window'),
      ).toBeDefined();
    });
  });

  // ---- 8. rebuild-determinism (F0-T6 AC4) ------------------------------------

  describe('8. rebuild-determinism (F0-T6 AC4): several captures + a revoke, then a full rebuild reproduces the exact same logical graph', () => {
    /**
     * Snapshot keyed by LOGICAL identity (not raw ULIDs, which are
     * regenerated on rebuild), mirrors
     * `context-graph.projection.integration.test.ts`'s `snapshotGraph`
     * helper exactly.
     */
    async function snapshotGraph(): Promise<{ nodeKeys: string[]; edgeKeys: string[] }> {
      const nodes = await rawDb.select().from(contextGraphNodes);
      const nodeById = new Map(nodes.map((node) => [node.id, node]));

      const nodeKeys = nodes
        .map((node) => `${node.workspaceId}|${node.nodeType}|${node.naturalKey}`)
        .sort();

      const edges = await rawDb.select().from(contextGraphEdges);
      const edgeKeys = edges
        .map((edge) => {
          const from = nodeById.get(edge.fromNodeId);
          const to = nodeById.get(edge.toNodeId);
          return `${edge.workspaceId}|${edge.edgeType}|${from?.nodeType ?? '?'}:${from?.naturalKey ?? '?'}->${to?.nodeType ?? '?'}:${to?.naturalKey ?? '?'}|${edge.sourceFieldKey ?? ''}`;
        })
        .sort();

      return { nodeKeys, edgeKeys };
    }

    it('rebuild (truncate own state + checkpoint reset to 0 + full replay) reproduces the exact same node/edge SET, including person-topic/person-time and post-revoke deletions', async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();
      await grantConsent(cookie, workspaceId, 'active-window');
      await grantConsent(cookie, workspaceId, 'calendar-status');

      await captureSignal(cookie, workspaceId, 'active-window', 'VS Code');
      await captureSignal(cookie, workspaceId, 'active-window', 'Chrome');
      await captureSignal(cookie, workspaceId, 'calendar-status', 'busy');
      await catchUpContextGraph();

      await revokeConsent(cookie, workspaceId, 'calendar-status');
      await catchUpContextGraph();

      const before = await snapshotGraph();
      // Sanity: earlier describe blocks in this file already populated real
      // rows too, so a trivially-empty-both-sides pass would be a false
      // positive.
      expect(before.nodeKeys.length).toBeGreaterThan(0);
      expect(before.edgeKeys.length).toBeGreaterThan(0);

      await projectionRunner.rebuild(contextGraphProjection);

      const after = await snapshotGraph();
      expect(after.nodeKeys).toEqual(before.nodeKeys);
      expect(after.edgeKeys).toEqual(before.edgeKeys);
    });
  });
});
