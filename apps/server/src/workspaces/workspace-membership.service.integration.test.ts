import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';

import { WorkspaceMembershipService } from './workspace-membership.service.js';
import { runMigrations } from '../db/migrate.js';

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T11 PR3 (RED): behavior-preserving extraction of
 * `WorkspaceMembershipGuard`'s core membership check into a reusable,
 * HTTP-context-free `WorkspaceMembershipService`, so the PR4 WebSocket
 * gateway can authorize connections outside an Express request cycle.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS FILE (implementer must match precisely):
 *
 *   `apps/server/src/workspaces/workspace-membership.service.ts` exports an
 *   `@Injectable()` class `WorkspaceMembershipService` with:
 *
 *     assertMembership(
 *       userId: string,
 *       workspaceId: string,
 *     ): Promise<{ workspaceId: string; role: string }>
 *
 *   Behavior — IDENTICAL to the guard's current core logic
 *   (`./workspace-membership.guard.ts`), which is the regression net (do NOT
 *   modify the guard or any other file):
 *
 *   1. Returns `{ workspaceId, role }` for a user who IS a member — `role`
 *      read from the `memberships` row (`owner` for the workspace creator).
 *   2. Throws `UnauthorizedError` when `userId` is an empty string (or not a
 *      non-empty string) — the "who you are" failure mode (401).
 *   3. Throws `ForbiddenError` when `workspaceId` is NOT a well-formed UUID,
 *      WITHOUT depending on any DB row existing — a malformed value can never
 *      match a real workspace and must never reach the DB query (where `pg`
 *      would raise a raw driver error instead of a clean `AppError`).
 *   4. Throws `ForbiddenError` when the user is a valid, authenticated user
 *      but NOT a member of the (well-formed, possibly non-existent)
 *      workspace — the "what you can access" failure mode (403).
 *
 * RED STATE (expected, today): `./workspace-membership.service.ts` does not
 * exist yet, so this file fails at import/module-resolution time. Once the
 * implementer lands the service, every `it` below must pass unchanged.
 *
 * Harness mirrors `./workspaces.integration.test.ts` exactly (same
 * Testcontainers Postgres 16 + Redis 7 pair, same dynamic
 * `import('../app.module.js')` AFTER `DATABASE_URL`/`REDIS_URL` are set). The
 * user + workspace + owner-membership row are seeded through the same HTTP
 * register/create flow that file uses (`createWorkspace` always makes the
 * creator an `owner`); the service under test is then resolved directly from
 * the Nest container and exercised OUTSIDE any HTTP request context.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';
const WELL_FORMED_UUID = '00000000-0000-4000-8000-000000000000';

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface UserEnvelope {
  user: { id: string; email: string };
}

/** See `./workspaces.integration.test.ts` for the full rationale behind this
 * exact helper (copied verbatim, per this task's instructions). */
function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

/** Generates a fresh, never-reused email per call so tests can register
 * independent users without colliding on the `email` unique constraint. */
function freshEmail(): string {
  emailCounter += 1;
  return `membership-service-test-user-${String(emailCounter)}@example.com`;
}

describe('WorkspaceMembershipService.assertMembership (real Postgres, via Testcontainers; behavior-preserving extraction of WorkspaceMembershipGuard)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let service: WorkspaceMembershipService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    redisContainer = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();

    await runMigrations(container.getConnectionUri());

    // Imported only after DATABASE_URL/REDIS_URL are set, per
    // `workspaces.integration.test.ts`'s established convention.
    const { AppModule } = await import('../app.module.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    server = app.getHttpServer() as Server;
    service = app.get(WorkspaceMembershipService);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await container.stop();
    await redisContainer.stop();
  }, 60_000);

  /** Registers a brand-new user and returns their session cookie + id. */
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

  /** Creates a workspace as the given (cookie-authenticated) user and
   * returns its id. The creator is always `owner`. */
  async function createWorkspace(cookie: string, name: string): Promise<string> {
    const response = await request(server).post('/workspaces').set('Cookie', cookie).send({ name });

    expect(response.status).toBe(201);
    return (response.body as WorkspaceEnvelope).workspace.id;
  }

  /** Registers a fresh user + a fresh workspace they own (role: `owner`), in
   * one call — the seeded (userId, workspaceId, `owner` membership) triple. */
  async function registerOwnerWithWorkspace(): Promise<{
    userId: string;
    workspaceId: string;
  }> {
    const { cookie, userId } = await registerUser();
    const workspaceId = await createWorkspace(cookie, `Workspace ${String(emailCounter)}`);
    return { userId, workspaceId };
  }

  // Case 1
  it('returns { workspaceId, role } for a seeded member (role from the memberships row)', async () => {
    const { userId, workspaceId } = await registerOwnerWithWorkspace();

    const membership = await service.assertMembership(userId, workspaceId);

    expect(membership.workspaceId).toBe(workspaceId);
    expect(membership.role).toBe('owner');
  });

  // Case 2
  it('throws UnauthorizedError for an empty-string userId (well-formed workspaceId)', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();

    await expect(service.assertMembership('', workspaceId)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  // Case 3
  it('throws ForbiddenError for a malformed workspaceId, WITHOUT depending on any DB row', async () => {
    const { userId } = await registerOwnerWithWorkspace();

    // A valid, authenticated user + a malformed (non-UUID) workspaceId: the
    // rejection must come from the shape check, before any DB query — so no
    // workspace/membership row is seeded for this id at all.
    await expect(service.assertMembership(userId, 'not-a-uuid')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  // Case 4
  it('throws ForbiddenError for a valid userId + well-formed workspaceId the user is NOT a member of', async () => {
    const { userId } = await registerOwnerWithWorkspace();

    // Another user's workspace — well-formed, real, but the first user holds
    // no membership row for it: authenticated, not a member (403).
    const other = await registerOwnerWithWorkspace();
    expect(other.workspaceId).not.toBe(userId);

    await expect(service.assertMembership(userId, other.workspaceId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    // A well-formed UUID mapping to no workspace at all resolves the same way.
    await expect(service.assertMembership(userId, WELL_FORMED_UUID)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
