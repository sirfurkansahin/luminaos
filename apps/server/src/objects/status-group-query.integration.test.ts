import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate.js';

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T10's LAST remaining acceptance criterion (see
 * `docs/specs/F1-E3/F1-T10-gorev-deneyimi.md`):
 *
 *   "F1-T7 Board görünümü, ek kod gerekmeden `status` alanına göre
 *   gruplayabildiği regresyon testiyle doğrulanır."
 *   ("F1-T7's Board view can group by the `status` field with no extra
 *   code, proven by a regression test.")
 *
 * ============================================================================
 * WHY A NEW FILE INSTEAD OF ADDING TO `object-query.integration.test.ts`:
 *
 * `object-query.integration.test.ts`'s `describe('grouping', ...)` block
 * already covers grouping GENERICALLY -- but deliberately against a
 * hand-defined `workStatus` field (see that file's own
 * `defineStandardTaskFields` doc comment: "NOT `status` -- workspace
 * creation now auto-seeds a `status` field for `task`, F1-T10 PR1 -- a
 * distinct key avoids a spurious 409 conflict"). That file's job is pinning
 * the query engine's contract for arbitrary select fields; it intentionally
 * stays independent of any one feature's seed data.
 *
 * This file's job is different and narrower: prove that the REAL, F1-T10
 * PR1-seeded `status` field (auto-provisioned on every new workspace, options
 * `todo`/`doing`/`done`, `done` carrying `isDone: true`) -- the exact field
 * `apps/web/src/views/BoardView.test.tsx` assumes via
 * `{ objectType: 'task', filters: [], group: 'status' }` -- groups correctly
 * through the real `POST /workspaces/:workspaceId/objects/query` endpoint
 * with ZERO additional server or client code. Critically, this test must
 * NEVER call `POST .../object-types/task/fields` to define `status` itself
 * -- doing so would either 409 (it already exists) or, worse, silently
 * defeat the entire point of the regression test by exercising a
 * test-defined field instead of the real seeded one. Keeping this as its own
 * file also means it can be deleted/renamed independently of
 * `object-query.integration.test.ts`'s much larger, unrelated field-type
 * coverage matrix without any risk of merge conflicts.
 *
 * EXPECTED RESULT: GREEN on first run for the QUERY/GROUPING contract itself.
 * F1-T6's query/group engine, F1-T10 PR1's seed, and F1-T10 PR5's
 * `PATCH .../fields` write path are all already implemented and merged --
 * this is a pure confirmation/regression test, not a red-step pinning an
 * unimplemented contract.
 *
 * ONE fixture surprise WAS found and fixed here (not a query-layer bug):
 * setting `status` to `done` is a real `isDone` false->true transition
 * through the real write path, which (F1-T10 PR3/PR4, already merged)
 * triggers `TaskRecurrenceService` to spawn one new recurring `task` per
 * completion, reset to `todo`. The `todo` group's assertions account for
 * this (exact count including the spawned siblings, containment-only check
 * for the two original ids) rather than asserting an exact-2 match that
 * would have been invalidated by this real, already-tested, unrelated
 * product behavior.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface ObjectBody {
  id: string;
  type: string;
  title: string;
  fieldValues: Record<string, unknown>;
}

interface ObjectEnvelope {
  object: ObjectBody;
}

interface QueryGroupEntry {
  groupValue: string;
  count: number;
  items: ObjectBody[];
}

interface QueryGroupEnvelope {
  groups: QueryGroupEntry[];
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `status-group-query-test-user-${String(emailCounter)}@example.com`;
}

describe('F1-T10 regression: Board grouping by the real, auto-seeded `status` field (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;

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
  }, 60_000);

  afterAll(async () => {
    await app.close();
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

  /** Registers a user and creates a workspace -- workspace creation is what
   * auto-seeds the real `status`/`priority`/`remindAt`/`remindAcknowledged`
   * fields for `task` (F1-T10 PR1/PR5). No manual field definition here on
   * purpose -- see this file's header comment. */
  async function registerOwnerWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const { cookie } = await registerUser();
    const workspaceId = await createWorkspace(
      cookie,
      `Status Group Workspace ${String(emailCounter)}`,
    );
    return { cookie, workspaceId };
  }

  function objectsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/objects`;
  }

  async function createTask(
    cookie: string,
    workspaceId: string,
    title: string,
  ): Promise<ObjectBody> {
    const response = await request(server)
      .post(objectsUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ objectType: 'task', title });

    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object;
  }

  async function setStatus(
    cookie: string,
    workspaceId: string,
    objectId: string,
    status: string,
  ): Promise<void> {
    const response = await request(server)
      .patch(`${objectsUrl(workspaceId)}/${objectId}/fields`)
      .set('Cookie', cookie)
      .send({ values: { status } });

    expect(response.status).toBe(200);
  }

  function queryByStatus(cookie: string, workspaceId: string): request.Test {
    // Mirrors `BoardView.test.tsx`'s own `querySpec` shape exactly:
    // `{ objectType: 'task', filters: [], group: 'status' }`.
    return request(server)
      .post(`${objectsUrl(workspaceId)}/query`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', filters: [], group: 'status' });
  }

  it(
    'groups tasks by the real seeded `status` field (todo/doing/done) with no extra server/client code, ' +
      'and excludes a task whose `status` was never set from every group',
    async () => {
      const { cookie, workspaceId } = await registerOwnerWithWorkspace();

      const todoOne = await createTask(cookie, workspaceId, 'Todo one');
      await setStatus(cookie, workspaceId, todoOne.id, 'todo');
      const todoTwo = await createTask(cookie, workspaceId, 'Todo two');
      await setStatus(cookie, workspaceId, todoTwo.id, 'todo');

      const doingOne = await createTask(cookie, workspaceId, 'Doing one');
      await setStatus(cookie, workspaceId, doingOne.id, 'doing');

      const doneOne = await createTask(cookie, workspaceId, 'Done one');
      await setStatus(cookie, workspaceId, doneOne.id, 'done');
      const doneTwo = await createTask(cookie, workspaceId, 'Done two');
      await setStatus(cookie, workspaceId, doneTwo.id, 'done');
      const doneThree = await createTask(cookie, workspaceId, 'Done three');
      await setStatus(cookie, workspaceId, doneThree.id, 'done');

      // Never has `status` set at all -- must not appear in any group
      // (F1-T6's documented "no-value objects are excluded from every
      // group" behavior, re-confirmed here against the real field).
      const neverSet = await createTask(cookie, workspaceId, 'Never set status');

      const response = await queryByStatus(cookie, workspaceId);

      expect(response.status).toBe(200);
      const { groups } = response.body as QueryGroupEnvelope;
      expect(groups).toHaveLength(3);

      const byValue = new Map(groups.map((g) => [g.groupValue, g]));

      // `todo` deliberately does NOT assert an exact 2-item match: setting
      // `status` to `done` on `doneOne`/`doneTwo`/`doneThree` above is a REAL
      // `isDone` false->true transition through the real `PATCH .../fields`
      // endpoint, which (ADR-0010, F1-T10 PR3/PR4, already merged and
      // exercised for its own idempotency/correctness elsewhere) triggers
      // `TaskRecurrenceService` to generate one new recurring `task` per
      // completion, each reset to the first non-`isDone` option -- i.e.
      // `todo` (ADR-0010 §g). That is CORRECT, already-tested product
      // behavior, not a query-layer defect -- this test only needs to prove
      // the two ORIGINAL `todo` tasks are grouped correctly, alongside
      // however many recurrence-spawned siblings also legitimately landed in
      // `todo`.
      const todoGroup = byValue.get('todo');
      expect(todoGroup?.count).toBe(5); // 2 original + 3 recurrence-spawned (one per `done` transition)
      const todoIds = todoGroup?.items.map((o) => o.id) ?? [];
      expect(todoIds).toContain(todoOne.id);
      expect(todoIds).toContain(todoTwo.id);

      const doingGroup = byValue.get('doing');
      expect(doingGroup?.count).toBe(1);
      expect(doingGroup?.items.map((o) => o.id)).toEqual([doingOne.id]);

      // `done` stays an EXACT match: recurrence generation never places a
      // new task into `done` (its `status` is always reset to a non-`isDone`
      // option), so this group is unaffected by the side effect above.
      const doneGroup = byValue.get('done');
      expect(doneGroup?.count).toBe(3);
      expect(doneGroup?.items.map((o) => o.id).sort()).toEqual(
        [doneOne.id, doneTwo.id, doneThree.id].sort(),
      );

      for (const group of groups) {
        expect(group.items.map((o) => o.id)).not.toContain(neverSet.id);
      }
    },
  );
});
