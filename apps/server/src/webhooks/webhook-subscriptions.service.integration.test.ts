import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decryptSecret, ForbiddenError, NotFoundError, ValidationError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { users } from '../db/schema/users.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

/**
 * F2-T16 PR1 (RED step), ADR-0033 §g/§h — `WebhookSubscriptionsService`
 * (`./webhook-subscriptions.service.ts`, does NOT exist yet as of this
 * commit), backed by a NEW `webhook_subscriptions` table
 * (`../db/schema/webhook-subscriptions.ts`, ADR-0033 "Şema Taslağı", ALSO
 * does not exist yet -- no migration for it either).
 *
 * ============================================================================
 * HARNESS CHOICE: per ADR-0033 Karar (h), `webhook_subscriptions` is a flat
 * (NOT event-sourced) CRUD table -- structurally identical in shape to
 * `connector_credentials` (F2-T9/ADR-0025). This file therefore follows
 * `../integrations/connector-credentials.integration.test.ts`'s exact
 * precedent (DI-free `new WebhookSubscriptionsServiceCtor(db)` instantiation
 * against a real Testcontainers Postgres, NO full Nest app boot, NO Redis
 * container, NO HTTP/supertest layer) rather than
 * `../automation/automation-triggers.controller.integration.test.ts`'s
 * full-app-boot shape -- this file only exercises the SERVICE layer; the
 * HTTP/RBAC-at-the-guard-stack layer is covered separately by
 * `./webhook-subscriptions.controller.integration.test.ts`, which DOES need
 * the full app+Redis harness (real sessions/guards). `REDIS_URL` is still
 * set here (to an inert placeholder) only because `../config/env.js` fatally
 * exits at import time if it's unset -- nothing in this file ever actually
 * connects to it, exactly like `connector-credentials.integration.test.ts`'s
 * own documented reasoning.
 *
 * `ENCRYPTION_KEY`: same `Buffer.alloc(32, 7).toString('base64')` fixture as
 * `connector-credentials.integration.test.ts`, set in `beforeAll` BEFORE the
 * dynamic `./webhook-subscriptions.service.js` import -- the service reuses
 * `env.encryptionKey`/`encryptSecret`/`decryptSecret` per ADR-0033 §e, no new
 * env var.
 *
 * RBAC deviation from `AutomationTriggersService` (ADR-0033 §g, spelled out
 * explicitly here so a future reader isn't confused why this test file
 * asserts something different from
 * `../automation/automation-triggers.service.ts`'s own member-read/admin-write
 * split): a webhook subscription's mere EXISTENCE + target URL is treated as
 * sensitive (a hint of a data-exfiltration integration), so BOTH reads
 * (`list`) AND writes (`create`/`remove`) require `admin`+ here -- there is
 * no `member`-read carve-out.
 *
 * Since `../db/schema/webhook-subscriptions.ts` does not exist yet, this file
 * cannot statically import a typed Drizzle schema object for it -- raw
 * `db.$client.query(...)` SQL is used for every direct-row assertion instead,
 * mirroring `connector-credentials.integration.test.ts`'s own convention for
 * the exact same "schema doesn't exist yet" reason.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): neither `./webhook-subscriptions.service.ts`
 * nor `../db/schema/webhook-subscriptions.ts` (nor its migration) exist yet.
 * `beforeAll`'s dynamic `import('./webhook-subscriptions.service.js')`
 * rejects with a "Cannot find module" resolution error, failing every test in
 * this file at setup -- this is the correct red, not a test-logic bug.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 *   create(workspaceId, actor, callerRole, { targetUrl, eventTypes })
 *     -> Promise<{ id, targetUrl, eventTypes, signingSecret, createdAt }>
 *     `admin`+ only (else `ForbiddenError`). Validates `targetUrl` via
 *     `assertSafeWebhookUrl` (rejects `http://` and private-IP targets,
 *     NEVER persists a row for a rejected URL) and validates `eventTypes` is
 *     a non-empty subset of `['ActionsProposed', 'ActionsDecided']` (else
 *     `ValidationError`). `signingSecret` is the PLAINTEXT secret, returned
 *     ONLY here, on create -- never again from any read endpoint.
 *
 *   list(workspaceId, callerRole)
 *     -> Promise<Array<{ id, targetUrl, eventTypes, createdAt }>>
 *     `admin`+ only (else `ForbiddenError`, NOT `member`+ -- ADR-0033 §g's
 *     deliberate deviation from `AutomationTriggersService.list`). The
 *     returned shape NEVER includes `signingSecret` or its encrypted form.
 *
 *   remove(workspaceId, subscriptionId, callerRole) -> Promise<void>
 *     `admin`+ only (else `ForbiddenError`). A `subscriptionId` belonging to
 *     a different workspace (or nonexistent) -> `NotFoundError`, mirroring
 *     `AutomationTriggersService.lookupStreamId`'s cross-workspace-isolation
 *     contract.
 * ---------------------------------------------------------------------------
 */

