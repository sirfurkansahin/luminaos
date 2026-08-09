import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';

import { WorkspaceMembershipService } from './workspace-membership.service.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';
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
  // F1-T16 PR3 (RED) addition: a raw Drizzle client, independent of Nest's
  // injected one, used only by this file's `assertAllMembers` fixtures to
  // seed an EXTRA (non-owner) membership row directly — there is no
  // HTTP/service path today for "add an existing user as a member of
  // someone else's workspace", so direct-insert is the same convention
  // already established by `object-query.integration.test.ts`'s own
  // `addMemberWithRole` helper (search `rawDb.insert(memberships)`).
  let rawDb: Database;

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
    rawDb = createDatabaseClient(container.getConnectionUri());
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await rawDb.$client.end();
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

  /** F1-T16 PR3 (RED) addition: registers a brand-new user and directly
   * inserts a `memberships` row making them a member of `workspaceId` with
   * `role` — used only by `assertAllMembers` fixtures below, which need
   * MULTIPLE distinct members of the SAME workspace (something no existing
   * HTTP route in this codebase supports yet, so a direct insert via
   * `rawDb` is used, mirroring `object-query.integration.test.ts`'s own
   * `addMemberWithRole` convention). Returns the new member's userId. */
  async function addExistingUserAsMember(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<string> {
    const { userId } = await registerUser();
    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return userId;
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

  /**
   * ---------------------------------------------------------------------------
   * F1-T16 PR3 (RED): `assertAllMembers`, a NEW bulk-membership-check method
   * needed by a later PR (F1-T16 PR5's `assignPeople` action execution) to
   * validate every person a command proposes assigning is actually a member
   * of the workspace, before writing a `people`-typed field value.
   *
   * CONTRACT PINNED BY THIS BLOCK (implementer must match precisely):
   *
   *   assertAllMembers(workspaceId: string, userIds: string[]): Promise<void>
   *
   *   1. Resolves without throwing when every `userIds` entry is a member of
   *      `workspaceId`.
   *   2. Throws `ForbiddenError` (same class `assertMembership` throws for
   *      "not a member" — no new error type) when AT LEAST ONE `userIds`
   *      entry is not a member of `workspaceId`.
   *   3. Resolves without throwing for an empty `userIds` array — nothing to
   *      validate.
   *   4. Duplicate entries in `userIds` (the same member listed twice) must
   *      NOT cause a false failure.
   *   5. Throws `ForbiddenError` for a malformed (non-UUID) `workspaceId`,
   *      mirroring `assertMembership`'s own "malformed value can never match
   *      a real workspace" guard (see this file's top-of-class comment) —
   *      this must hold even when `userIds` is otherwise valid.
   *
   * RED STATE (expected, today): `WorkspaceMembershipService` has no
   * `assertAllMembers` method, so every `it` below fails with `TypeError:
   * service.assertAllMembers is not a function` — the right reason, per this
   * file's own established RED-state precedent for `assertMembership` above.
   * Once the implementer lands the method, every `it` below must pass
   * unchanged.
   *
   * NOT separately tested here (deliberate, see PR3 task notes): a
   * dedicated "single query, not N queries" efficiency assertion. A
   * call-count spy on the injected `db` client would couple this black-box
   * behavioral suite to an implementation detail; test 2 (partial
   * membership correctly rejected) and test 4 (duplicates don't
   * double-count) already fully pin the OBSERVABLE behavior any correct
   * single-query or looped implementation must satisfy — efficiency itself
   * is a non-functional concern better left to code review.
   * ---------------------------------------------------------------------------
   */
  describe('WorkspaceMembershipService.assertAllMembers (F1-T16 PR3, RED — new bulk-membership-check method)', () => {
    // Case 1
    it('resolves without throwing when every provided userId is a member of the workspace', async () => {
      const { userId: ownerId, workspaceId } = await registerOwnerWithWorkspace();
      const memberId = await addExistingUserAsMember(workspaceId, 'member');

      await expect(
        service.assertAllMembers(workspaceId, [ownerId, memberId]),
      ).resolves.toBeUndefined();
    });

    // Case 2
    it('throws ForbiddenError when at least one provided userId is NOT a member of the workspace', async () => {
      const { userId: ownerId, workspaceId } = await registerOwnerWithWorkspace();
      const { userId: outsiderId } = await registerUser();

      await expect(
        service.assertAllMembers(workspaceId, [ownerId, outsiderId]),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    // Case 3
    it('resolves without throwing for an empty userIds array (nothing to validate)', async () => {
      const { workspaceId } = await registerOwnerWithWorkspace();

      await expect(service.assertAllMembers(workspaceId, [])).resolves.toBeUndefined();
    });

    // Case 4
    it('resolves without throwing when a member userId is duplicated in the input array', async () => {
      const { userId: ownerId, workspaceId } = await registerOwnerWithWorkspace();

      await expect(
        service.assertAllMembers(workspaceId, [ownerId, ownerId]),
      ).resolves.toBeUndefined();
    });

    // Case 5
    it('throws ForbiddenError for a malformed (non-UUID) workspaceId, even with otherwise-valid userIds', async () => {
      const { userId: ownerId } = await registerOwnerWithWorkspace();

      await expect(service.assertAllMembers('not-a-uuid', [ownerId])).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });
});
