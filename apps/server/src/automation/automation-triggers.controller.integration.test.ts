import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { automationTriggers } from '../db/schema/automation-triggers.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T15 PR2 (RED step): server-side CRUD wiring for `Trigger`
 * (`AutomationTriggersService`/`AutomationTriggersController`/
 * `AutomationTriggersViewProjection`/`AutomationModule`), per ADR-0032 §h's
 * FLAT RBAC rule -- a trigger is ALWAYS workspace-wide, never personal, so
 * unlike `SavedViewsService.assertCanMutate`'s ownership-vs-role branch, this
 * is a single flat check: `admin`+ may write (`POST`/`PATCH`/`DELETE`),
 * `member`+ may read (`GET`).
 *
 * Mirrors `meeting-retention-preference.controller.integration.test.ts`'s
 * exact harness (full Nest app boot via Testcontainers Postgres 16 + Redis 7,
 * real `SessionAuthGuard`/`WorkspaceMembershipGuard` flow, the same
 * `addMemberWithRole` raw-insert-into-`memberships` helper -- the only way in
 * this codebase's test suites to get a `member`/`guest`/`admin` session that
 * isn't the workspace's own `owner`).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): NONE of `AutomationTriggersService` /
 * `AutomationTriggersController` / `AutomationTriggersViewProjection` /
 * `AutomationModule` exist yet, and `AppModule` does not import any such
 * module -- every request below to `/workspaces/:workspaceId/triggers...`
 * is expected to 404 via Nest's own default "Cannot POST/GET/PATCH/DELETE
 * ..." handler (no matching route at all), NOT via `AppErrorFilter` mapping
 * an `AppError`, mirroring `saved-views.integration.test.ts`'s own
 * documented red-state note for the analogous "module doesn't exist yet"
 * situation. `automation_triggers` itself already exists as a table (F2-T15
 * PR1, merged) -- so the raw Drizzle helpers below against that table would
 * succeed once rows exist; only the HTTP layer is what's missing.
 *
 * `implementer` must: add `automation-triggers.service.ts` (wrapping
 * `createTrigger`/`updateTrigger`/`deleteTrigger`/`replayTrigger` from
 * `@luminaos/automation`, `@luminaos/automation` as a new dependency of
 * `apps/server`), `automation-triggers.controller.ts`,
 * `automation-triggers.projection.ts`, `dto/create-trigger.schema.ts` +
 * `dto/update-trigger.schema.ts`, and `automation.module.ts` (imported by
 * `AppModule`).
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `@Controller('workspaces/:workspaceId/triggers')`, guarded by
 * `SessionAuthGuard` + `WorkspaceMembershipGuard` at the class level.
 *
 *   POST   /workspaces/:workspaceId/triggers
 *          body: { name, spec: ScheduleSpec | ConditionSpec }
 *          -> 201 { trigger } (requires `admin`+, else 403)
 *          Re-validates via `@luminaos/automation`'s `createTrigger`, so an
 *          unsafe regex `pattern` on a `condition` spec surfaces as a 400
 *          (`ValidationError`, per `packages/shared/errors/validation-error.ts`
 *          -> `AppErrorFilter` -> HTTP 400).
 *
 *   GET    /workspaces/:workspaceId/triggers
 *          -> 200 { triggers: [...] } (requires `member`+, else 403)
 *          Only `lifecycle: 'active'` triggers are returned.
 *
 *   PATCH  /workspaces/:workspaceId/triggers/:triggerId
 *          body (partial): { name?, spec? }
 *          -> 200 { trigger } (requires `admin`+, else 403)
 *          Re-validates `spec` through the domain layer exactly like create
 *          (an unsafe regex on update -> 400, cannot bypass create-path
 *          safety).
 *
 *   DELETE /workspaces/:workspaceId/triggers/:triggerId
 *          -> 204 (requires `admin`+, else 403); soft-deletes
 *          (`lifecycle: 'deleted'`), never hard-deletes the row. A DELETE on
 *          an already-deleted trigger -> `InvalidObjectStateError` ->
 *          `AppErrorFilter` -> HTTP 409 (`packages/shared/errors/
 *          invalid-object-state.error.ts`'s pinned `statusCode`).
 *
 *   `:triggerId` is scoped by `id` + `workspaceId` (mirrors
 *   `SavedViewsService.lookupStreamId`'s exact contract) -- a `triggerId`
 *   from a different workspace, or one that never existed, is 404.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface TriggerBody {
  id: string;
  workspaceId: string;
  name: string;
  kind: string;
  spec: Record<string, unknown>;
  lifecycle: string;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TriggerEnvelope {
  trigger: TriggerBody;
}

interface TriggerListEnvelope {
  triggers: TriggerBody[];
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `automation-trigger-test-user-${String(emailCounter)}@example.com`;
}

function scheduledTriggerRequestBody(name: string): Record<string, unknown> {
  return {
    name,
    spec: {
      kind: 'scheduled',
      intervalMinutes: 15,
      actionTemplate: { title: 'Do the scheduled thing' },
    },
  };
}

function conditionTriggerRequestBody(
  name: string,
  overrides?: { pattern?: string; flags?: string },
): Record<string, unknown> {
  return {
    name,
    spec: {
      kind: 'condition',
      objectType: 'task',
      fieldKey: 'status',
      pattern: overrides?.pattern ?? 'urgent',
      flags: overrides?.flags ?? '',
      actionTemplate: { title: 'Flag as urgent' },
    },
  };
}

describe('F2-T15 PR2 (RED step): CRUD .../triggers -- workspace-scoped automation trigger definitions (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

  async function registerOwnerWithWorkspace(): Promise<{ cookie: string; workspaceId: string }> {
    const email = freshEmail();
    const registerResponse = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    expect(registerResponse.status).toBe(201);
    const cookie = toCookieHeader(registerResponse.get('Set-Cookie'));
    expect((registerResponse.body as UserEnvelope).user.id).toBeDefined();

    const workspaceResponse = await request(server)
      .post('/workspaces')
      .set('Cookie', cookie)
      .send({ name: `Automation trigger test workspace ${String(emailCounter)}` });
    expect(workspaceResponse.status).toBe(201);
    const workspaceId = (workspaceResponse.body as WorkspaceEnvelope).workspace.id;

    return { cookie, workspaceId };
  }

  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<string> {
    const email = freshEmail();
    const registerResponse = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD });
    expect(registerResponse.status).toBe(201);
    const cookie = toCookieHeader(registerResponse.get('Set-Cookie'));
    const userId = (registerResponse.body as UserEnvelope).user.id;

    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return cookie;
  }

  function triggersUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/triggers`;
  }

  function triggerUrl(workspaceId: string, triggerId: string): string {
    return `/workspaces/${workspaceId}/triggers/${triggerId}`;
  }

  async function createTriggerAsAdmin(
    cookie: string,
    workspaceId: string,
    body: Record<string, unknown>,
  ): Promise<TriggerBody> {
    const response = await request(server)
      .post(triggersUrl(workspaceId))
      .set('Cookie', cookie)
      .send(body);
    expect(response.status).toBe(201);
    return (response.body as TriggerEnvelope).trigger;
  }

  async function rawTriggerRow(
    workspaceId: string,
    triggerId: string,
  ): Promise<typeof automationTriggers.$inferSelect | undefined> {
    const [row] = await rawDb
      .select()
      .from(automationTriggers)
      .where(
        and(eq(automationTriggers.id, triggerId), eq(automationTriggers.workspaceId, workspaceId)),
      );
    return row;
  }

  it('1. POST as an admin (the workspace owner) creating a "scheduled" trigger -> 201, returns the created trigger with a generated id', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(triggersUrl(workspaceId))
      .set('Cookie', cookie)
      .send(scheduledTriggerRequestBody('Nightly digest'));

    expect(response.status).toBe(201);
    const { trigger } = response.body as TriggerEnvelope;
    expect(trigger.id).toBeDefined();
    expect(typeof trigger.id).toBe('string');
    expect(trigger.name).toBe('Nightly digest');
    expect(trigger.kind).toBe('scheduled');
    expect(trigger.spec).toMatchObject({
      kind: 'scheduled',
      intervalMinutes: 15,
      actionTemplate: { title: 'Do the scheduled thing' },
    });
    expect(trigger.lifecycle).toBe('active');

    const row = await rawTriggerRow(workspaceId, trigger.id);
    expect(row).toBeDefined();
    expect(row?.kind).toBe('scheduled');
    expect(row?.lifecycle).toBe('active');
    expect(row?.lastFiredAt).toBeNull();
  });

  it('2. POST as an admin creating a "condition" trigger -> 201', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(triggersUrl(workspaceId))
      .set('Cookie', cookie)
      .send(conditionTriggerRequestBody('Escalate urgent tasks'));

    expect(response.status).toBe(201);
    const { trigger } = response.body as TriggerEnvelope;
    expect(trigger.kind).toBe('condition');
    expect(trigger.spec).toMatchObject({
      kind: 'condition',
      objectType: 'task',
      fieldKey: 'status',
      pattern: 'urgent',
      flags: '',
      actionTemplate: { title: 'Flag as urgent' },
    });
  });

  it('3. POST as a "member" (not admin) -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .post(triggersUrl(workspaceId))
      .set('Cookie', memberCookie)
      .send(scheduledTriggerRequestBody('Should not be created'));

    expect(response.status).toBe(403);
  });

  it('4. POST with an unsafe (catastrophic-backtracking) regex pattern -> 400', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(triggersUrl(workspaceId))
      .set('Cookie', cookie)
      .send(conditionTriggerRequestBody('Unsafe pattern trigger', { pattern: '(a+)+' }));

    expect(response.status).toBe(400);
  });

  it('5. GET as a "member" (not admin) -> 200, lists active triggers', async () => {
    const { cookie: adminCookie, workspaceId } = await registerOwnerWithWorkspace();
    await createTriggerAsAdmin(
      adminCookie,
      workspaceId,
      scheduledTriggerRequestBody('Weekly report'),
    );

    const memberCookie = await addMemberWithRole(workspaceId, 'member');
    const response = await request(server)
      .get(triggersUrl(workspaceId))
      .set('Cookie', memberCookie);

    expect(response.status).toBe(200);
    const { triggers } = response.body as TriggerListEnvelope;
    expect(triggers.some((t) => t.name === 'Weekly report')).toBe(true);
  });

  it('6. GET as a "guest" (below member) -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    const response = await request(server).get(triggersUrl(workspaceId)).set('Cookie', guestCookie);

    expect(response.status).toBe(403);
  });

  it('7. GET only returns triggers with lifecycle "active" -- a deleted trigger is excluded', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const trigger = await createTriggerAsAdmin(
      cookie,
      workspaceId,
      scheduledTriggerRequestBody('To be deleted'),
    );

    const deleteResponse = await request(server)
      .delete(triggerUrl(workspaceId, trigger.id))
      .set('Cookie', cookie);
    expect(deleteResponse.status).toBe(204);

    const listResponse = await request(server).get(triggersUrl(workspaceId)).set('Cookie', cookie);
    expect(listResponse.status).toBe(200);
    const { triggers } = listResponse.body as TriggerListEnvelope;
    expect(triggers.some((t) => t.id === trigger.id)).toBe(false);
  });

  it('8. PATCH as an admin updating "name" -> 200, returns the updated trigger', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const trigger = await createTriggerAsAdmin(
      cookie,
      workspaceId,
      scheduledTriggerRequestBody('Original name'),
    );

    const response = await request(server)
      .patch(triggerUrl(workspaceId, trigger.id))
      .set('Cookie', cookie)
      .send({ name: 'Renamed trigger' });

    expect(response.status).toBe(200);
    const { trigger: updated } = response.body as TriggerEnvelope;
    expect(updated.name).toBe('Renamed trigger');
    // The untouched spec is left exactly as it was (partial update semantics).
    expect(updated.spec).toMatchObject({ kind: 'scheduled', intervalMinutes: 15 });

    const row = await rawTriggerRow(workspaceId, trigger.id);
    expect(row?.kind).toBe('scheduled');
  });

  it('9. PATCH as a "member" (not admin) -> 403', async () => {
    const { cookie: adminCookie, workspaceId } = await registerOwnerWithWorkspace();
    const trigger = await createTriggerAsAdmin(
      adminCookie,
      workspaceId,
      scheduledTriggerRequestBody('Immutable to member'),
    );
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .patch(triggerUrl(workspaceId, trigger.id))
      .set('Cookie', memberCookie)
      .send({ name: 'Attempted rename' });

    expect(response.status).toBe(403);

    const row = await rawTriggerRow(workspaceId, trigger.id);
    expect(row?.name).not.toBe('Attempted rename');
  });

  it('10. PATCH updating spec.pattern to an unsafe regex -> 400 (re-validates through the domain layer)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const trigger = await createTriggerAsAdmin(
      cookie,
      workspaceId,
      conditionTriggerRequestBody('Re-validated on update'),
    );

    const response = await request(server)
      .patch(triggerUrl(workspaceId, trigger.id))
      .set('Cookie', cookie)
      .send({
        spec: {
          kind: 'condition',
          objectType: 'task',
          fieldKey: 'status',
          pattern: '(a|a)+',
          flags: '',
          actionTemplate: { title: 'Flag as urgent' },
        },
      });

    expect(response.status).toBe(400);
  });

  it('11. DELETE as an admin -> 204, trigger lifecycle becomes "deleted" (verified via a subsequent GET list no longer including it)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const trigger = await createTriggerAsAdmin(
      cookie,
      workspaceId,
      scheduledTriggerRequestBody('Soon to be deleted'),
    );

    const response = await request(server)
      .delete(triggerUrl(workspaceId, trigger.id))
      .set('Cookie', cookie);
    expect(response.status).toBe(204);

    const row = await rawTriggerRow(workspaceId, trigger.id);
    expect(row).toBeDefined();
    expect(row?.lifecycle).toBe('deleted');

    const listResponse = await request(server).get(triggersUrl(workspaceId)).set('Cookie', cookie);
    const { triggers } = listResponse.body as TriggerListEnvelope;
    expect(triggers.some((t) => t.id === trigger.id)).toBe(false);
  });

  it('12. DELETE as a "member" (not admin) -> 403, and the trigger is not deleted', async () => {
    const { cookie: adminCookie, workspaceId } = await registerOwnerWithWorkspace();
    const trigger = await createTriggerAsAdmin(
      adminCookie,
      workspaceId,
      scheduledTriggerRequestBody('Protected from member delete'),
    );
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .delete(triggerUrl(workspaceId, trigger.id))
      .set('Cookie', memberCookie);
    expect(response.status).toBe(403);

    const row = await rawTriggerRow(workspaceId, trigger.id);
    expect(row?.lifecycle).toBe('active');
  });

  it("13. DELETE on an already-deleted trigger -> 409 (InvalidObjectStateError, mirrors deleteTrigger's contract)", async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const trigger = await createTriggerAsAdmin(
      cookie,
      workspaceId,
      scheduledTriggerRequestBody('Deleted twice'),
    );

    const firstDelete = await request(server)
      .delete(triggerUrl(workspaceId, trigger.id))
      .set('Cookie', cookie);
    expect(firstDelete.status).toBe(204);

    const secondDelete = await request(server)
      .delete(triggerUrl(workspaceId, trigger.id))
      .set('Cookie', cookie);
    expect(secondDelete.status).toBe(409);
  });

  it('14. cross-workspace isolation: a trigger created in workspace A is invisible to GET/PATCH/DELETE from workspace B (404, not a data leak)', async () => {
    const { cookie: cookieA, workspaceId: workspaceAId } = await registerOwnerWithWorkspace();
    const trigger = await createTriggerAsAdmin(
      cookieA,
      workspaceAId,
      scheduledTriggerRequestBody('Belongs only to workspace A'),
    );

    const { cookie: cookieB, workspaceId: workspaceBId } = await registerOwnerWithWorkspace();

    const patchResponse = await request(server)
      .patch(triggerUrl(workspaceBId, trigger.id))
      .set('Cookie', cookieB)
      .send({ name: 'Hijacked from workspace B' });
    expect(patchResponse.status).toBe(404);

    const deleteResponse = await request(server)
      .delete(triggerUrl(workspaceBId, trigger.id))
      .set('Cookie', cookieB);
    expect(deleteResponse.status).toBe(404);

    const listResponseB = await request(server)
      .get(triggersUrl(workspaceBId))
      .set('Cookie', cookieB);
    expect(listResponseB.status).toBe(200);
    const { triggers } = listResponseB.body as TriggerListEnvelope;
    expect(triggers.some((t) => t.id === trigger.id)).toBe(false);

    // Workspace A's own trigger is untouched by workspace B's attempts.
    const row = await rawTriggerRow(workspaceAId, trigger.id);
    expect(row?.lifecycle).toBe('active');
    expect(row?.name).toBe('Belongs only to workspace A');
  });

  it('15. a nonexistent triggerId in PATCH/DELETE -> 404', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const nonexistentId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

    const patchResponse = await request(server)
      .patch(triggerUrl(workspaceId, nonexistentId))
      .set('Cookie', cookie)
      .send({ name: 'Ghost trigger' });
    expect(patchResponse.status).toBe(404);

    const deleteResponse = await request(server)
      .delete(triggerUrl(workspaceId, nonexistentId))
      .set('Cookie', cookie);
    expect(deleteResponse.status).toBe(404);
  });

  it('16. projection detail: TriggerCreated writes a row with all expected columns (streamId, workspaceId, kind, spec as jsonb, lifecycle "active", lastFiredAt null, createdAt/updatedAt)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const trigger = await createTriggerAsAdmin(
      cookie,
      workspaceId,
      conditionTriggerRequestBody('Projection detail check'),
    );

    const row = await rawTriggerRow(workspaceId, trigger.id);
    expect(row).toBeDefined();
    expect(row?.streamId).toBeDefined();
    expect(row?.workspaceId).toBe(workspaceId);
    expect(row?.kind).toBe('condition');
    expect(row?.spec).toMatchObject({
      kind: 'condition',
      objectType: 'task',
      fieldKey: 'status',
      pattern: 'urgent',
    });
    expect(row?.lifecycle).toBe('active');
    expect(row?.lastFiredAt).toBeNull();
    expect(row?.createdAt).toBeDefined();
    expect(row?.updatedAt).toBeDefined();
  });

  it("17. projection detail: TriggerUpdated updates only the payload's present keys (updating name leaves spec/kind untouched in the read model)", async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const trigger = await createTriggerAsAdmin(
      cookie,
      workspaceId,
      conditionTriggerRequestBody('Original name for partial update'),
    );

    await request(server)
      .patch(triggerUrl(workspaceId, trigger.id))
      .set('Cookie', cookie)
      .send({ name: 'Only the name changed' });

    const row = await rawTriggerRow(workspaceId, trigger.id);
    expect(row?.kind).toBe('condition');
    expect(row?.spec).toMatchObject({
      kind: 'condition',
      objectType: 'task',
      fieldKey: 'status',
      pattern: 'urgent',
    });
  });

  it('18. guard stack: unauthenticated caller -> 401 on POST/GET/PATCH/DELETE', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();

    const postResponse = await request(server)
      .post(triggersUrl(workspaceId))
      .send(scheduledTriggerRequestBody('Anonymous attempt'));
    expect(postResponse.status).toBe(401);

    const getResponse = await request(server).get(triggersUrl(workspaceId));
    expect(getResponse.status).toBe(401);

    const patchResponse = await request(server)
      .patch(triggerUrl(workspaceId, '01ARZ3NDEKTSV4RRFFQ69G5FAV'))
      .send({ name: 'Anonymous rename' });
    expect(patchResponse.status).toBe(401);

    const deleteResponse = await request(server).delete(
      triggerUrl(workspaceId, '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    );
    expect(deleteResponse.status).toBe(401);
  });
});