interface WebhookSubscriptionRecord {
  id: string;
  targetUrl: string;
  eventTypes: string[];
  createdAt: Date;
}

interface CreatedWebhookSubscription extends WebhookSubscriptionRecord {
  signingSecret: string;
}

interface WebhookSubscriptionsServiceContract {
  create(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: { targetUrl: string; eventTypes: string[] },
  ): Promise<CreatedWebhookSubscription>;
  list(workspaceId: string, callerRole: MembershipRole): Promise<WebhookSubscriptionRecord[]>;
  remove(workspaceId: string, subscriptionId: string, callerRole: MembershipRole): Promise<void>;
}

type WebhookSubscriptionsServiceConstructor = new (
  db: Database,
) => WebhookSubscriptionsServiceContract;

interface RawWebhookSubscriptionRow {
  id: string;
  workspace_id: string;
  target_url: string;
  event_types: string[];
  encrypted_signing_secret: string;
  lifecycle: string;
}

describe('WebhookSubscriptionsService (real Postgres via Testcontainers, ADR-0033 §e/§g/§h)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let service: WebhookSubscriptionsServiceContract;
  let encryptionKey: Buffer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://webhook-subscriptions-test-placeholder:6379';
    encryptionKey = Buffer.alloc(32, 9);
    process.env['ENCRYPTION_KEY'] = encryptionKey.toString('base64');

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);

    // Deliberately unresolvable until `implementer` creates
    // `./webhook-subscriptions.service.ts` -- see this file's header for why
    // the resulting `import-x/no-unresolved` finding is expected and
    // contained to this one line.
    const importedModule: unknown = await import('./webhook-subscriptions.service.js');
    const WebhookSubscriptionsServiceCtor = (
      importedModule as { WebhookSubscriptionsService: WebhookSubscriptionsServiceConstructor }
    ).WebhookSubscriptionsService;
    service = new WebhookSubscriptionsServiceCtor(db);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(name: string): Promise<string> {
    const [workspace] = await db
      .insert(workspaces)
      .values({ name, slug: crypto.randomUUID() })
      .returning({ id: workspaces.id });

    if (!workspace) {
      throw new ValidationError(`Failed to insert fixture workspace "${name}"`);
    }

    return workspace.id;
  }

  async function createUser(email: string): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({ email, passwordHash: 'not-a-real-hash-fixture-only' })
      .returning({ id: users.id });

    if (!user) {
      throw new ValidationError(`Failed to insert fixture user "${email}"`);
    }

    return user.id;
  }

  function actorFor(userId: string): Actor {
    return { type: 'user', id: userId };
  }

  async function rawRowsForWorkspace(workspaceId: string): Promise<RawWebhookSubscriptionRow[]> {
    const result = await db.$client.query<RawWebhookSubscriptionRow>(
      'SELECT id, workspace_id, target_url, event_types, encrypted_signing_secret, lifecycle FROM webhook_subscriptions WHERE workspace_id = $1',
      [workspaceId],
    );
    return result.rows;
  }

  let emailCounter = 0;
  function freshEmail(): string {
    emailCounter += 1;
    return `webhook-sub-test-user-${String(emailCounter)}@example.com`;
  }

  it('1. create() as admin returns the plaintext signingSecret, and the row persisted at rest is encrypted (decrypts back to the same plaintext)', async () => {
    const workspaceId = await createWorkspace('Webhook sub workspace 1');
    const userId = await createUser(freshEmail());

    const created = await service.create(workspaceId, actorFor(userId), 'admin', {
      targetUrl: 'https://example.com/hook',
      eventTypes: ['ActionsProposed'],
    });

    expect(created.id).toBeDefined();
    expect(created.targetUrl).toBe('https://example.com/hook');
    expect(created.eventTypes).toEqual(['ActionsProposed']);
    expect(typeof created.signingSecret).toBe('string');
    expect(created.signingSecret.length).toBeGreaterThan(0);
    expect(created.createdAt).toBeInstanceOf(Date);

    const rows = await rawRowsForWorkspace(workspaceId);
    expect(rows).toHaveLength(1);
    const row = rows[0] as RawWebhookSubscriptionRow;
    expect(row.encrypted_signing_secret).not.toBe(created.signingSecret);
    expect(decryptSecret(row.encrypted_signing_secret, encryptionKey)).toBe(created.signingSecret);
  });

  it('2. create() rejects a plain http:// targetUrl and never persists a row (ADR-0033 Karar b)', async () => {
    const workspaceId = await createWorkspace('Webhook sub workspace 2');
    const userId = await createUser(freshEmail());

    await expect(
      service.create(workspaceId, actorFor(userId), 'admin', {
        targetUrl: 'http://example.com/hook',
        eventTypes: ['ActionsProposed'],
      }),
    ).rejects.toThrow();

    const rows = await rawRowsForWorkspace(workspaceId);
    expect(rows).toHaveLength(0);
  });

  it('3. create() rejects a private-IP targetUrl and never persists a row (ADR-0033 Karar a, ssrf-guard)', async () => {
    const workspaceId = await createWorkspace('Webhook sub workspace 3');
    const userId = await createUser(freshEmail());

    await expect(
      service.create(workspaceId, actorFor(userId), 'admin', {
        targetUrl: 'https://169.254.169.254/hook',
        eventTypes: ['ActionsProposed'],
      }),
    ).rejects.toThrow();

    const rows = await rawRowsForWorkspace(workspaceId);
    expect(rows).toHaveLength(0);
  });

  it('4. create() rejects an empty eventTypes array (ValidationError)', async () => {
    const workspaceId = await createWorkspace('Webhook sub workspace 4');
    const userId = await createUser(freshEmail());

    await expect(
      service.create(workspaceId, actorFor(userId), 'admin', {
        targetUrl: 'https://example.com/hook',
        eventTypes: [],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('5. create() rejects an eventTypes entry outside the ["ActionsProposed", "ActionsDecided"] allow-list (ADR-0033 Karar c -- e.g. a trigger-lifecycle event is explicitly out of scope)', async () => {
    const workspaceId = await createWorkspace('Webhook sub workspace 5');
    const userId = await createUser(freshEmail());

    await expect(
      service.create(workspaceId, actorFor(userId), 'admin', {
        targetUrl: 'https://example.com/hook',
        eventTypes: ['TriggerCreated'],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('6. create() as a "member" -> ForbiddenError (ADR-0033 Karar g: admin+ required for WRITE, same as AutomationTriggersService)', async () => {
    const workspaceId = await createWorkspace('Webhook sub workspace 6');
    const userId = await createUser(freshEmail());

    await expect(
      service.create(workspaceId, actorFor(userId), 'member', {
        targetUrl: 'https://example.com/hook',
        eventTypes: ['ActionsProposed'],
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('7. list() never includes signingSecret or its encrypted form in the returned shape', async () => {
    const workspaceId = await createWorkspace('Webhook sub workspace 7');
    const userId = await createUser(freshEmail());
    await service.create(workspaceId, actorFor(userId), 'admin', {
      targetUrl: 'https://example.com/hook',
      eventTypes: ['ActionsDecided'],
    });

    const list = await service.list(workspaceId, 'admin');

    expect(list).toHaveLength(1);
    const [subscription] = list;
    expect(subscription).toBeDefined();
    expect(subscription).not.toHaveProperty('signingSecret');
    expect(subscription).not.toHaveProperty('encryptedSigningSecret');
    expect(Object.keys(subscription as object).sort()).toEqual(
      ['createdAt', 'eventTypes', 'id', 'targetUrl'].sort(),
    );
  });

  it('8. list() as a "member" -> ForbiddenError (ADR-0033 Karar g: admin+ required for READ too -- deliberately DIFFERENT from AutomationTriggersService.list\'s member+ read)', async () => {
    const workspaceId = await createWorkspace('Webhook sub workspace 8');

    await expect(service.list(workspaceId, 'member')).rejects.toThrow(ForbiddenError);
  });

  it('9. list() as a "guest" -> ForbiddenError', async () => {
    const workspaceId = await createWorkspace('Webhook sub workspace 9');

    await expect(service.list(workspaceId, 'guest')).rejects.toThrow(ForbiddenError);
  });

  it("10. cross-workspace isolation: list() in workspace A never returns workspace B's subscriptions", async () => {
    const workspaceAId = await createWorkspace('Webhook sub workspace A (10)');
    const workspaceBId = await createWorkspace('Webhook sub workspace B (10)');
    const userAId = await createUser(freshEmail());
    const userBId = await createUser(freshEmail());

    await service.create(workspaceAId, actorFor(userAId), 'admin', {
      targetUrl: 'https://a.example.com/hook',
      eventTypes: ['ActionsProposed'],
    });
    await service.create(workspaceBId, actorFor(userBId), 'admin', {
      targetUrl: 'https://b.example.com/hook',
      eventTypes: ['ActionsProposed'],
    });

    const listA = await service.list(workspaceAId, 'admin');
    expect(listA).toHaveLength(1);
    expect(listA.some((s) => s.targetUrl === 'https://b.example.com/hook')).toBe(false);
  });

  it('11. remove() as admin deletes the subscription (verified via a subsequent list() no longer including it)', async () => {
    const workspaceId = await createWorkspace('Webhook sub workspace 11');
    const userId = await createUser(freshEmail());
    const created = await service.create(workspaceId, actorFor(userId), 'admin', {
      targetUrl: 'https://example.com/hook',
      eventTypes: ['ActionsProposed'],
    });

    await service.remove(workspaceId, created.id, 'admin');

    const list = await service.list(workspaceId, 'admin');
    expect(list.some((s) => s.id === created.id)).toBe(false);
  });

  it('12. remove() as a "member" -> ForbiddenError, and the subscription is NOT deleted (ADR-0033 Karar g)', async () => {
    const workspaceId = await createWorkspace('Webhook sub workspace 12');
    const userId = await createUser(freshEmail());
    const created = await service.create(workspaceId, actorFor(userId), 'admin', {
      targetUrl: 'https://example.com/hook',
      eventTypes: ['ActionsProposed'],
    });

    await expect(service.remove(workspaceId, created.id, 'member')).rejects.toThrow(ForbiddenError);

    const list = await service.list(workspaceId, 'admin');
    expect(list.some((s) => s.id === created.id)).toBe(true);
  });

  it("13. remove() with a subscriptionId belonging to a DIFFERENT workspace -> NotFoundError, not a cross-workspace delete (mirrors AutomationTriggersService.lookupStreamId's contract)", async () => {
    const workspaceAId = await createWorkspace('Webhook sub workspace A (13)');
    const workspaceBId = await createWorkspace('Webhook sub workspace B (13)');
    const userAId = await createUser(freshEmail());

    const created = await service.create(workspaceAId, actorFor(userAId), 'admin', {
      targetUrl: 'https://example.com/hook',
      eventTypes: ['ActionsProposed'],
    });

    await expect(service.remove(workspaceBId, created.id, 'admin')).rejects.toThrow(NotFoundError);

    const listA = await service.list(workspaceAId, 'admin');
    expect(listA.some((s) => s.id === created.id)).toBe(true);
  });

  it('14. remove() with a nonexistent subscriptionId -> NotFoundError', async () => {
    const workspaceId = await createWorkspace('Webhook sub workspace 14');

    await expect(
      service.remove(workspaceId, '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'admin'),
    ).rejects.toThrow(NotFoundError);
  });
});
