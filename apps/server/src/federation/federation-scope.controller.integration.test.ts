import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FederationLinksService } from './federation-links.service.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F3-T14 PR2 (RED step), ADR-0048 §e/RBAC özeti — the human-facing REST
 * endpoints for `FederationScopeController`
 * (`apps/server/src/federation/federation-scope.controller.ts`, does NOT
 * exist yet): add/remove/list scope objects on an active `FederationLink`,
 * and create/revoke `federation_link_credentials`.
 *
 * ============================================================================
 * ROUTE SHAPE -- test-writer's OWN JUDGMENT CALL (same "small implementation
 * detail, no architectural decision needed" deferral as
 * `./federation-links.controller.integration.test.ts`'s header explains):
 *
 *   POST   /workspaces/:workspaceId/federation-links/:linkId/scope                          body { objectId } -- admin+
 *   DELETE /workspaces/:workspaceId/federation-links/:linkId/scope/:objectId                                   -- admin+
 *   GET    /workspaces/:workspaceId/federation-links/:linkId/scope                                             -- member+ (read, ADR-0016 §a)
 *   POST   /workspaces/:workspaceId/federation-links/:linkId/credentials                     body { name, expiresAtDays? } -- admin+
 *   POST   /workspaces/:workspaceId/federation-links/:linkId/credentials/:credentialId/revoke                  -- admin+
 *
 * `FederationLinksService` (PR1, already exists) is used DIRECTLY (via
 * `app.get(...)`) to set up a real, active link fixture for each test --
 * `FederationLinksController`'s own REST surface is a SEPARATE file/PR2
 * scope, not a dependency of this one.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): none of these routes exist -- every request
 * below 404s. This is the correct red, not a test-logic bug.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string; email: string };
}
interface WorkspaceEnvelope {
  workspace: { id: string };
}
interface ObjectEnvelope {
  object: { id: string };
}

