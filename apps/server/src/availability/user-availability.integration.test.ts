import { createHash } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { EventStoreService } from '../event-store/event-store.service.js';

import type { Database } from '../db/client.js';
import type { StoredEvent } from '../event-store/event-store.service.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F1-T12 PR6 (RED step) — `UserAvailability`, a NON-LuminaObject,
 * event-sourced, GLOBAL-PER-USER aggregate for Odak/OOO (Focus/Out-of-office)
 * status, per ADR-0012 §f (`docs/adr/ADR-0012-takvim-senkron.md`). Mirrors
 * `../calendar/calendar-accounts.integration.test.ts`'s Testcontainers
 * harness (Postgres 16 + Redis 7, `runMigrations`, dynamic
 * `import('../app.module.js')` AFTER env vars are set, `Test.createTestingModule`,
 * supertest) — this feature needs NO new env var (unlike calendar's
 * `ENCRYPTION_KEY`), so only `DATABASE_URL`/`REDIS_URL` are set, matching the
 * baseline convention every other integration test file in this repo follows.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * A. `packages/shared/src/ids/deterministic-uuid.ts` (new, sibling PR6 test
 *    file `packages/shared/src/ids/deterministic-uuid.test.ts` pins its exact
 *    RFC4122 UUIDv5 contract) — `deriveDeterministicUuid(namespace, name): string`.
 *
 * B. `db/schema/user-availability.ts` (new) — `user_availability` table:
 *    `userId` (uuid, PK, FK -> `users.id`, cascade), `status` (varchar(20):
 *    'available'|'focus'|'ooo'), `until` (timestamptz, nullable), `updatedAt`
 *    (timestamptz, `defaultNow()`). Plus migration (up+down, CLAUDE.md).
 *
 * C. `availability/user-availability.projection.ts` (new) —
 *    `UserAvailabilityProjection implements Projection`: `name =
 *    'user-availability'`, `handles = ['UserAvailabilityChanged']`. LAST-
 *    WRITE-WINS upsert keyed on `userId` (mirrors `AIUsageProjection`'s
 *    structure, NOT its append-only semantics).
 *
 * D. `availability/user-availability.service.ts` (new) —
 *    `@Injectable() UserAvailabilityService`:
 *      - `USER_AVAILABILITY_STREAM_TYPE = 'user-availability'`.
 *      - A FIXED namespace constant, `USER_AVAILABILITY_UUID_NAMESPACE =
 *        '9c858b3e-6c1d-4c9a-9f0a-9a6c8b0c9e3a'` — MUST NEVER change once
 *        real data exists (changing it silently opens a new stream / loses
 *        the old one's continuity). This exact value is pinned by this test
 *        file (see `USER_AVAILABILITY_UUID_NAMESPACE` below, and the
 *        independent local UUIDv5 re-derivation in test #5).
 *      - `streamIdFor(userId) = deriveDeterministicUuid(USER_AVAILABILITY_UUID_NAMESPACE, userId)`
 *        — DETERMINISTIC, per-user, NOT per-workspace (deviates from
 *        `recordAIUsage`'s throwaway-random-per-record `streamId`, since this
 *        aggregate is genuinely re-opened — replay + append — every time a
 *        user changes status).
 *      - `setStatus(userId, workspaceId, status, until?)`: reads the prior
 *        stream, appends `UserAvailabilityChanged {userId, status, until?}`
 *        at `priorEvents.length`, catches up the projection, returns current
 *        state. `workspaceId` on the event envelope is AUDIT-TRAIL ONLY (the
 *        caller's workspace context) — NOT a scoping key; the persisted state
 *        is keyed by `userId` alone (test #4 below is the proof).
 *      - `get(userId)`: reads `user_availability` by `userId`; `null` if no
 *        row exists.
 *
 * E. `availability/dto/set-availability.schema.ts` (new) — zod
 *    `{status: z.enum(['available','focus','ooo']), until: z.iso.datetime().optional()}.strict()`.
 *
 * F. `availability/availability.controller.ts` (new) — `@Controller(
 *    'workspaces/:workspaceId/availability')`, `@UseGuards(SessionAuthGuard,
 *    WorkspaceMembershipGuard)` on both routes:
 *      - `@Put()` -> `service.setStatus(req.user.id, workspaceId, ...)`, 200,
 *        `{ availability: {status, until?, updatedAt} }`.
 *      - `@Get()` -> `service.get(req.user.id)`; `{ availability: null }`
 *        (200, NOT 404) when the user has never set a status — "never set"
 *        is a valid, common state.
 *
 * G. `availability/availability.module.ts` (new), wired into
 *    `app.module.ts`'s `imports` array.
 *
 * GLOBAL-PER-USER SEMANTICS PINNED THROUGHOUT: the `:workspaceId` in the URL
 * is ONLY a membership-authorization scope (via `WorkspaceMembershipGuard`)
 * and an audit-trail value on the recorded event — it is NEVER used to
 * partition the persisted `user_availability` state itself, which is keyed
 * by `userId` alone. Test #4 is the direct proof: the SAME user sets status
 * via workspace A and reads it back, unchanged, via workspace B.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `AvailabilityModule` does not exist and is not
 * imported into `AppModule`, so EVERY route this file hits
 * (`/workspaces/:workspaceId/availability`) 404s as an unmatched route
 * (Nest's default "Cannot PUT/GET ..." 404) — including the
 * unauthenticated/non-member cases (test #6) which expect 401/403 but will
 * actually also see 404 today (no route to even apply guards to), and the
 * invalid-enum case (test #7) which expects 400 but will also see 404 (no
 * `ZodValidationPipe` to reject the body yet). This is expected and will
 * resolve to the real status codes once `AvailabilityModule` and its guards
 * exist. Test #5 fails differently even once routes exist but before the
 * projection/event-store wiring is correct: it directly asserts against
 * `eventStore.readStream(...)`, independent of the HTTP layer.
 * ============================================================================
 */

/**
 * MUST match `USER_AVAILABILITY_UUID_NAMESPACE` in
 * `availability/user-availability.service.ts` exactly (§D above) — pinned
 * here as the literal contract value, not imported, so this file's red state
 * does not depend on `packages/shared`'s (also not-yet-built) `ids` barrel
 * being rebuilt first.
 */
const USER_AVAILABILITY_UUID_NAMESPACE = '9c858b3e-6c1d-4c9a-9f0a-9a6c8b0c9e3a';

/**
 * Independent, LOCAL re-implementation of RFC 4122 UUIDv5, deliberately
 * NOT importing `deriveDeterministicUuid` from `@luminaos/shared` (which, per
 * §A above, does not exist yet either, AND — even once it does — would
 * couple this assertion to the very implementation under test, making the
 * check tautological). This duplicate is small, self-contained, and only
 * used to compute the EXPECTED `streamId` for test #5's direct event-log
 * assertion; correctness of the real `deriveDeterministicUuid` helper itself
 * is separately, exhaustively pinned by
 * `packages/shared/src/ids/deterministic-uuid.test.ts` (RFC4122/Python
 * test vectors).
 */
function uuidV5(namespace: string, name: string): string {
  const namespaceHex = namespace.replace(/-/g, '');
  const namespaceBytes = Buffer.from(namespaceHex, 'hex');
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, nameBytes]))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

interface AvailabilityBody {
  status: string;
  until?: string;
  updatedAt: string;
}

interface AvailabilityEnvelope {
  availability: AvailabilityBody | null;
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
  return `user-availability-test-user-${String(emailCounter)}@example.com`;
}

const PASSWORD = 'correct-horse-battery-staple';

describe('F1-T12 PR6 (RED step): UserAvailability — event-sourced, global-per-user Odak/OOO status (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let rawDb: Database;
  let eventStore: EventStoreService;

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

  async function registerOwnerWithWorkspace(): Promise<{
    cookie: string;
    userId: string;
    workspaceId: string;
  }> {
    const { cookie, userId } = await registerUser();
    const workspaceId = await createWorkspace(
      cookie,
      `Availability test workspace ${String(emailCounter)}`,
    );
    return { cookie, userId, workspaceId };
  }

  function availabilityUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/availability`;
  }

  async function putStatus(
    cookie: string,
    workspaceId: string,
    body: { status: string; until?: string },
  ): Promise<request.Response> {
    return request(server).put(availabilityUrl(workspaceId)).set('Cookie', cookie).send(body);
  }

  async function getStatus(cookie: string, workspaceId: string): Promise<request.Response> {
    return request(server).get(availabilityUrl(workspaceId)).set('Cookie', cookie);
  }

  it('1. PUT {status: "focus", until} -> 200, returns {status,until,updatedAt}; subsequent GET reflects the same values', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const until = new Date(Date.now() + 3_600_000).toISOString();

    const putResponse = await putStatus(cookie, workspaceId, { status: 'focus', until });
    expect(putResponse.status).toBe(200);
    const putBody = (putResponse.body as AvailabilityEnvelope).availability;
    expect(putBody?.status).toBe('focus');
    expect(putBody?.until).toBe(until);
    expect(putBody?.updatedAt).toBeDefined();

    const getResponse = await getStatus(cookie, workspaceId);
    expect(getResponse.status).toBe(200);
    const getBody = (getResponse.body as AvailabilityEnvelope).availability;
    expect(getBody?.status).toBe('focus');
    expect(getBody?.until).toBe(until);
  });

  it('2. overwrite (last-write-wins): set "focus" with an until, then set "ooo" with no until -> GET reflects "ooo" with until ABSENT (not stale)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const until = new Date(Date.now() + 3_600_000).toISOString();

    await putStatus(cookie, workspaceId, { status: 'focus', until });
    const secondPut = await putStatus(cookie, workspaceId, { status: 'ooo' });
    expect(secondPut.status).toBe(200);

    const getResponse = await getStatus(cookie, workspaceId);
    expect(getResponse.status).toBe(200);
    const body = (getResponse.body as AvailabilityEnvelope).availability;
    expect(body?.status).toBe('ooo');
    expect(body?.until).toBeUndefined();
  });

  it('3. a FRESH user (never set a status) -> GET returns 200, {availability: null}', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await getStatus(cookie, workspaceId);

    expect(response.status).toBe(200);
    expect((response.body as AvailabilityEnvelope).availability).toBeNull();
  });

  it('4. global-per-user, not per-workspace: setting status via workspace A is visible via workspace B for the SAME user', async () => {
    const { cookie, workspaceId: workspaceAId } = await registerOwnerWithWorkspace();
    // `createWorkspace` uses the SAME cookie, so this user is automatically
    // the OWNER (and thus already a member) of workspace B too -- no
    // separate membership insert needed (a redundant one would violate the
    // `(workspace_id, user_id)` unique constraint, since a row already
    // exists for this user from workspace creation itself).
    const workspaceBId = await createWorkspace(cookie, `Second workspace ${String(emailCounter)}`);

    const putResponse = await putStatus(cookie, workspaceAId, { status: 'focus' });
    expect(putResponse.status).toBe(200);

    const getFromB = await getStatus(cookie, workspaceBId);
    expect(getFromB.status).toBe(200);
    const body = (getFromB.body as AvailabilityEnvelope).availability;
    expect(body?.status).toBe('focus');
  });

  it("5. event-log visibility: after PUT, the user's deterministic stream contains exactly one UserAvailabilityChanged event with the correct payload", async () => {
    const { cookie, userId, workspaceId } = await registerOwnerWithWorkspace();

    const putResponse = await putStatus(cookie, workspaceId, { status: 'ooo' });
    expect(putResponse.status).toBe(200);

    const expectedStreamId = uuidV5(USER_AVAILABILITY_UUID_NAMESPACE, userId);
    const streamEvents: StoredEvent[] = await eventStore.readStream(expectedStreamId);

    expect(streamEvents).toHaveLength(1);
    expect(streamEvents[0]?.type).toBe('UserAvailabilityChanged');
    expect(streamEvents[0]?.payload['userId']).toBe(userId);
    expect(streamEvents[0]?.payload['status']).toBe('ooo');
  });

  it('6. unauthenticated -> 401; authenticated non-member -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const { cookie: outsiderCookie } = await registerUser();

    const unauthPut = await request(server)
      .put(availabilityUrl(workspaceId))
      .send({ status: 'focus' });
    expect(unauthPut.status).toBe(401);

    const unauthGet = await request(server).get(availabilityUrl(workspaceId));
    expect(unauthGet.status).toBe(401);

    const nonMemberPut = await putStatus(outsiderCookie, workspaceId, { status: 'focus' });
    expect(nonMemberPut.status).toBe(403);

    const nonMemberGet = await getStatus(outsiderCookie, workspaceId);
    expect(nonMemberGet.status).toBe(403);
  });

  it('7. an invalid status enum value ("busy") -> 400 (zod rejection)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await putStatus(cookie, workspaceId, { status: 'busy' });

    expect(response.status).toBe(400);
  });
});
