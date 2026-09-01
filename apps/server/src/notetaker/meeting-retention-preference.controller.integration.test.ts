import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { meetingRetentionPreferences } from '../db/schema/meeting-retention-preferences.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T14 PR2 (RED step, part 2 of 2) -- read/write API for the workspace's
 * meeting retention preference (ADR-0031 §a/§b): `GET
 * /workspaces/:workspaceId/meeting-retention-preference` (any member+ role,
 * returns the code-level default `transcript-only` if no row exists yet --
 * never a raw 404 for "unset", since "unset" has a well-defined default) and
 * `PUT /workspaces/:workspaceId/meeting-retention-preference` (body
 * `{mode}`, zod-validated against the 3-value enum, requiring `admin`+ role
 * -- a workspace-governance decision per ADR-0029's reasoning). `PUT`
 * upserts (create if absent, update `mode`+`updatedAt` if present).
 *
 * Mirrors `meeting-invite.controller.integration.test.ts`'s exact harness:
 * full Nest app boot (Postgres 16 + Redis 7 via Testcontainers), real
 * `SessionAuthGuard`/`WorkspaceMembershipGuard` flow, `memberships` raw-insert
 * `addMemberWithRole` helper (the only way to get a `member`/`guest`/`admin`
 * session in this codebase's test suites, per that file's own header note).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `NotetakerModule`/`AppModule` already exist
 * (F2-T13 landed), but neither wires any controller/route for
 * `.../meeting-retention-preference` yet -- every request below 404s as a
 * plain Nest "Cannot GET/PUT ..." unmatched-route response (not this
 * codebase's `AppError`-shaped body), mirroring
 * `meeting-invite.controller.integration.test.ts`'s own documented red-state
 * note for the analogous "route not wired yet" situation. `meeting_retention_
 * preferences` itself already exists (F2-T14 PR1, merged) -- so the raw
 * Drizzle helpers below against that table succeed even before this PR's
 * controller/service exist; only the HTTP assertions are the actual red
 * signal.
 * ============================================================================
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface RetentionPreferenceBody {
  mode: 'recording-reference' | 'transcript-only' | 'summary-only';
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `meeting-retention-preference-test-user-${String(emailCounter)}@example.com`;
}

describe('F2-T14 PR2 (RED step): GET/PUT .../meeting-retention-preference -- workspace-scoped retention preference read/write (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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
      .send({ name: `Meeting retention preference test workspace ${String(emailCounter)}` });
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

  function preferenceUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/meeting-retention-preference`;
  }

  async function rawPreferenceRow(workspaceId: string): Promise<{ mode: string } | undefined> {
    const [row] = await rawDb
      .select({ mode: meetingRetentionPreferences.mode })
      .from(meetingRetentionPreferences)
      .where(eq(meetingRetentionPreferences.workspaceId, workspaceId));
    return row;
  }

  it('1. GET with no preference row set -> 200, returns the code-level default "transcript-only" (never a 404 for "unset")', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server).get(preferenceUrl(workspaceId)).set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect((response.body as RetentionPreferenceBody).mode).toBe('transcript-only');

    const row = await rawPreferenceRow(workspaceId);
    expect(row).toBeUndefined();
  });

  it('2. PUT as owner (admin+) sets the mode, and a subsequent GET reflects it', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const putResponse = await request(server)
      .put(preferenceUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ mode: 'recording-reference' });
    expect(putResponse.status).toBe(200);
    expect((putResponse.body as RetentionPreferenceBody).mode).toBe('recording-reference');

    const getResponse = await request(server).get(preferenceUrl(workspaceId)).set('Cookie', cookie);
    expect(getResponse.status).toBe(200);
    expect((getResponse.body as RetentionPreferenceBody).mode).toBe('recording-reference');

    const row = await rawPreferenceRow(workspaceId);
    expect(row?.mode).toBe('recording-reference');
  });

  it('3. PUT as an explicit admin (non-owner) role also succeeds', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const adminCookie = await addMemberWithRole(workspaceId, 'admin');

    const putResponse = await request(server)
      .put(preferenceUrl(workspaceId))
      .set('Cookie', adminCookie)
      .send({ mode: 'summary-only' });

    expect(putResponse.status).toBe(200);
    expect((putResponse.body as RetentionPreferenceBody).mode).toBe('summary-only');
  });

  it('4. PUT with an already-existing preference row upserts (updates mode) rather than erroring on a duplicate/conflict', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const firstPut = await request(server)
      .put(preferenceUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ mode: 'transcript-only' });
    expect(firstPut.status).toBe(200);

    const secondPut = await request(server)
      .put(preferenceUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ mode: 'summary-only' });
    expect(secondPut.status).toBe(200);
    expect((secondPut.body as RetentionPreferenceBody).mode).toBe('summary-only');

    const row = await rawPreferenceRow(workspaceId);
    expect(row?.mode).toBe('summary-only');
  });

  it('5. PUT as a "member" role -> 403, and the stored value is NOT changed', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    await request(server)
      .put(preferenceUrl(workspaceId))
      .set('Cookie', ownerCookie)
      .send({ mode: 'transcript-only' });

    const memberCookie = await addMemberWithRole(workspaceId, 'member');
    const response = await request(server)
      .put(preferenceUrl(workspaceId))
      .set('Cookie', memberCookie)
      .send({ mode: 'summary-only' });

    expect(response.status).toBe(403);

    const row = await rawPreferenceRow(workspaceId);
    expect(row?.mode).toBe('transcript-only');
  });

  it('6. PUT as a "guest" role -> 403, and the stored value is NOT changed', async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    await request(server)
      .put(preferenceUrl(workspaceId))
      .set('Cookie', ownerCookie)
      .send({ mode: 'recording-reference' });

    const guestCookie = await addMemberWithRole(workspaceId, 'guest');
    const response = await request(server)
      .put(preferenceUrl(workspaceId))
      .set('Cookie', guestCookie)
      .send({ mode: 'summary-only' });

    expect(response.status).toBe(403);

    const row = await rawPreferenceRow(workspaceId);
    expect(row?.mode).toBe('recording-reference');
  });

  it('7. GET is readable by a "member"/"guest" role (any member+ may read, only admin+ may write)', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const memberCookie = await addMemberWithRole(workspaceId, 'member');
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    const memberResponse = await request(server)
      .get(preferenceUrl(workspaceId))
      .set('Cookie', memberCookie);
    expect(memberResponse.status).toBe(200);

    const guestResponse = await request(server)
      .get(preferenceUrl(workspaceId))
      .set('Cookie', guestCookie);
    expect(guestResponse.status).toBe(200);
  });

  it('8. PUT with an invalid mode string -> validation error (400), no row is written', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .put(preferenceUrl(workspaceId))
      .set('Cookie', cookie)
      .send({ mode: 'delete-everything' });

    expect(response.status).toBe(400);

    const row = await rawPreferenceRow(workspaceId);
    expect(row).toBeUndefined();
  });

  it('9. PUT with a missing "mode" field -> 400', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .put(preferenceUrl(workspaceId))
      .set('Cookie', cookie)
      .send({});

    expect(response.status).toBe(400);
  });

  it("10. cross-workspace isolation: a caller who is not a member of workspace A gets 403 on both GET and PUT for workspace A's preference (mirrors WorkspaceMembershipGuard's standard non-member behavior elsewhere in this codebase, no new code needed)", async () => {
    const { cookie: ownerACookie, workspaceId: workspaceAId } = await registerOwnerWithWorkspace();
    await request(server)
      .put(preferenceUrl(workspaceAId))
      .set('Cookie', ownerACookie)
      .send({ mode: 'recording-reference' });

    const outsider = await registerOwnerWithWorkspace();

    const crossGetResponse = await request(server)
      .get(preferenceUrl(workspaceAId))
      .set('Cookie', outsider.cookie);
    expect(crossGetResponse.status).toBe(403);

    const crossPutResponse = await request(server)
      .put(preferenceUrl(workspaceAId))
      .set('Cookie', outsider.cookie)
      .send({ mode: 'summary-only' });
    expect(crossPutResponse.status).toBe(403);

    // Workspace A's own preference is untouched by the outsider's attempt.
    const row = await rawPreferenceRow(workspaceAId);
    expect(row?.mode).toBe('recording-reference');

    // And the outsider's OWN workspace still correctly defaults, proving
    // this isn't a global/shared-state bug.
    const outsiderOwnGet = await request(server)
      .get(preferenceUrl(outsider.workspaceId))
      .set('Cookie', outsider.cookie);
    expect(outsiderOwnGet.status).toBe(200);
    expect((outsiderOwnGet.body as RetentionPreferenceBody).mode).toBe('transcript-only');
  });

  it('11. guard stack: unauthenticated caller -> 401 on both GET and PUT', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();

    const getResponse = await request(server).get(preferenceUrl(workspaceId));
    expect(getResponse.status).toBe(401);

    const putResponse = await request(server)
      .put(preferenceUrl(workspaceId))
      .send({ mode: 'transcript-only' });
    expect(putResponse.status).toBe(401);
  });
});