let emailCounter = 0;
function freshEmail(): string {
  emailCounter += 1;
  return `federation-scope-controller-test-user-${String(emailCounter)}@example.com`;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('F3-T14 PR2 (RED step): federation-scope REST endpoints (real Postgres + Redis via Testcontainers, ADR-0048 §e)', () => {
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
    const workspaceId = await createWorkspace(cookie, `federation-scope-controller test ${label}`);
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

  async function createObject(cookie: string, workspaceId: string, title: string): Promise<string> {
    const response = await request(server)
      .post(`/workspaces/${workspaceId}/objects`)
      .set('Cookie', cookie)
      .send({ objectType: 'task', title });
    expect(response.status).toBe(201);
    return (response.body as ObjectEnvelope).object.id;
  }

  /** Real, ACTIVE `FederationLink` via the already-existing PR1
   * `FederationLinksService` (this controller's REST surface is not itself
   * under test here). */
  async function createActiveLink(
    hostWorkspaceId: string,
    hostUserId: string,
    granteeWorkspaceId: string,
    granteeUserId: string,
  ): Promise<string> {
    const linksService = app.get(FederationLinksService);
    const link = await linksService.initiate(
      hostWorkspaceId,
      granteeWorkspaceId,
      hostUserId,
      'admin',
    );
    await linksService.accept(link.id, granteeUserId, 'admin');
    return link.id;
  }

  it('1. add scope object (POST) as a "member" (below admin) -> 403', async () => {
    const host = await registerOwnerWithWorkspace('add-scope-member-host');
    const grantee = await registerOwnerWithWorkspace('add-scope-member-grantee');
    const linkId = await createActiveLink(
      host.workspaceId,
      host.userId,
      grantee.workspaceId,
      grantee.userId,
    );
    const objectId = await createObject(host.cookie, host.workspaceId, 'scope target object');
    const { cookie: memberCookie } = await addMemberWithRole(host.workspaceId, 'member');

    const response = await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links/${linkId}/scope`)
      .set('Cookie', memberCookie)
      .send({ objectId });

    expect(response.status).toBe(403);
  });

  it("2. add scope object (POST) as the host workspace's admin+ -> succeeds", async () => {
    const host = await registerOwnerWithWorkspace('add-scope-admin-host');
    const grantee = await registerOwnerWithWorkspace('add-scope-admin-grantee');
    const linkId = await createActiveLink(
      host.workspaceId,
      host.userId,
      grantee.workspaceId,
      grantee.userId,
    );
    const objectId = await createObject(host.cookie, host.workspaceId, 'scope target object 2');

    const response = await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links/${linkId}/scope`)
      .set('Cookie', host.cookie)
      .send({ objectId });

    expect(response.status).toBeLessThan(300);
  });

  it('3. remove scope object (DELETE) as a "guest" -> 403', async () => {
    const host = await registerOwnerWithWorkspace('remove-scope-guest-host');
    const grantee = await registerOwnerWithWorkspace('remove-scope-guest-grantee');
    const linkId = await createActiveLink(
      host.workspaceId,
      host.userId,
      grantee.workspaceId,
      grantee.userId,
    );
    const objectId = await createObject(host.cookie, host.workspaceId, 'scope target object 3');
    const { cookie: guestCookie } = await addMemberWithRole(host.workspaceId, 'guest');

    const response = await request(server)
      .delete(`/workspaces/${host.workspaceId}/federation-links/${linkId}/scope/${objectId}`)
      .set('Cookie', guestCookie);

    expect(response.status).toBe(403);
  });

  it('4. list scope objects (GET) as a "member" -> 200, NOT 403 (read path, ADR-0016 §a)', async () => {
    const host = await registerOwnerWithWorkspace('list-scope-member-host');
    const grantee = await registerOwnerWithWorkspace('list-scope-member-grantee');
    const linkId = await createActiveLink(
      host.workspaceId,
      host.userId,
      grantee.workspaceId,
      grantee.userId,
    );
    const { cookie: memberCookie } = await addMemberWithRole(host.workspaceId, 'member');

    const response = await request(server)
      .get(`/workspaces/${host.workspaceId}/federation-links/${linkId}/scope`)
      .set('Cookie', memberCookie);

    expect(response.status).toBe(200);
  });

  it('5. create federation credential (POST) as a "member" -> 403', async () => {
    const host = await registerOwnerWithWorkspace('create-cred-member-host');
    const grantee = await registerOwnerWithWorkspace('create-cred-member-grantee');
    const linkId = await createActiveLink(
      host.workspaceId,
      host.userId,
      grantee.workspaceId,
      grantee.userId,
    );
    const { cookie: memberCookie } = await addMemberWithRole(host.workspaceId, 'member');

    const response = await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links/${linkId}/credentials`)
      .set('Cookie', memberCookie)
      .send({ name: 'attempted member credential' });

    expect(response.status).toBe(403);
  });

  it('6. create federation credential (POST) as admin+ -> succeeds, and NEVER echoes a bare "expiresAtDays: null"/unlimited option back (İnsan kararı 4 regression at the HTTP boundary)', async () => {
    const host = await registerOwnerWithWorkspace('create-cred-admin-host');
    const grantee = await registerOwnerWithWorkspace('create-cred-admin-grantee');
    const linkId = await createActiveLink(
      host.workspaceId,
      host.userId,
      grantee.workspaceId,
      grantee.userId,
    );

    const response = await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links/${linkId}/credentials`)
      .set('Cookie', host.cookie)
      .send({ name: 'admin-created credential' });

    expect(response.status).toBeLessThan(300);
    expect(JSON.stringify(response.body)).not.toContain('"expiresAt":null');
  });

  it('7. revoke federation credential (POST) as a "guest" -> 403', async () => {
    const host = await registerOwnerWithWorkspace('revoke-cred-guest-host');
    const grantee = await registerOwnerWithWorkspace('revoke-cred-guest-grantee');
    const linkId = await createActiveLink(
      host.workspaceId,
      host.userId,
      grantee.workspaceId,
      grantee.userId,
    );

    const createResponse = await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links/${linkId}/credentials`)
      .set('Cookie', host.cookie)
      .send({ name: 'to be revoked' });
    const envelope = createResponse.body as { credential?: { id?: string }; id?: string };
    const credentialId = envelope.credential?.id ?? envelope.id;
    expect(credentialId).toBeDefined();

    const { cookie: guestCookie } = await addMemberWithRole(host.workspaceId, 'guest');

    const response = await request(server)
      .post(
        `/workspaces/${host.workspaceId}/federation-links/${linkId}/credentials/${String(credentialId)}/revoke`,
      )
      .set('Cookie', guestCookie)
      .send({});

    expect(response.status).toBe(403);
  });

  it("9. list scope objects (GET) using a THIRD workspace's own workspaceId (a member of it, but not a party to linkId at all) -> 403, never leaking another pair of organizations' shared-object list (security-reviewer finding, PR2)", async () => {
    const host = await registerOwnerWithWorkspace('list-scope-idor-host');
    const grantee = await registerOwnerWithWorkspace('list-scope-idor-grantee');
    const linkId = await createActiveLink(
      host.workspaceId,
      host.userId,
      grantee.workspaceId,
      grantee.userId,
    );
    const objectId = await createObject(host.cookie, host.workspaceId, 'idor scope target object');
    await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links/${linkId}/scope`)
      .set('Cookie', host.cookie)
      .send({ objectId });

    const outsider = await registerOwnerWithWorkspace('list-scope-idor-outsider');

    const response = await request(server)
      .get(`/workspaces/${outsider.workspaceId}/federation-links/${linkId}/scope`)
      .set('Cookie', outsider.cookie);

    expect(response.status).toBe(403);
  });

  it("10. remove scope object (DELETE) using the GRANTEE side's own workspaceId (a real admin+ party to linkId, but NOT the object's ownerWorkspaceId) -> fails, never tombstoning an object the HOST never agreed to un-share (ADR-0048 §e: removal needs the SAME authority as addition, security-reviewer finding, PR2)", async () => {
    const host = await registerOwnerWithWorkspace('remove-scope-wrong-side-host');
    const grantee = await registerOwnerWithWorkspace('remove-scope-wrong-side-grantee');
    const linkId = await createActiveLink(
      host.workspaceId,
      host.userId,
      grantee.workspaceId,
      grantee.userId,
    );
    const objectId = await createObject(
      host.cookie,
      host.workspaceId,
      'wrong-side removal target object',
    );
    await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links/${linkId}/scope`)
      .set('Cookie', host.cookie)
      .send({ objectId });

    const response = await request(server)
      .delete(`/workspaces/${grantee.workspaceId}/federation-links/${linkId}/scope/${objectId}`)
      .set('Cookie', grantee.cookie);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);

    const stillActive = await request(server)
      .get(`/workspaces/${host.workspaceId}/federation-links/${linkId}/scope`)
      .set('Cookie', host.cookie);
    const scopeObjects = (stillActive.body as { scopeObjects: { objectId: string }[] })
      .scopeObjects;
    expect(scopeObjects.some((row) => row.objectId === objectId)).toBe(true);
  });

  it('8. rejects an out-of-range expiresAtDays (e.g. 7) with a 4xx, never silently coercing to the 90-day default or accepting it', async () => {
    const host = await registerOwnerWithWorkspace('invalid-expiry-host');
    const grantee = await registerOwnerWithWorkspace('invalid-expiry-grantee');
    const linkId = await createActiveLink(
      host.workspaceId,
      host.userId,
      grantee.workspaceId,
      grantee.userId,
    );

    const response = await request(server)
      .post(`/workspaces/${host.workspaceId}/federation-links/${linkId}/credentials`)
      .set('Cookie', host.cookie)
      .send({ name: 'invalid expiry attempt', expiresAtDays: 7 });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
