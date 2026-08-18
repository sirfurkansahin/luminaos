import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deriveDeterministicUuid } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { memberships } from '../db/schema/memberships.js';
import { memoryAccessPolicies } from '../db/schema/memory-access-policies.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { StoredEvent } from '../event-store/event-store.service.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T8 (RED step) — Memory Access Policy: grant/revoke, per-(workspace,
 * user, agentIdentifier) ajan erişim manifestoları (ADR-0024 Karar (f)-(l),
 * `docs/adr/ADR-0024-bellek-kullanim-politikasi.md`). This is a near-1:1
 * structural mirror of `../context/desktop-signal-consents.integration
 * .test.ts` (`signalType` -> `agentIdentifier`), with an added
 * cross-user/cross-workspace isolation test mirroring
 * `memory-records.integration.test.ts`'s own convention (`addMemberWithRole`),
 * plus a test for §k's DELIBERATE difference from
 * `MemoryRecordsService.list`: `GET /` here returns BOTH active and revoked
 * rows, unfiltered.
 *
 * `packages/memory` (F2-T8, sibling PR/commit) exports `MemoryAccessPolicy`
 * and two `.strict()` zod payload schemas
 * (`memoryAccessGrantedPayloadSchema`/`memoryAccessRevokedPayloadSchema`,
 * both `{agentIdentifier}`) — this file consumes them at the HTTP/DB layer,
 * it does not redefine them.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * A. `db/schema/memory-access-policies.ts` (new) — `memory_access_policies`
 *    table, exported as `memoryAccessPolicies`: `id` varchar(26) PK (ULID),
 *    `workspaceId` uuid NOT NULL FK -> `workspaces.id` (cascade), `userId`
 *    uuid NOT NULL FK -> `users.id` (cascade), `agentIdentifier`
 *    varchar(100) NOT NULL, `grantedAt` timestamptz NOT NULL, `revokedAt`
 *    timestamptz NULLABLE. UNIQUE(workspaceId, userId, agentIdentifier).
 *    Plus a migration (up+down, CLAUDE.md). ADR-0024 §i.
 *
 * B. `memory/memory-access-policy.projection.ts` (new) —
 *    `MemoryAccessPolicyProjection implements Projection`: `handles =
 *    ['MemoryAccessGranted', 'MemoryAccessRevoked']`.
 *      - `Granted` -> `insert(...).onConflictDoUpdate({ target:
 *        [workspaceId, userId, agentIdentifier], set: { grantedAt:
 *        event.occurredAt, revokedAt: null } })` — re-grant resets
 *        `revokedAt` to null (test #4). ADR-0024 §j.
 *      - `Revoked` -> `update(...).set({ revokedAt: event.occurredAt
 *        }).where(...)` matched on (workspaceId, userId, agentIdentifier) —
 *        NO physical `DELETE`.
 *      - `reset(tx)` truncates its own table — used by test #9's
 *        `projectionRunner.rebuild`.
 *
 * C. `memory/memory-access-policies.service.ts` (new) —
 *    `@Injectable() MemoryAccessPolicyService`:
 *      - A FIXED namespace constant,
 *        `MEMORY_ACCESS_POLICY_UUID_NAMESPACE =
 *        'c3a9e412-6c8b-4b91-9dfa-91a2b3c4d5e7'` (see the identical literal
 *        pinned below as this test file's OWN constant of the same name) —
 *        MUST NEVER change once real data exists. Test #10 independently
 *        re-derives the expected `streamId` via `deriveDeterministicUuid`
 *        (already-shipped, stable code in `@luminaos/shared`).
 *      - `streamIdFor(workspaceId, userId, agentIdentifier) =
 *        deriveDeterministicUuid(MEMORY_ACCESS_POLICY_UUID_NAMESPACE,
 *        `${workspaceId}:${userId}:${agentIdentifier}`)`.
 *      - `grant(workspaceId, userId, agentIdentifier)`: reads the prior
 *        stream, appends `MemoryAccessGranted {agentIdentifier}` (actor
 *        `{type:'user', id:userId}`), SYNCHRONOUSLY
 *        `projectionRunner.catchUp(this.projection)`, returns the read-back
 *        row.
 *      - `revoke(workspaceId, userId, agentIdentifier)`: same shape,
 *        appends `MemoryAccessRevoked {agentIdentifier}`.
 *      - `list(workspaceId, userId)`: ALL rows for (workspaceId, userId),
 *        UNFILTERED by `revokedAt` (ADR-0024 §k — deliberately different
 *        from `MemoryRecordsService.list`).
 *
 * D. `memory/memory-access-policies.controller.ts` (new) — `@Controller(
 *    'workspaces/:workspaceId/memory/access-policies')`,
 *    `@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)` on all three
 *    routes, identity ALWAYS `req.user.id`:
 *      - `@Get()` -> `service.list(workspaceId, req.user.id)`, 200,
 *        `{policies: MemoryAccessPolicy[]}`.
 *      - `@Post()` body `{agentIdentifier}` (zod-validated, NOT `.strict()`
 *        — a `userId` key, if present, is silently ignored) ->
 *        `service.grant(workspaceId, req.user.id, body.agentIdentifier)`,
 *        201, `{policy: MemoryAccessPolicy}`.
 *      - `@Delete(':agentIdentifier')` -> `service.revoke(workspaceId,
 *        req.user.id, params.agentIdentifier)`, 200, `{policy:
 *        MemoryAccessPolicy}`.
 *
 * E. `memory/dto/memory-access-policy-agent-identifier.schema.ts` (new) —
 *    zod `{agentIdentifier: z.string().min(1)}` — NOT `.strict()`.
 *
 * F. `memory/memory.module.ts` (existing, updated) — new
 *    `MemoryAccessPolicyController`/`MemoryAccessPolicyService` added as
 *    provider/controller to the EXISTING `MemoryModule` (no new Nest
 *    module).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): this file fails at MODULE RESOLUTION time
 * (before any HTTP call runs) because `../db/schema/memory-access-policies.js`
 * does not exist yet. Once that schema/migration exists but the
 * controller/service/projection do not, EVERY route this file hits
 * (`/workspaces/:workspaceId/memory/access-policies...`) 404s as an
 * unmatched route (Nest's default 404) — including the
 * unauthenticated/non-member cases (test #7) which expect 401/403 but will
 * actually see 404, and the empty-agentIdentifier case (test #11) which
 * expects 400 but will also see 404.
 * ============================================================================
 */

/**
 * MUST match `MEMORY_ACCESS_POLICY_UUID_NAMESPACE` in
 * `memory/memory-access-policies.service.ts` exactly (§C above) — pinned
 * here as the literal contract value.
 */
const MEMORY_ACCESS_POLICY_UUID_NAMESPACE = 'c3a9e412-6c8b-4b91-9dfa-91a2b3c4d5e7';

interface PolicyBody {
  id: string;
  workspaceId: string;
  userId: string;
  agentIdentifier: string;
  grantedAt: string;
  revokedAt: string | null;
}

interface PolicyEnvelope {
  policy: PolicyBody;
}

interface PoliciesListEnvelope {
  policies: PolicyBody[];
}

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
  return `memory-access-policy-test-user-${String(emailCounter)}@example.com`;
}

const PASSWORD = 'correct-horse-battery-staple';

describe('F2-T8 (RED step): MemoryAccessPolicyService/Controller/Projection — event-sourced, self-service, per-(workspace,user,agentIdentifier) grant/revoke (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;

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
      `Memory access policy test workspace ${String(emailCounter)}`,
    );
    return { cookie, userId, workspaceId };
  }

  /** Registers a brand-new user and inserts a `memberships` row for them in
   * `workspaceId` DIRECTLY via the raw DB connection (no HTTP invite
   * endpoint exists in this codebase yet — mirrors
   * `memory-records.integration.test.ts`'s `addMemberWithRole` convention
   * exactly). Returns their session cookie and userId. */
  async function addMemberWithRole(
    workspaceId: string,
    role: 'admin' | 'member' | 'guest',
  ): Promise<{ cookie: string; userId: string }> {
    const { cookie, userId } = await registerUser();
    await rawDb.insert(memberships).values({ workspaceId, userId, role });
    return { cookie, userId };
  }

  function accessPoliciesUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/memory/access-policies`;
  }

  async function grant(
    cookie: string,
    workspaceId: string,
    body: { agentIdentifier: string; userId?: string },
  ): Promise<request.Response> {
    return request(server).post(accessPoliciesUrl(workspaceId)).set('Cookie', cookie).send(body);
  }

  async function revoke(
    cookie: string,
    workspaceId: string,
    agentIdentifier: string,
  ): Promise<request.Response> {
    return request(server)
      .delete(`${accessPoliciesUrl(workspaceId)}/${agentIdentifier}`)
      .set('Cookie', cookie);
  }

  async function listPolicies(cookie: string, workspaceId: string): Promise<request.Response> {
    return request(server).get(accessPoliciesUrl(workspaceId)).set('Cookie', cookie);
  }

  it('1. POST {agentIdentifier:"answer-question"} -> 201, response has grantedAt filled and revokedAt null', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await grant(cookie, workspaceId, { agentIdentifier: 'answer-question' });

    expect(response.status).toBe(201);
    const body = (response.body as PolicyEnvelope).policy;
    expect(body.agentIdentifier).toBe('answer-question');
    expect(body.grantedAt).toBeDefined();
    expect(body.revokedAt).toBeNull();
  });

  it('2. re-POST the same agentIdentifier (re-grant) -> idempotent, upserted not duplicated, grantedAt is updated', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const first = await grant(cookie, workspaceId, { agentIdentifier: 'answer-question' });
    expect(first.status).toBe(201);
    const firstGrantedAt = (first.body as PolicyEnvelope).policy.grantedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await grant(cookie, workspaceId, { agentIdentifier: 'answer-question' });
    expect(second.status).toBe(201);
    const secondBody = (second.body as PolicyEnvelope).policy;
    expect(secondBody.agentIdentifier).toBe('answer-question');
    expect(secondBody.grantedAt).toBeDefined();
    expect(secondBody.grantedAt).not.toBe(firstGrantedAt);
    expect(secondBody.revokedAt).toBeNull();

    const rows = await rawDb
      .select()
      .from(memoryAccessPolicies)
      .where(
        and(
          eq(memoryAccessPolicies.workspaceId, workspaceId),
          eq(memoryAccessPolicies.agentIdentifier, 'answer-question'),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it('3. DELETE :agentIdentifier -> response is the revoked policy, with revokedAt filled (ADR-0024 §k pins the DELETE response shape directly)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await grant(cookie, workspaceId, { agentIdentifier: 'answer-question' });

    const revokeResponse = await revoke(cookie, workspaceId, 'answer-question');
    expect(revokeResponse.status).toBe(200);
    const body = (revokeResponse.body as PolicyEnvelope).policy;
    expect(body.agentIdentifier).toBe('answer-question');
    expect(body.revokedAt).toBeDefined();
    expect(body.revokedAt).not.toBeNull();
  });

  it('4. revoke then re-grant -> revokedAt resets back to null ("yeniden-grant revokedAt\'ı sıfırlar", ADR-0024 §j)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await grant(cookie, workspaceId, { agentIdentifier: 'parse-command' });
    await revoke(cookie, workspaceId, 'parse-command');

    const reGrant = await grant(cookie, workspaceId, { agentIdentifier: 'parse-command' });
    expect(reGrant.status).toBe(201);
    expect((reGrant.body as PolicyEnvelope).policy.revokedAt).toBeNull();

    const listResponse = await listPolicies(cookie, workspaceId);
    expect(listResponse.status).toBe(200);
    const policy = (listResponse.body as PoliciesListEnvelope).policies.find(
      (p) => p.agentIdentifier === 'parse-command',
    );
    expect(policy?.revokedAt).toBeNull();
  });

  it('5. self-service by construction: a fake userId in the POST body is IGNORED — the policy is always recorded for the SESSION user (req.user.id), never the body value', async () => {
    const {
      cookie: sessionCookie,
      userId: sessionUserId,
      workspaceId,
    } = await registerOwnerWithWorkspace();
    const { userId: otherUserId } = await registerUser();

    const response = await grant(sessionCookie, workspaceId, {
      agentIdentifier: 'answer-question',
      userId: otherUserId,
    });

    expect(response.status).toBe(201);

    // Raw DB proof: the persisted row's userId is the SESSION user's, never
    // the attacker-supplied body value.
    const rows = await rawDb
      .select()
      .from(memoryAccessPolicies)
      .where(
        and(
          eq(memoryAccessPolicies.workspaceId, workspaceId),
          eq(memoryAccessPolicies.agentIdentifier, 'answer-question'),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(sessionUserId);
    expect(rows[0]?.userId).not.toBe(otherUserId);
  });

  it('6. agentIdentifier independence: granting "answer-question" does not also grant "parse-command" for the same user; GET reflects each independently', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await grant(cookie, workspaceId, { agentIdentifier: 'answer-question' });

    const listResponse = await listPolicies(cookie, workspaceId);
    expect(listResponse.status).toBe(200);
    const policies = (listResponse.body as PoliciesListEnvelope).policies;

    const answerQuestion = policies.find((p) => p.agentIdentifier === 'answer-question');
    expect(answerQuestion).toBeDefined();
    expect(answerQuestion?.revokedAt).toBeNull();

    const parseCommand = policies.find((p) => p.agentIdentifier === 'parse-command');
    expect(parseCommand).toBeUndefined();
  });

  it('7. unauthenticated -> 401; authenticated non-member -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const { cookie: outsiderCookie } = await registerUser();

    const unauthPost = await request(server)
      .post(accessPoliciesUrl(workspaceId))
      .send({ agentIdentifier: 'answer-question' });
    expect(unauthPost.status).toBe(401);

    const unauthGet = await request(server).get(accessPoliciesUrl(workspaceId));
    expect(unauthGet.status).toBe(401);

    const unauthDelete = await request(server).delete(
      `${accessPoliciesUrl(workspaceId)}/answer-question`,
    );
    expect(unauthDelete.status).toBe(401);

    const nonMemberPost = await grant(outsiderCookie, workspaceId, {
      agentIdentifier: 'answer-question',
    });
    expect(nonMemberPost.status).toBe(403);

    const nonMemberGet = await listPolicies(outsiderCookie, workspaceId);
    expect(nonMemberGet.status).toBe(403);
  });

  it('8. UNIQUE(workspaceId, userId, agentIdentifier): repeated grants/revokes never duplicate the row (onConflictDoUpdate upserts in place)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await grant(cookie, workspaceId, { agentIdentifier: 'answer-question' });
    await grant(cookie, workspaceId, { agentIdentifier: 'answer-question' });
    await revoke(cookie, workspaceId, 'answer-question');
    await grant(cookie, workspaceId, { agentIdentifier: 'answer-question' });

    const rows = await rawDb
      .select()
      .from(memoryAccessPolicies)
      .where(
        and(
          eq(memoryAccessPolicies.workspaceId, workspaceId),
          eq(memoryAccessPolicies.agentIdentifier, 'answer-question'),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBeNull();
  });

  it('9. rebuild-determinism (F0-T6 AC4): after several grant/revoke events, projectionRunner.rebuild reproduces the exact same grantedAt/revokedAt state', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await grant(cookie, workspaceId, { agentIdentifier: 'answer-question' });
    await revoke(cookie, workspaceId, 'answer-question');
    await grant(cookie, workspaceId, { agentIdentifier: 'answer-question' });
    await grant(cookie, workspaceId, { agentIdentifier: 'parse-command' });
    await revoke(cookie, workspaceId, 'parse-command');

    const snapshot = async (): Promise<
      { userId: string; agentIdentifier: string; grantedAt: string; revokedAt: string | null }[]
    > => {
      const rows = await rawDb
        .select()
        .from(memoryAccessPolicies)
        .where(eq(memoryAccessPolicies.workspaceId, workspaceId));

      return rows
        .map((row) => ({
          userId: row.userId,
          agentIdentifier: row.agentIdentifier,
          grantedAt: row.grantedAt.toISOString(),
          revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
        }))
        .sort((a, b) => a.agentIdentifier.localeCompare(b.agentIdentifier));
    };

    const beforeRebuild = await snapshot();

    const { MemoryAccessPolicyProjection } = await import('./memory-access-policy.projection.js');
    await projectionRunner.rebuild(new MemoryAccessPolicyProjection());

    const afterRebuild = await snapshot();

    expect(afterRebuild).toEqual(beforeRebuild);
  });

  it('10. event-log visibility: grant/revoke append MemoryAccessGranted/MemoryAccessRevoked to the deterministic per-(workspace,user,agentIdentifier) stream', async () => {
    const { cookie, userId, workspaceId } = await registerOwnerWithWorkspace();

    await grant(cookie, workspaceId, { agentIdentifier: 'answer-question' });

    const expectedStreamId = deriveDeterministicUuid(
      MEMORY_ACCESS_POLICY_UUID_NAMESPACE,
      `${workspaceId}:${userId}:answer-question`,
    );

    let streamEvents: StoredEvent[] = await eventStore.readStream(expectedStreamId);
    expect(streamEvents).toHaveLength(1);
    expect(streamEvents[0]?.type).toBe('MemoryAccessGranted');
    expect(streamEvents[0]?.payload['agentIdentifier']).toBe('answer-question');

    await revoke(cookie, workspaceId, 'answer-question');

    streamEvents = await eventStore.readStream(expectedStreamId);
    expect(streamEvents).toHaveLength(2);
    expect(streamEvents[1]?.type).toBe('MemoryAccessRevoked');
    expect(streamEvents[1]?.payload['agentIdentifier']).toBe('answer-question');
  });

  it('11. empty-string agentIdentifier in the POST body -> 400 (zod .min(1) rejection)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await grant(cookie, workspaceId, { agentIdentifier: '' });

    expect(response.status).toBe(400);
  });

  it("12. GET / returns BOTH active and revoked policies, unfiltered (ADR-0024 §k, deliberately DIFFERENT from MemoryRecordsService.list's deletedAt-IS-NULL filtering)", async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await grant(cookie, workspaceId, { agentIdentifier: 'answer-question' });
    await grant(cookie, workspaceId, { agentIdentifier: 'parse-command' });
    await revoke(cookie, workspaceId, 'parse-command');

    const response = await listPolicies(cookie, workspaceId);
    expect(response.status).toBe(200);
    const policies = (response.body as PoliciesListEnvelope).policies;

    const active = policies.find((p) => p.agentIdentifier === 'answer-question');
    expect(active).toBeDefined();
    expect(active?.revokedAt).toBeNull();

    const revoked = policies.find((p) => p.agentIdentifier === 'parse-command');
    expect(revoked).toBeDefined();
    expect(revoked?.revokedAt).not.toBeNull();
  });

  it("13. cross-user isolation (same workspace): a DIFFERENT member's GET / never lists another user's access policies", async () => {
    const { cookie: ownerCookie, workspaceId } = await registerOwnerWithWorkspace();
    const { cookie: otherCookie } = await addMemberWithRole(workspaceId, 'member');

    await grant(ownerCookie, workspaceId, { agentIdentifier: 'answer-question' });

    const response = await listPolicies(otherCookie, workspaceId);
    expect(response.status).toBe(200);
    const policies = (response.body as PoliciesListEnvelope).policies;
    expect(policies.map((p) => p.agentIdentifier)).not.toContain('answer-question');
  });

  it("14. cross-workspace isolation: a policy granted in workspace A never appears in workspace B's GET /, even for a member of B", async () => {
    const { cookie: cookieA, workspaceId: workspaceIdA } = await registerOwnerWithWorkspace();
    const { cookie: cookieB, workspaceId: workspaceIdB } = await registerOwnerWithWorkspace();

    await grant(cookieA, workspaceIdA, { agentIdentifier: 'answer-question' });

    const listInB = await listPolicies(cookieB, workspaceIdB);
    expect(listInB.status).toBe(200);
    const policiesInB = (listInB.body as PoliciesListEnvelope).policies;
    expect(policiesInB.map((p) => p.agentIdentifier)).not.toContain('answer-question');
  });
});
