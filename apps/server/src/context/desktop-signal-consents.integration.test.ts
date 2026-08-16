import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deriveDeterministicUuid } from '@luminaos/shared';

import { DesktopSignalConsentProjection } from './desktop-signal-consent.projection.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { desktopSignalConsents } from '../db/schema/desktop-signal-consents.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { StoredEvent } from '../event-store/event-store.service.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * F2-T3 PR1 (RED step) — masaüstü sinyal rıza mekanizması, sunucu-taraflı,
 * olay-kaynaklı (ADR-0020 Karar a, `docs/adr/ADR-0020-masaustu-sinyal-toplayicilar.md`).
 * Mirrors `../availability/user-availability.integration.test.ts`'s
 * Testcontainers harness EXACTLY (Postgres 16 + Redis 7, `runMigrations`,
 * dynamic `import('../app.module.js')` AFTER env vars are set,
 * `Test.createTestingModule`, supertest) — this feature needs no new env
 * var either, so only `DATABASE_URL`/`REDIS_URL` are set.
 *
 * ============================================================================
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * A. `db/schema/desktop-signal-consents.ts` (new) — `desktop_signal_consents`
 *    table, exported as `desktopSignalConsents`: `id` varchar(26) PK (ULID,
 *    printed app-side, like every other read-model table), `workspaceId`
 *    uuid NOT NULL FK -> `workspaces.id` (cascade), `userId` uuid NOT NULL FK
 *    -> `users.id` (cascade), `signalType` varchar(30) NOT NULL, `grantedAt`
 *    timestamptz NOT NULL, `revokedAt` timestamptz NULLABLE.
 *    UNIQUE(workspaceId, userId, signalType). Plus a migration (up+down,
 *    CLAUDE.md).
 *
 * B. `context/desktop-signal-consent.projection.ts` (new) —
 *    `DesktopSignalConsentProjection implements Projection`: `name =
 *    'desktop-signal-consent'`, `handles = ['DesktopSignalConsentGranted',
 *    'DesktopSignalConsentRevoked']`.
 *      - `Granted` -> `insert(...).onConflictDoUpdate({ target: [workspaceId,
 *        userId, signalType], set: { grantedAt: event.occurredAt, revokedAt:
 *        null } })` — re-grant resets `revokedAt` to null (test #4).
 *      - `Revoked` -> `update(...).set({ revokedAt: event.occurredAt
 *        }).where(...)` matched on (workspaceId, userId, signalType), derived
 *        from the event's own `workspaceId`/`actor.id`/`payload.signalType`.
 *      - `reset(tx)` truncates its own table (mirrors
 *        `UserAvailabilityProjection.reset`) — used by test #9's
 *        `projectionRunner.rebuild`.
 *
 * C. `context/desktop-signal-consents.service.ts` (new) —
 *    `@Injectable() DesktopSignalConsentsService`:
 *      - A FIXED namespace constant, `DESKTOP_SIGNAL_CONSENT_UUID_NAMESPACE =
 *        'f1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f601'` (see the identical literal
 *        pinned below as this test file's OWN constant of the same name) —
 *        MUST NEVER change once real data exists (changing it silently opens
 *        a new stream per (workspace,user,signalType) triple, losing
 *        continuity). Test #10 independently re-derives the expected
 *        `streamId` via `deriveDeterministicUuid` (already-shipped,
 *        stable code in `@luminaos/shared` — NOT part of this PR's RED
 *        surface, so importing it directly here does not weaken the test).
 *      - `streamIdFor(workspaceId, userId, signalType) =
 *        deriveDeterministicUuid(DESKTOP_SIGNAL_CONSENT_UUID_NAMESPACE,
 *        `${workspaceId}:${userId}:${signalType}`)` — a SEPARATE stream per
 *        (workspace, user, signalType) triple (granular per signal type),
 *        mirroring `UserAvailabilityService.streamIdFor`'s
 *        read-prior-stream / append / synchronous catchUp / read-back shape.
 *      - `grant(workspaceId, userId, signalType)`: reads the prior stream,
 *        appends `DesktopSignalConsentGranted {signalType}` (actor
 *        `{type:'user', id:userId}`) at `priorEvents.length`, SYNCHRONOUSLY
 *        `projectionRunner.catchUp(this.projection)`, returns the read-back
 *        row.
 *      - `revoke(workspaceId, userId, signalType)`: same shape, appends
 *        `DesktopSignalConsentRevoked {signalType}`.
 *      - `get(workspaceId, userId, signalType)`: reads
 *        `desktop_signal_consents` by (workspaceId, userId, signalType);
 *        `null` if no row exists.
 *
 * D. `context/desktop-signal-consents.controller.ts` (new) — `@Controller(
 *    'workspaces/:workspaceId/context/desktop-signal-consents')`,
 *    `@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)` on all three
 *    routes:
 *      - `@Post()` body `{signalType}` (zod-validated; a `userId` key in the
 *        body, if present, is IGNORED — `req.user.id` is the ONLY source of
 *        the user identity, test #5 — self-service by construction, NOT a
 *        role check) -> `service.grant(workspaceId, req.user.id,
 *        body.signalType)`, 200/201, `{consent: {signalType, grantedAt,
 *        revokedAt}}`.
 *      - `@Delete(':signalType')` -> `service.revoke(workspaceId,
 *        req.user.id, params.signalType)`, 200/204.
 *      - `@Get(':signalType')` -> `service.get(workspaceId, req.user.id,
 *        params.signalType)`; `{consent: null}` (200, NOT 404) when no
 *        consent has ever been granted for that signalType — "never granted"
 *        is a valid, common state (mirrors `AvailabilityController`'s
 *        `{availability: null}` convention).
 *
 * E. `context/dto/grant-desktop-signal-consent.schema.ts` (new) — zod
 *    `{signalType: z.enum(['calendar-status', 'active-window'])}` — NOT
 *    `.strict()`: an extra `userId` key in the body must be TOLERATED and
 *    silently ignored per Karar (a)'s self-service-by-construction contract
 *    (D above); `.strict()` would 400-reject the request instead of quietly
 *    discarding the extra key, which is NOT the behavior test #5 pins.
 *
 * F. `context/desktop-signal-consents.module.ts` (new), wired into
 *    `app.module.ts`'s `imports` array.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `DesktopSignalConsentsModule` does not exist
 * and is not imported into `AppModule`, so EVERY route this file hits
 * (`/workspaces/:workspaceId/context/desktop-signal-consents...`) 404s as an
 * unmatched route (Nest's default "Cannot POST/GET/DELETE ..." 404) —
 * including the unauthenticated/non-member cases (test #7) which expect
 * 401/403 but will actually see 404 today, and the invalid-enum case (test
 * #11) which expects 400 but will also see 404. This is expected and
 * resolves once `DesktopSignalConsentsModule` and its guards exist. Test #10
 * fails differently even once routes exist but before the event/stream
 * wiring is exactly right: it asserts directly against
 * `eventStore.readStream(...)`, independent of the HTTP response shape.
 * Tests #8/#9, and in fact every test in this file (via the top-level
 * imports of `desktop-signal-consents.ts` and
 * `desktop-signal-consent.projection.ts`), fail at MODULE RESOLUTION time
 * until those two files exist.
 * ============================================================================
 */

/**
 * MUST match `DESKTOP_SIGNAL_CONSENT_UUID_NAMESPACE` in
 * `context/desktop-signal-consents.service.ts` exactly (§C above) — pinned
 * here as the literal contract value.
 */
const DESKTOP_SIGNAL_CONSENT_UUID_NAMESPACE = 'f1a2b3c4-d5e6-4f70-8a91-b2c3d4e5f601';

interface ConsentBody {
  signalType: string;
  grantedAt: string;
  revokedAt: string | null;
}

interface ConsentEnvelope {
  consent: ConsentBody | null;
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
  return `desktop-signal-consent-test-user-${String(emailCounter)}@example.com`;
}

const PASSWORD = 'correct-horse-battery-staple';

describe('F2-T3 PR1 (RED step): DesktopSignalConsents — event-sourced, self-service, per-(workspace,user,signalType) consent (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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
      `Desktop signal consent test workspace ${String(emailCounter)}`,
    );
    return { cookie, userId, workspaceId };
  }

  function consentsUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/context/desktop-signal-consents`;
  }

  async function grant(
    cookie: string,
    workspaceId: string,
    body: { signalType: string; userId?: string },
  ): Promise<request.Response> {
    return request(server).post(consentsUrl(workspaceId)).set('Cookie', cookie).send(body);
  }

  async function revoke(
    cookie: string,
    workspaceId: string,
    signalType: string,
  ): Promise<request.Response> {
    return request(server)
      .delete(`${consentsUrl(workspaceId)}/${signalType}`)
      .set('Cookie', cookie);
  }

  async function getConsent(
    cookie: string,
    workspaceId: string,
    signalType: string,
  ): Promise<request.Response> {
    return request(server)
      .get(`${consentsUrl(workspaceId)}/${signalType}`)
      .set('Cookie', cookie);
  }

  it('1. POST {signalType:"active-window"} -> success, response has grantedAt filled and revokedAt empty/null', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await grant(cookie, workspaceId, { signalType: 'active-window' });

    expect([200, 201]).toContain(response.status);
    const body = (response.body as ConsentEnvelope).consent;
    expect(body?.signalType).toBe('active-window');
    expect(body?.grantedAt).toBeDefined();
    expect(body?.revokedAt == null).toBe(true);
  });

  it('2. re-POST the same signalType (re-grant) -> idempotent, no error, grantedAt is updated (not duplicated)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const first = await grant(cookie, workspaceId, { signalType: 'active-window' });
    expect([200, 201]).toContain(first.status);
    const firstGrantedAt = (first.body as ConsentEnvelope).consent?.grantedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await grant(cookie, workspaceId, { signalType: 'active-window' });
    expect([200, 201]).toContain(second.status);
    const secondBody = (second.body as ConsentEnvelope).consent;
    expect(secondBody?.signalType).toBe('active-window');
    expect(secondBody?.grantedAt).toBeDefined();
    expect(secondBody?.grantedAt).not.toBe(firstGrantedAt);
    expect(secondBody?.revokedAt == null).toBe(true);
  });

  it('3. DELETE :signalType -> consent marked revoked; subsequent GET reflects revokedAt filled', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await grant(cookie, workspaceId, { signalType: 'active-window' });

    const revokeResponse = await revoke(cookie, workspaceId, 'active-window');
    expect([200, 204]).toContain(revokeResponse.status);

    const getResponse = await getConsent(cookie, workspaceId, 'active-window');
    expect(getResponse.status).toBe(200);
    const body = (getResponse.body as ConsentEnvelope).consent;
    expect(body?.revokedAt).toBeDefined();
    expect(body?.revokedAt).not.toBeNull();
  });

  it('4. revoke then re-grant -> revokedAt resets back to null ("yeniden-rıza revokedAt\'ı sıfırlar", ADR-0020 Karar a)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await grant(cookie, workspaceId, { signalType: 'calendar-status' });
    await revoke(cookie, workspaceId, 'calendar-status');

    const reGrant = await grant(cookie, workspaceId, { signalType: 'calendar-status' });
    expect([200, 201]).toContain(reGrant.status);
    expect((reGrant.body as ConsentEnvelope).consent?.revokedAt == null).toBe(true);

    const getResponse = await getConsent(cookie, workspaceId, 'calendar-status');
    expect(getResponse.status).toBe(200);
    expect((getResponse.body as ConsentEnvelope).consent?.revokedAt == null).toBe(true);
  });

  it('5. self-service by construction: a fake userId in the POST body is IGNORED — the consent is always recorded for the SESSION user (req.user.id), never the body value', async () => {
    const {
      cookie: sessionCookie,
      userId: sessionUserId,
      workspaceId,
    } = await registerOwnerWithWorkspace();
    const { userId: otherUserId } = await registerUser();

    const response = await grant(sessionCookie, workspaceId, {
      signalType: 'active-window',
      userId: otherUserId,
    });

    expect([200, 201]).toContain(response.status);

    // Raw DB proof: the persisted row's userId is the SESSION user's, never
    // the attacker-supplied body value.
    const rows = await rawDb
      .select()
      .from(desktopSignalConsents)
      .where(
        and(
          eq(desktopSignalConsents.workspaceId, workspaceId),
          eq(desktopSignalConsents.signalType, 'active-window'),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(sessionUserId);
    expect(rows[0]?.userId).not.toBe(otherUserId);
  });

  it('6. signal-type independence: granting "calendar-status" does not also grant "active-window" for the same user; GET returns each independently', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await grant(cookie, workspaceId, { signalType: 'calendar-status' });

    const calendarStatus = await getConsent(cookie, workspaceId, 'calendar-status');
    expect(calendarStatus.status).toBe(200);
    expect((calendarStatus.body as ConsentEnvelope).consent?.grantedAt).toBeDefined();

    const activeWindow = await getConsent(cookie, workspaceId, 'active-window');
    expect(activeWindow.status).toBe(200);
    expect((activeWindow.body as ConsentEnvelope).consent).toBeNull();
  });

  it('7. unauthenticated -> 401; authenticated non-member -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const { cookie: outsiderCookie } = await registerUser();

    const unauthPost = await request(server)
      .post(consentsUrl(workspaceId))
      .send({ signalType: 'active-window' });
    expect(unauthPost.status).toBe(401);

    const unauthGet = await request(server).get(`${consentsUrl(workspaceId)}/active-window`);
    expect(unauthGet.status).toBe(401);

    const unauthDelete = await request(server).delete(`${consentsUrl(workspaceId)}/active-window`);
    expect(unauthDelete.status).toBe(401);

    const nonMemberPost = await grant(outsiderCookie, workspaceId, { signalType: 'active-window' });
    expect(nonMemberPost.status).toBe(403);

    const nonMemberGet = await getConsent(outsiderCookie, workspaceId, 'active-window');
    expect(nonMemberGet.status).toBe(403);
  });

  it('8. UNIQUE(workspaceId, userId, signalType): repeated grants/revokes never duplicate the row (onConflictDoUpdate upserts in place)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await grant(cookie, workspaceId, { signalType: 'active-window' });
    await grant(cookie, workspaceId, { signalType: 'active-window' });
    await revoke(cookie, workspaceId, 'active-window');
    await grant(cookie, workspaceId, { signalType: 'active-window' });

    const rows = await rawDb
      .select()
      .from(desktopSignalConsents)
      .where(
        and(
          eq(desktopSignalConsents.workspaceId, workspaceId),
          eq(desktopSignalConsents.signalType, 'active-window'),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBeNull();
  });

  it('9. rebuild-determinism (F0-T6 AC4): after several grant/revoke events, projectionRunner.rebuild reproduces the exact same grantedAt/revokedAt state', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    await grant(cookie, workspaceId, { signalType: 'active-window' });
    await revoke(cookie, workspaceId, 'active-window');
    await grant(cookie, workspaceId, { signalType: 'active-window' });
    await grant(cookie, workspaceId, { signalType: 'calendar-status' });
    await revoke(cookie, workspaceId, 'calendar-status');

    const snapshot = async (): Promise<
      { userId: string; signalType: string; grantedAt: string; revokedAt: string | null }[]
    > => {
      const rows = await rawDb
        .select()
        .from(desktopSignalConsents)
        .where(eq(desktopSignalConsents.workspaceId, workspaceId));

      return rows
        .map((row) => ({
          userId: row.userId,
          signalType: row.signalType,
          grantedAt: row.grantedAt.toISOString(),
          revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
        }))
        .sort((a, b) => a.signalType.localeCompare(b.signalType));
    };

    const beforeRebuild = await snapshot();

    const consentProjection = new DesktopSignalConsentProjection();
    await projectionRunner.rebuild(consentProjection);

    const afterRebuild = await snapshot();

    expect(afterRebuild).toEqual(beforeRebuild);
  });

  it('10. event-log visibility: grant/revoke append DesktopSignalConsentGranted/Revoked to the deterministic per-(workspace,user,signalType) stream', async () => {
    const { cookie, userId, workspaceId } = await registerOwnerWithWorkspace();

    await grant(cookie, workspaceId, { signalType: 'active-window' });

    const expectedStreamId = deriveDeterministicUuid(
      DESKTOP_SIGNAL_CONSENT_UUID_NAMESPACE,
      `${workspaceId}:${userId}:active-window`,
    );

    let streamEvents: StoredEvent[] = await eventStore.readStream(expectedStreamId);
    expect(streamEvents).toHaveLength(1);
    expect(streamEvents[0]?.type).toBe('DesktopSignalConsentGranted');
    expect(streamEvents[0]?.payload['signalType']).toBe('active-window');

    await revoke(cookie, workspaceId, 'active-window');

    streamEvents = await eventStore.readStream(expectedStreamId);
    expect(streamEvents).toHaveLength(2);
    expect(streamEvents[1]?.type).toBe('DesktopSignalConsentRevoked');
    expect(streamEvents[1]?.payload['signalType']).toBe('active-window');
  });

  it('11. an invalid signalType enum value ("browser-tabs") -> 400 (zod rejection)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await grant(cookie, workspaceId, { signalType: 'browser-tabs' });

    expect(response.status).toBe(400);
  });
});
