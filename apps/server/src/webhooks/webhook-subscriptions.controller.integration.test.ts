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
 * F2-T16 PR1 (RED step): HTTP-level wiring for outbound webhook
 * subscriptions (`WebhookSubscriptionsController`/`WebhookSubscriptionsService`/
 * `WebhooksModule`), per ADR-0033 §g's FLAT admin+-for-both-reads-AND-writes
 * RBAC rule -- deliberately DIFFERENT from
 * `../automation/automation-triggers.controller.integration.test.ts`'s
 * admin-write/member-read split, because a webhook subscription's mere
 * existence + target URL is itself a sensitive, potential
 * data-exfiltration signal (ADR-0033 §g).
 *
 * Mirrors `../automation/automation-triggers.controller.integration.test.ts`'s
 * exact harness (full Nest app boot via Testcontainers Postgres 16 + Redis 7,
 * real `SessionAuthGuard`/`WorkspaceMembershipGuard` flow, the same
 * `addMemberWithRole` raw-insert-into-`memberships` helper).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): NONE of `WebhookSubscriptionsService` /
 * `WebhookSubscriptionsController` / `WebhooksModule` exist yet, and
 * `AppModule` does not import any such module -- every request below to
 * `/workspaces/:workspaceId/webhooks...` is expected to 404 via Nest's own
 * default "Cannot POST/GET/DELETE ..." handler (no matching route at all),
 * NOT via `AppErrorFilter` mapping an `AppError`, mirroring
 * `automation-triggers.controller.integration.test.ts`'s own documented
 * red-state note. Neither `webhook_subscriptions` nor its migration exist
 * yet either, so once the HTTP layer exists but the table doesn't, the red
 * state shifts to a 500 from a missing-relation error -- also a legitimate
 * "implementation incomplete" red, not a test-logic bug.
 *
 * `implementer` must: add `webhook-subscriptions.service.ts`,
 * `webhook-subscriptions.controller.ts`, `dto/create-webhook-subscription.schema.ts`,
 * `../db/schema/webhook-subscriptions.ts` + migration (down script included),
 * `ssrf-guard.ts`, and `webhooks.module.ts` (imported by `AppModule`).
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `@Controller('workspaces/:workspaceId/webhooks')`, guarded by
 * `SessionAuthGuard` + `WorkspaceMembershipGuard` at the class level.
 *
 *   POST   /workspaces/:workspaceId/webhooks
 *          body: { targetUrl, eventTypes: string[] }
 *          -> 201 { subscription: { id, targetUrl, eventTypes, signingSecret,
 *             createdAt } } (requires `admin`+, else 403). `signingSecret` is
 *             the PLAINTEXT secret, present ONLY in this create response --
 *             never again from GET.
 *          An unsafe target (non-https, or resolves/literal to a
 *          private/reserved IP) -> 400.
 *
 *   GET    /workspaces/:workspaceId/webhooks
 *          -> 200 { subscriptions: [...] } (requires `admin`+, else 403 --
 *             NOT `member`+, ADR-0033 §g's deliberate deviation). Each item's
 *             shape NEVER includes `signingSecret`/`encryptedSigningSecret`.
 *
 *   DELETE /workspaces/:workspaceId/webhooks/:subscriptionId
 *          -> 204 (requires `admin`+, else 403). A `subscriptionId` from a
 *             different workspace, or nonexistent, -> 404.
 * ---------------------------------------------------------------------------
 */

const PASSWORD = 'correct-horse-battery-staple';

interface UserEnvelope {
  user: { id: string; email: string };
}

interface WorkspaceEnvelope {
  workspace: { id: string };
}

interface WebhookSubscriptionBody {
  id: string;
  targetUrl: string;
  eventTypes: string[];
  signingSecret?: string;
  createdAt: string;
}

interface WebhookSubscriptionEnvelope {
  subscription: WebhookSubscriptionBody;
}

interface WebhookSubscriptionListEnvelope {
  subscriptions: WebhookSubscriptionBody[];
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

let emailCounter = 0;

function freshEmail(): string {
  emailCounter += 1;
  return `webhook-sub-controller-test-user-${String(emailCounter)}@example.com`;
}

function createWebhookRequestBody(overrides?: {
  targetUrl?: string;
  eventTypes?: string[];
}): Record<string, unknown> {
  return {
    targetUrl: overrides?.targetUrl ?? 'https://example.com/hook',
    eventTypes: overrides?.eventTypes ?? ['ActionsProposed'],
  };
}

describe('F2-T16 PR1 (RED step): CRUD .../webhooks -- workspace-scoped outbound webhook subscriptions (real Postgres + real HTTP, via Testcontainers + supertest)', () => {
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

    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 3).toString('base64');

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
      .send({ name: `Webhook sub controller test workspace ${String(emailCounter)}` });
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

  function webhooksUrl(workspaceId: string): string {
    return `/workspaces/${workspaceId}/webhooks`;
  }

  function webhookUrl(workspaceId: string, subscriptionId: string): string {
    return `/workspaces/${workspaceId}/webhooks/${subscriptionId}`;
  }

  async function createWebhookAsAdmin(
    cookie: string,
    workspaceId: string,
    body: Record<string, unknown>,
  ): Promise<WebhookSubscriptionBody> {
    const response = await request(server)
      .post(webhooksUrl(workspaceId))
      .set('Cookie', cookie)
      .send(body);
    expect(response.status).toBe(201);
    return (response.body as WebhookSubscriptionEnvelope).subscription;
  }

  it('1. POST as an admin (the workspace owner) -> 201, returns the created subscription with a plaintext signingSecret', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(webhooksUrl(workspaceId))
      .set('Cookie', cookie)
      .send(createWebhookRequestBody());

    expect(response.status).toBe(201);
    const { subscription } = response.body as WebhookSubscriptionEnvelope;
    expect(subscription.id).toBeDefined();
    expect(subscription.targetUrl).toBe('https://example.com/hook');
    expect(subscription.eventTypes).toEqual(['ActionsProposed']);
    expect(typeof subscription.signingSecret).toBe('string');
    expect((subscription.signingSecret ?? '').length).toBeGreaterThan(0);
  });

  it('2. POST with an http:// (non-https) targetUrl -> 400 (ADR-0033 Karar b)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(webhooksUrl(workspaceId))
      .set('Cookie', cookie)
      .send(createWebhookRequestBody({ targetUrl: 'http://example.com/hook' }));

    expect(response.status).toBe(400);
  });

  it('3. POST with a private-IP (cloud metadata) targetUrl -> 400 (ADR-0033 Karar a, ssrf-guard)', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();

    const response = await request(server)
      .post(webhooksUrl(workspaceId))
      .set('Cookie', cookie)
      .send(createWebhookRequestBody({ targetUrl: 'https://169.254.169.254/hook' }));

    expect(response.status).toBe(400);
  });

  it('4. POST as a "member" (not admin) -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .post(webhooksUrl(workspaceId))
      .set('Cookie', memberCookie)
      .send(createWebhookRequestBody());

    expect(response.status).toBe(403);
  });

  it('5. GET as an admin -> 200, lists subscriptions, never including signingSecret/encryptedSigningSecret', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    await createWebhookAsAdmin(cookie, workspaceId, createWebhookRequestBody());

    const response = await request(server).get(webhooksUrl(workspaceId)).set('Cookie', cookie);

    expect(response.status).toBe(200);
    const { subscriptions } = response.body as WebhookSubscriptionListEnvelope;
    expect(subscriptions.length).toBeGreaterThan(0);
    for (const subscription of subscriptions) {
      expect(subscription).not.toHaveProperty('signingSecret');
      expect(subscription).not.toHaveProperty('encryptedSigningSecret');
    }
  });

  it('6. GET as a "member" (not admin) -> 403 (ADR-0033 Karar g: admin+ required for READ too, unlike .../triggers\' member+ read)', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .get(webhooksUrl(workspaceId))
      .set('Cookie', memberCookie);

    expect(response.status).toBe(403);
  });

  it('7. GET as a "guest" -> 403', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();
    const guestCookie = await addMemberWithRole(workspaceId, 'guest');

    const response = await request(server).get(webhooksUrl(workspaceId)).set('Cookie', guestCookie);

    expect(response.status).toBe(403);
  });

  it('8. DELETE as an admin -> 204, and a subsequent GET no longer includes it', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const subscription = await createWebhookAsAdmin(
      cookie,
      workspaceId,
      createWebhookRequestBody(),
    );

    const deleteResponse = await request(server)
      .delete(webhookUrl(workspaceId, subscription.id))
      .set('Cookie', cookie);
    expect(deleteResponse.status).toBe(204);

    const listResponse = await request(server).get(webhooksUrl(workspaceId)).set('Cookie', cookie);
    expect(listResponse.status).toBe(200);
    const { subscriptions } = listResponse.body as WebhookSubscriptionListEnvelope;
    expect(subscriptions.some((s) => s.id === subscription.id)).toBe(false);
  });

  it('9. DELETE as a "member" (not admin) -> 403', async () => {
    const { cookie: adminCookie, workspaceId } = await registerOwnerWithWorkspace();
    const subscription = await createWebhookAsAdmin(
      adminCookie,
      workspaceId,
      createWebhookRequestBody(),
    );
    const memberCookie = await addMemberWithRole(workspaceId, 'member');

    const response = await request(server)
      .delete(webhookUrl(workspaceId, subscription.id))
      .set('Cookie', memberCookie);
    expect(response.status).toBe(403);
  });

  it('10. cross-workspace isolation: a subscription created in workspace A is invisible to DELETE from workspace B (404, not a data leak)', async () => {
    const { cookie: cookieA, workspaceId: workspaceAId } = await registerOwnerWithWorkspace();
    const subscription = await createWebhookAsAdmin(
      cookieA,
      workspaceAId,
      createWebhookRequestBody(),
    );

    const { cookie: cookieB, workspaceId: workspaceBId } = await registerOwnerWithWorkspace();

    const deleteResponse = await request(server)
      .delete(webhookUrl(workspaceBId, subscription.id))
      .set('Cookie', cookieB);
    expect(deleteResponse.status).toBe(404);

    const listResponseB = await request(server)
      .get(webhooksUrl(workspaceBId))
      .set('Cookie', cookieB);
    expect(listResponseB.status).toBe(200);
    const { subscriptions } = listResponseB.body as WebhookSubscriptionListEnvelope;
    expect(subscriptions.some((s) => s.id === subscription.id)).toBe(false);
  });

  it('11. a nonexistent subscriptionId in DELETE -> 404', async () => {
    const { cookie, workspaceId } = await registerOwnerWithWorkspace();
    const nonexistentId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

    const deleteResponse = await request(server)
      .delete(webhookUrl(workspaceId, nonexistentId))
      .set('Cookie', cookie);
    expect(deleteResponse.status).toBe(404);
  });

  it('12. guard stack: unauthenticated caller -> 401 on POST/GET/DELETE', async () => {
    const { workspaceId } = await registerOwnerWithWorkspace();

    const postResponse = await request(server)
      .post(webhooksUrl(workspaceId))
      .send(createWebhookRequestBody());
    expect(postResponse.status).toBe(401);

    const getResponse = await request(server).get(webhooksUrl(workspaceId));
    expect(getResponse.status).toBe(401);

    const deleteResponse = await request(server).delete(
      webhookUrl(workspaceId, '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    );
    expect(deleteResponse.status).toBe(401);
  });
});
