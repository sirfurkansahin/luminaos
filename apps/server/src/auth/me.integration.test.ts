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
 * RED-step integration tests for F2-T3b's `GET /me` expansion.
 *
 * Today `me.controller.ts` returns `{user: {id, email, createdAt}}` only.
 * F2-T3b's target shape (see `docs/specs/F2-E1/F2-T3b-desktop-login-session.md`,
 * "HEDEF ŞEKİL" item 1) is `{user, workspaces: {id, name}[]}` — the list of
 * ALL workspaces the caller is a member of (possibly empty). This is what
 * lets `apps/desktop`'s `SessionContext` auto-select a workspace for a
 * single-workspace user and show a `WorkspacePicker` for a multi-workspace
 * one, without a separate `GET /workspaces` endpoint (Open Question 1,
 * Option B).
 *
 * These tests EXTEND coverage of `GET /me` (no such test file existed
 * before this task — `tenant-isolation.integration.test.ts` covers the
 * single-workspace happy path as a side effect of a broader flow, but never
 * asserts on a `workspaces` array). They are expected to fail today: the
 * response body has no `workspaces` key at all, so every `body.workspaces`
 * access below is `undefined`.
 *
 * Same real-Postgres-via-Testcontainers + real-HTTP-via-supertest strategy
 * as `../fields/field-definitions-security.integration.test.ts` and
 * `./tenant-isolation.integration.test.ts` — nothing is mocked. The
 * multi-workspace-membership scenario (test 3) uses a raw-DB `memberships`
 * insert (mirroring `field-definitions-security.integration.test.ts`'s
 * `addMemberWithRole` helper) because there is no "join an existing
 * workspace" HTTP endpoint — a user's ADDITIONAL memberships (beyond the
 * ones auto-created for workspaces they themselves create via
 * `POST /workspaces`) can only be established this way today.
 */

const PASSWORD = 'correct-horse-battery-staple';

interface WorkspaceSummary {
  id: string;
  name: string;
}

interface MeEnvelope {
  user: { id: string; email: string; createdAt: string };
  workspaces: WorkspaceSummary[];
}

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `me-endpoint-test-user-${String(emailCounter)}@example.com`;
}

describe('GET /me workspaces expansion (F2-T3b, real Postgres + real HTTP via Testcontainers + supertest)', () => {
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

    // AppModule is imported only after DATABASE_URL/REDIS_URL are set, same
    // rationale as the sibling integration tests in this package.
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

  it('a logged-in user with NO workspace memberships gets workspaces: []', async () => {
    const { cookie } = await registerUser();

    const meResponse = await request(server).get('/me').set('Cookie', cookie);

    expect(meResponse.status).toBe(200);
    const body = meResponse.body as MeEnvelope;
    expect(Array.isArray(body.workspaces)).toBe(true);
    expect(body.workspaces).toEqual([]);
  });

  it('a user who is a member of exactly one workspace sees that workspace {id, name} in workspaces', async () => {
    const { cookie } = await registerUser();
    const workspaceId = await createWorkspace(cookie, 'Solo Workspace');

    const meResponse = await request(server).get('/me').set('Cookie', cookie);

    expect(meResponse.status).toBe(200);
    const body = meResponse.body as MeEnvelope;
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toEqual({ id: workspaceId, name: 'Solo Workspace' });
  });

  it('a user who is a member of MULTIPLE workspaces sees ALL of them in workspaces', async () => {
    const { cookie, userId } = await registerUser();
    const workspace1Id = await createWorkspace(cookie, 'First Workspace');

    // Second workspace is created by a DIFFERENT user, so this user's
    // membership in it can only come from an explicit membership row, not
    // from being the creator — proves `GET /me` lists ALL memberships, not
    // just workspaces the caller happens to own.
    const { cookie: otherCookie } = await registerUser();
    const workspace2Id = await createWorkspace(otherCookie, 'Second Workspace');
    await rawDb.insert(memberships).values({ workspaceId: workspace2Id, userId, role: 'member' });

    const meResponse = await request(server).get('/me').set('Cookie', cookie);

    expect(meResponse.status).toBe(200);
    const body = meResponse.body as MeEnvelope;
    expect(body.workspaces).toHaveLength(2);
    expect(body.workspaces).toContainEqual({ id: workspace1Id, name: 'First Workspace' });
    expect(body.workspaces).toContainEqual({ id: workspace2Id, name: 'Second Workspace' });
  });

  it('cross-user isolation: user A workspaces never include user B workspaces, and vice versa', async () => {
    const { cookie: cookieA } = await registerUser();
    const workspaceAId = await createWorkspace(cookieA, 'Workspace A');

    const { cookie: cookieB } = await registerUser();
    const workspaceBId = await createWorkspace(cookieB, 'Workspace B');

    const meAResponse = await request(server).get('/me').set('Cookie', cookieA);
    const meBResponse = await request(server).get('/me').set('Cookie', cookieB);

    expect(meAResponse.status).toBe(200);
    expect(meBResponse.status).toBe(200);

    const bodyA = meAResponse.body as MeEnvelope;
    const bodyB = meBResponse.body as MeEnvelope;

    const workspaceIdsA = bodyA.workspaces.map((workspace) => workspace.id);
    const workspaceIdsB = bodyB.workspaces.map((workspace) => workspace.id);

    expect(workspaceIdsA).toEqual([workspaceAId]);
    expect(workspaceIdsA).not.toContain(workspaceBId);

    expect(workspaceIdsB).toEqual([workspaceBId]);
    expect(workspaceIdsB).not.toContain(workspaceAId);
  });

  it('regression: an unauthenticated GET /me is still rejected with 401 (workspaces expansion must not weaken auth)', async () => {
    const response = await request(server).get('/me');
    expect(response.status).toBe(401);
  });
});
