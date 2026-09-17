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
 * F3-T14 PR2 (RED step), ADR-0048 §c/RBAC özeti — the human-facing REST
 * endpoints for `FederationLinksController`
 * (`apps/server/src/federation/federation-links.controller.ts`, does NOT
 * exist yet): initiate/accept/revoke/list a `FederationLink`, plus viewing
 * this workspace's own federation audit log (ADR-0016 §a: read paths are
 * never role-gated beyond plain membership).
 *
 * ============================================================================
 * ROUTE SHAPE -- test-writer's OWN JUDGMENT CALL (the spec's "Açık Sorular"
 * section explicitly defers this to implementer as a "mimari karar
 * GEREKTİRMEYEN, küçük bir uygulama detayı"):
 *
 *   POST   /workspaces/:workspaceId/federation-links                body { counterpartWorkspaceId } -- admin+
 *   POST   /workspaces/:workspaceId/federation-links/:linkId/accept                                  -- admin+
 *   POST   /workspaces/:workspaceId/federation-links/:linkId/revoke                                  -- admin+
 *   GET    /workspaces/:workspaceId/federation-links                                                 -- member+ (read, ADR-0016 §a)
 *   GET    /workspaces/:workspaceId/federation-links/:linkId/audit-log                                -- member+ (read, ADR-0016 §a)
 *
 * If `implementer` picks different paths, only THIS file's `request(server)
 * .post(...)`/`.get(...)` call sites need revisiting -- every assertion is
 * about the RBAC/status-code CONTRACT, not the exact URL.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): none of these routes exist -- every request
 * below 404s (`FederationLinksController` is not wired into any module yet).
 * This is the correct red, not a test-logic bug.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string; email: string };
}
interface WorkspaceEnvelope {
  workspace: { id: string };
}

let emailCounter = 0;
function freshEmail(): string {
  emailCounter += 1;
  return `federation-links-controller-test-user-${String(emailCounter)}@example.com`;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('F3-T14 PR2 (RED step): federation-links REST endpoints (real Postgres + Redis via Testcontainers, ADR-0048 §c)', () => {
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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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

  async function registerOwnerWithWorkspace(label: string): Promise<{
    cookie: string;
    userId: string;
    workspaceId: string;
  }> {
    const { cookie, userId } = await registerUser();
    const workspaceId = await createWorkspace(cookie, `federation-links-controller test ${label}`);
    return { cookie, userId, workspaceId };
  }

  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<{ cookie: string; userId: string }> {
    const { cookie, userId } = await registerUser();
    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return { cookie, userId };
  }

  /** Extracts the created link's id from whichever envelope shape
   * `implementer` picks (`{ link: { id } }` or a bare `{ id }`), failing the
   * test loudly (rather than producing an `undefined` in a URL) if neither
   * shape is present. */
  function extractLinkId(body: unknown): string {
    const envelope = body as { link?: { id?: string }; id?: string };
    const linkId = envelope.link?.id ?? envelope.id;
    expect(linkId).toBeDefined();
    return linkId as string;
  }

  it('1. initiate (POST) as a "member" (below admin) -> 403', async () => {
    const host = await registerOwnerWithWorkspace('initiate-member-host');
    const grantee = await registerOwnerWithWorkspace('initiate-member-grantee');
    const { cookie: memberCookie } = await addMemberWithRole(host.workspaceId, 'member');

    const response = await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links`)
      .set('Cookie', memberCookie)
      .send({ counterpartWorkspaceId: grantee.workspaceId });

    expect(response.status).toBe(403);
  });

  it('2. initiate (POST) as a "guest" -> 403', async () => {
    const host = await registerOwnerWithWorkspace('initiate-guest-host');
    const grantee = await registerOwnerWithWorkspace('initiate-guest-grantee');
    const { cookie: guestCookie } = await addMemberWithRole(host.workspaceId, 'guest');

    const response = await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links`)
      .set('Cookie', guestCookie)
      .send({ counterpartWorkspaceId: grantee.workspaceId });

    expect(response.status).toBe(403);
  });

  it('3. initiate (POST) as the workspace owner (admin+) -> succeeds', async () => {
    const host = await registerOwnerWithWorkspace('initiate-owner-host');
    const grantee = await registerOwnerWithWorkspace('initiate-owner-grantee');

    const response = await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links`)
      .set('Cookie', host.cookie)
      .send({ counterpartWorkspaceId: grantee.workspaceId });

    expect(response.status).toBeLessThan(300);
  });

  it('4. accept (POST) as a "member" of the counterpart workspace -> 403', async () => {
    const host = await registerOwnerWithWorkspace('accept-member-host');
    const grantee = await registerOwnerWithWorkspace('accept-member-grantee');

    const initiateResponse = await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links`)
      .set('Cookie', host.cookie)
      .send({ counterpartWorkspaceId: grantee.workspaceId });
    const linkId = extractLinkId(initiateResponse.body);

    const { cookie: memberCookie } = await addMemberWithRole(grantee.workspaceId, 'member');

    const response = await request(server)
      .post(`/workspaces/${grantee.workspaceId}/federation-links/${linkId}/accept`)
      .set('Cookie', memberCookie)
      .send({});

    expect(response.status).toBe(403);
  });

  it('5. revoke (POST) as a "guest" -> 403', async () => {
    const host = await registerOwnerWithWorkspace('revoke-guest-host');
    const grantee = await registerOwnerWithWorkspace('revoke-guest-grantee');

    const initiateResponse = await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links`)
      .set('Cookie', host.cookie)
      .send({ counterpartWorkspaceId: grantee.workspaceId });
    const linkId = extractLinkId(initiateResponse.body);

    const { cookie: guestCookie } = await addMemberWithRole(host.workspaceId, 'guest');

    const response = await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links/${linkId}/revoke`)
      .set('Cookie', guestCookie)
      .send({});

    expect(response.status).toBe(403);
  });

  it('6. list federation links (GET) as a "member" -> 200, NOT 403 (read paths are never role-gated beyond membership, ADR-0016 §a)', async () => {
    const host = await registerOwnerWithWorkspace('list-member-host');
    const { cookie: memberCookie } = await addMemberWithRole(host.workspaceId, 'member');

    const response = await request(server)
      .get(`/workspaces/${host.workspaceId}/federation-links`)
      .set('Cookie', memberCookie);

    expect(response.status).toBe(200);
  });

  it('7. federation audit-log view (GET) as a "member" -> 200, NOT 403 -- member+ is sufficient per this spec\'s RBAC table', async () => {
    const host = await registerOwnerWithWorkspace('audit-log-member-host');
    const grantee = await registerOwnerWithWorkspace('audit-log-member-grantee');

    const initiateResponse = await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links`)
      .set('Cookie', host.cookie)
      .send({ counterpartWorkspaceId: grantee.workspaceId });
    const linkId = extractLinkId(initiateResponse.body);

    const { cookie: memberCookie } = await addMemberWithRole(host.workspaceId, 'member');

    const response = await request(server)
      .get(`/workspaces/${host.workspaceId}/federation-links/${linkId}/audit-log`)
      .set('Cookie', memberCookie);

    expect(response.status).toBe(200);
  });

  it('8. federation audit-log view (GET), unauthenticated (no session cookie at all) -> 401, never 200', async () => {
    const host = await registerOwnerWithWorkspace('audit-log-unauth-host');
    const grantee = await registerOwnerWithWorkspace('audit-log-unauth-grantee');

    const initiateResponse = await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links`)
      .set('Cookie', host.cookie)
      .send({ counterpartWorkspaceId: grantee.workspaceId });
    const linkId = extractLinkId(initiateResponse.body);

    const response = await request(server).get(
      `/workspaces/${host.workspaceId}/federation-links/${linkId}/audit-log`,
    );

    expect(response.status).toBe(401);
  });
});
