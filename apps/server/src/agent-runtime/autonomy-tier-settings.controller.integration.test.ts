import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F3-T5 PR1 (RED step), ADR-0039 Karar (i) and the spec's PR1 Kabul
 * Kriterleri (`docs/specs/F3-E2/F3-T5-otonomi-kadrani.md`): server-side HTTP
 * wiring for a NEW controller at `workspaces/:workspaceId/task-autonomy-
 * settings`, ONLY `GET`+`PUT` (no POST/DELETE/PATCH anywhere on this
 * controller -- the spec's explicit Kabul Kriteri). Mirrors `agent-directory.
 * controller.integration.test.ts`'s exact harness (full Nest app boot via
 * Testcontainers Postgres 16 + Redis 7, real `SessionAuthGuard`/
 * `WorkspaceMembershipGuard` flow, the same `addMemberWithRole` raw-insert-
 * into-`memberships` helper) -- this controller's RBAC is likewise flat/
 * workspace-wide (`admin`+ writes via `PUT`, `member`+ reads via `GET`), the
 * same shape as `AgentPermissionManifestsController`.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): no `AutonomyTierSettingsService` / `Autonomy
 * TierSettingsController` / `task_autonomy_settings` schema+migration exist
 * yet, and `AgentRuntimeModule.controllers` does not list any such
 * controller -- every request below to `/workspaces/:workspaceId/task-
 * autonomy-settings...` is expected to 404 via Nest's own default "Cannot
 * GET/PUT ..." handler (no matching route at all), NOT via `AppErrorFilter`
 * mapping an `AppError`, mirroring `agent-directory.controller.integration.
 * test.ts`'s own documented red-state note for the analogous "controller
 * doesn't exist yet" situation. This file deliberately does NOT statically
 * import `AutonomyTierSettingsService`/the `task_autonomy_settings` schema
 * module, staying purely black-box/HTTP for this reason; every assertion
 * below is against HTTP response bodies/status codes only.
 *
 * `implementer` must: add `autonomy-tier-settings.service.ts` +
 * `autonomy-tier-settings.controller.ts` (guarded by `SessionAuthGuard` +
 * `WorkspaceMembershipGuard` at the class level, calling the service's
 * `set`/`list`) and register both in `AgentRuntimeModule` (no new module
 * file needed, same module as `AgentPermissionManifestsService`/
 * `AgentDirectoryService`). A minimal `{ tier: AutonomyTier }` zod body
 * validator is required for the `PUT` route (test #7 below pins its
 * rejection behavior), but this test file does not pin its exact
 * location/name -- only the wire contract below.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `@Controller('workspaces/:workspaceId/task-autonomy-settings')`, guarded
 * by `SessionAuthGuard` + `WorkspaceMembershipGuard` at the class level
 * (mirrors `AgentPermissionManifestsController` exactly). ONLY two routes
 * exist:
 *
 *   GET  /workspaces/:workspaceId/task-autonomy-settings
 *        -> 200 { settings: [...] } (requires `member`+, else 403)
 *
 *   PUT  /workspaces/:workspaceId/task-autonomy-settings/:actionType
 *        body: { tier: 'propose' | 'approve_and_act' | 'act_and_notify' }
 *        -> 200 { setting } (requires `admin`+, else 403)
 *        For `:actionType` = `reconfigureAgentPermissions` with a non-
 *        `propose` `tier` -> 403 even for an admin caller (`ForbiddenError`
 *        -> `AppErrorFilter` -> HTTP 403), the governance floor enforced
 *        over HTTP (ADR-0039 Karar c).
 *        An invalid `tier` value (not one of the 3 enum values) -> 400
 *        (zod validation failure -> `ZodValidationPipe` -> HTTP 400).
 *
 * No POST/DELETE/PATCH route exists anywhere on this controller.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface TaskAutonomySettingBody {
  id: string;
  workspaceId: string;
  actionType: string;
  tier: 'propose' | 'approve_and_act' | 'act_and_notify';
  updatedAt: string;
}

interface SettingEnvelope {
  setting: TaskAutonomySettingBody;
}

interface SettingsListEnvelope {
  settings: TaskAutonomySettingBody[];
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `autonomy-tier-settings-test-user-${String(emailCounter)}@example.com`;
}

describe('F3-T5 PR1 (RED step): HTTP .../task-autonomy-settings -- workspace-scoped autonomy tier settings GET/PUT (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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
      .send({ name: `Task autonomy settings test workspace ${String(emailCounter)}` });
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

  function settingsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/task-autonomy-settings`;
  }

  function settingUrl(workspaceId: string, actionType: string): string {
    return `${settingsUrl(workspaceId)}/${actionType}`;
  }

  it("1. PUT .../task-autonomy-settings/createTask {tier:'approve_and_act'} as the workspace owner (admin) -> 200, returns the setting", async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .put(settingUrl(workspaceId, 'createTask'))
      .set('Cookie', cookie)
      .send({ tier: 'approve_and_act' });

    expect(response.status).toBe(200);
    const { setting } = response.body as SettingEnvelope;
    expect(setting.workspaceId).toBe(workspaceId);
    expect(setting.actionType).toBe('createTask');
    expect(setting.tier).toBe('approve_and_act');
  });

  it('2. PUT as a "member" (not admin) -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .put(settingUrl(workspaceId, 'createTask'))
      .set('Cookie', memberCookie)
      .send({ tier: 'approve_and_act' });

    expect(response.status).toBe(403);
  });

  it("3. PUT .../task-autonomy-settings/reconfigureAgentPermissions {tier:'act_and_notify'} as admin -> 403 (governance floor, enforced even over HTTP)", async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .put(settingUrl(workspaceId, 'reconfigureAgentPermissions'))
      .set('Cookie', cookie)
      .send({ tier: 'act_and_notify' });

    expect(response.status).toBe(403);
  });

  it('4. GET .../task-autonomy-settings as "member" -> 200, lists settings', async () => {
    const { cookie: adminCookie, workspaceId } = await registerOwnerWithWorkspace();
    await request(server)
      .put(settingUrl(workspaceId, 'createTask'))
      .set('Cookie', adminCookie)
      .send({ tier: 'approve_and_act' });

    const memberCookie = await addMemberWithRole(workspaceId, 'member');
    const response = await request(server)
      .get(settingsUrl(workspaceId))
      .set('Cookie', memberCookie);

    expect(response.status).toBe(200);
    const { settings } = response.body as SettingsListEnvelope;
    expect(settings.some((s) => s.actionType === 'createTask')).toBe(true);
  });

  it('5. GET .../task-autonomy-settings as "guest" -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    const response = await request(server).get(settingsUrl(workspaceId)).set('Cookie', guestCookie);

    expect(response.status).toBe(403);
  });

  it('6. unauthenticated caller -> 401 on both GET and PUT', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();

    const getResponse = await request(server).get(settingsUrl(workspaceId));
    expect(getResponse.status).toBe(401);

    const putResponse = await request(server)
      .put(settingUrl(workspaceId, 'createTask'))
      .send({ tier: 'approve_and_act' });
    expect(putResponse.status).toBe(401);
  });

  it('7. PUT with an invalid tier value (not one of the 3 enum values) -> 400 (zod validation)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .put(settingUrl(workspaceId, 'createTask'))
      .set('Cookie', cookie)
      .send({ tier: 'auto_pilot' });

    expect(response.status).toBe(400);
  });
});
