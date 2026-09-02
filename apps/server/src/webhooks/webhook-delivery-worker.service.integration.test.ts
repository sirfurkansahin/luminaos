import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { encryptSecret } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { webhookDeliveries } from '../db/schema/webhook-deliveries.js';
import { webhookSubscriptions } from '../db/schema/webhook-subscriptions.js';
import { workspaces } from '../db/schema/workspaces.js';

import type { Database } from '../db/client.js';

/**
 * F2-T16 PR2 (RED step), ADR-0033 Karar (d) — `WebhookDeliveryWorker`, the
 * background poller that scans `webhook_deliveries` for `pending AND
 * next_attempt_at <= now()` rows and drives them through
 * `WebhookDeliveryService.deliver()`. Mirrors
 * `../automation/trigger-scheduler.service.integration.test.ts`'s exact
 * harness (Testcontainers Postgres only, per-row try/catch, test file calls
 * `runOnce()` directly and NEVER `onModuleInit()` -- no `setInterval` leakage
 * in tests).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): NEITHER `./webhook-delivery-worker.service.ts`
 * NOR `./webhook-delivery.service.ts` exists yet -- the dynamic `import()`s
 * inside `beforeAll` reject with a "Cannot find module" error, failing every
 * `it` below at setup. This is the correct RED failure reason, not a
 * test-logic bug. `webhook_subscriptions`/`webhook_deliveries` (schema +
 * migration) already exist from PR1.
 *
 * ============================================================================
 * DESIGN judgment calls pinned by this file (not 100% spelled out by the
 * task brief) -- see the constructor/contract types below for the precise
 * shape `implementer` must produce:
 *   - `WebhookDeliveryWorker`'s constructor is `(db: Database,
 *     webhookDeliveryService: WebhookDeliveryService)` -- mirrors
 *     `TriggerSchedulerService`'s own `(db, commandsService)` two-arg shape.
 *     The REAL `WebhookDeliveryService` (from the sibling PR2 unit test,
 *     `./webhook-delivery.service.test.ts`) is constructed here with a fixed
 *     test `encryptionKey`, and `fetch` is globally mocked per test -- this
 *     composes the REAL signing/HTTP logic with a controlled network layer,
 *     so this file only needs to drive the WORKER's own queue-state
 *     transitions (delivered/pending-retry/failed), not re-prove signing.
 *   - A row's failure that happens to be a genuinely thrown exception from
 *     `deliver()` (e.g. a malformed `encryptedSigningSecret` that fails to
 *     decrypt) must be caught by the WORKER's own per-row try/catch and must
 *     NOT abort the scan -- mirrors `TriggerSchedulerService.runOnce()`'s
 *     identical per-row isolation discipline (test 5 below).
 *   - `runOnce()` scans the ENTIRE `webhook_deliveries` table (no
 *     per-workspace/per-subscription filtering), so every assertion below is
 *     written against a SPECIFIC delivery row's own id (never a global row
 *     count), keeping tests order-independent even though they all share one
 *     Postgres container/table.
 * ============================================================================
 */

interface WebhookDeliveryResultContract {
  outcome: 'delivered' | 'failed';
  sanitizedError?: string;
}

interface WebhookDeliveryServiceContract {
  deliver(input: {
    targetUrl: string;
    encryptedSigningSecret: string;
    payload: unknown;
  }): Promise<WebhookDeliveryResultContract>;
}

interface WebhookDeliveryServiceConfig {
  encryptionKey: Buffer;
}

type WebhookDeliveryServiceConstructor = new (
  config: WebhookDeliveryServiceConfig,
) => WebhookDeliveryServiceContract;

interface WebhookDeliveryWorkerLike {
  runOnce(): Promise<void>;
}

type WebhookDeliveryWorkerConstructor = new (
  db: Database,
  webhookDeliveryService: WebhookDeliveryServiceContract,
) => WebhookDeliveryWorkerLike;

interface DeliveryRow {
  id: string;
  subscriptionId: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  deliveredAt: Date | null;
}

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7);
const KNOWN_PLAINTEXT_SECRET = 'fixture-worker-signing-secret-0123456789'; // gitleaks:allow -- test fixture, not a real secret
const LEAKED_BODY_MARKER = '__worker-test-leaked-response-body-marker__';

describe('WebhookDeliveryWorker (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let webhookDeliveryService: WebhookDeliveryServiceContract;
  let WebhookDeliveryWorker: WebhookDeliveryWorkerConstructor;
  let workspaceCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);

    // Deliberately unresolvable until `implementer` creates
    // `./webhook-delivery.service.ts` -- see this file's header for why the
    // resulting `import-x/no-unresolved` finding is expected and contained to
    // this one line.

    const deliveryServiceModule: unknown = await import('./webhook-delivery.service.js');
    const WebhookDeliveryServiceCtor = (
      deliveryServiceModule as { WebhookDeliveryService: WebhookDeliveryServiceConstructor }
    ).WebhookDeliveryService;
    webhookDeliveryService = new WebhookDeliveryServiceCtor({ encryptionKey: TEST_ENCRYPTION_KEY });

    // Same reasoning, for `./webhook-delivery-worker.service.ts`.

    const workerModule: unknown = await import('./webhook-delivery-worker.service.js');
    WebhookDeliveryWorker = (
      workerModule as { WebhookDeliveryWorker: WebhookDeliveryWorkerConstructor }
    ).WebhookDeliveryWorker;
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function createWorkspace(): Promise<string> {
    workspaceCounter += 1;
    const [row] = await db
      .insert(workspaces)
      .values({
        name: `webhook-delivery-worker-test-${String(workspaceCounter)}`,
        slug: `webhook-delivery-worker-test-${String(workspaceCounter)}`,
      })
      .returning({ id: workspaces.id });
    if (!row) {
      throw new Error('Failed to create test workspace');
    }
    return row.id;
  }

  async function createSubscription(params: {
    workspaceId: string;
    encryptedSigningSecret?: string;
  }): Promise<string> {
    const id = ulid();
    const now = new Date();
    await db.insert(webhookSubscriptions).values({
      id,
      workspaceId: params.workspaceId,
      // NOTE (implementer, PR2 RED->GREEN): matches `webhook-delivery.
      // service.test.ts`'s own fixture-hostname fix -- `WebhookDeliveryService
      // .deliver()` re-validates via the REAL `assertSafeWebhookUrl` (a real
      // `dns.lookup` for any non-literal-IP host) immediately before the
      // globally-mocked `fetch`, so this fixture host must actually resolve.
      // `example.com` (bare) does; an arbitrary subdomain does not.
      targetUrl: 'https://example.com/hook',
      eventTypes: ['ActionsProposed'],
      encryptedSigningSecret:
        params.encryptedSigningSecret ?? encryptSecret(KNOWN_PLAINTEXT_SECRET, TEST_ENCRYPTION_KEY),
      createdByUserId: randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async function insertDeliveryRow(params: {
    subscriptionId: string;
    attempts?: number;
    nextAttemptAt?: Date;
    status?: string;
  }): Promise<string> {
    const now = new Date();
    const [row] = await db
      .insert(webhookDeliveries)
      .values({
        subscriptionId: params.subscriptionId,
        eventType: 'ActionsProposed',
        payload: { eventType: 'ActionsProposed', occurredAt: now.toISOString(), data: {} },
        status: params.status ?? 'pending',
        attempts: params.attempts ?? 0,
        nextAttemptAt: params.nextAttemptAt ?? now,
        createdAt: now,
      })
      .returning({ id: webhookDeliveries.id });
    if (!row) {
      throw new Error('Failed to insert fixture delivery row');
    }
    return row.id;
  }

  async function readDeliveryRow(id: string): Promise<DeliveryRow | undefined> {
    const [row] = await db
      .select({
        id: webhookDeliveries.id,
        subscriptionId: webhookDeliveries.subscriptionId,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        nextAttemptAt: webhookDeliveries.nextAttemptAt,
        lastError: webhookDeliveries.lastError,
        deliveredAt: webhookDeliveries.deliveredAt,
      })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id));
    return row;
  }

  function stubFetchResolved(response: Response): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  // ---------------------------------------------------------------------
  // (a) due pending row + successful delivery -> delivered, deliveredAt set
  // ---------------------------------------------------------------------

  it('(a) a due pending row with a mocked-successful fetch becomes status: "delivered" with deliveredAt set', async () => {
    const workspaceId = await createWorkspace();
    const subscriptionId = await createSubscription({ workspaceId });
    const deliveryId = await insertDeliveryRow({ subscriptionId });
    stubFetchResolved(new Response(null, { status: 200 }));

    const worker = new WebhookDeliveryWorker(db, webhookDeliveryService);
    await worker.runOnce();

    const row = await readDeliveryRow(deliveryId);
    expect(row?.status).toBe('delivered');
    expect(row?.deliveredAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // (b) due pending row, failing fetch, attempts 0 -> 1, stays pending,
  //     nextAttemptAt pushed into the future
  // ---------------------------------------------------------------------

  it('(b) a due pending row with a mocked-failing fetch: attempts becomes 1, status stays "pending", nextAttemptAt is pushed into the future', async () => {
    const workspaceId = await createWorkspace();
    const subscriptionId = await createSubscription({ workspaceId });
    const deliveryId = await insertDeliveryRow({ subscriptionId, attempts: 0 });
    stubFetchResolved(new Response('irrelevant body', { status: 500 }));

    const worker = new WebhookDeliveryWorker(db, webhookDeliveryService);
    const beforeRun = Date.now();
    await worker.runOnce();

    const row = await readDeliveryRow(deliveryId);
    expect(row?.attempts).toBe(1);
    expect(row?.status).toBe('pending');
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(beforeRun);
  });

  // ---------------------------------------------------------------------
  // (c) row at attempts: 2 fails again -> attempts 3, status "failed",
  //     never retried again
  // ---------------------------------------------------------------------

  it('(c) a row already at attempts: 2 that fails again becomes attempts: 3, status: "failed" (terminal), and is never touched by a subsequent runOnce()', async () => {
    const workspaceId = await createWorkspace();
    const subscriptionId = await createSubscription({ workspaceId });
    const deliveryId = await insertDeliveryRow({ subscriptionId, attempts: 2 });
    stubFetchResolved(new Response('irrelevant body', { status: 500 }));

    const worker = new WebhookDeliveryWorker(db, webhookDeliveryService);
    await worker.runOnce();

    const row = await readDeliveryRow(deliveryId);
    expect(row?.attempts).toBe(3);
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toBeDefined();

    vi.unstubAllGlobals();
    const secondFetchMock = stubFetchResolved(new Response(null, { status: 200 }));
    await worker.runOnce();

    const rowAfterSecondRun = await readDeliveryRow(deliveryId);
    expect(rowAfterSecondRun?.attempts).toBe(3);
    expect(rowAfterSecondRun?.status).toBe('failed');
    expect(secondFetchMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // (d) row not yet due -> NOT processed
  // ---------------------------------------------------------------------

  it('(d) a row whose nextAttemptAt is in the future is NOT processed by runOnce() yet', async () => {
    const workspaceId = await createWorkspace();
    const subscriptionId = await createSubscription({ workspaceId });
    const futureNextAttemptAt = new Date(Date.now() + 60 * 60 * 1000);
    const deliveryId = await insertDeliveryRow({
      subscriptionId,
      attempts: 0,
      nextAttemptAt: futureNextAttemptAt,
    });
    const fetchMock = stubFetchResolved(new Response(null, { status: 200 }));

    const worker = new WebhookDeliveryWorker(db, webhookDeliveryService);
    await worker.runOnce();

    const row = await readDeliveryRow(deliveryId);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
    expect(row?.deliveredAt).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // (e) one row's delivery-time error does not block another due row
  // ---------------------------------------------------------------------

  it('(e) one row causing an error during delivery (e.g. a corrupted encryptedSigningSecret) does not prevent another due row from being processed in the SAME runOnce() call', async () => {
    const workspaceId = await createWorkspace();
    const goodSubscriptionId = await createSubscription({ workspaceId });
    const badSubscriptionId = await createSubscription({
      workspaceId,
      encryptedSigningSecret: 'not-a-valid-encrypted-secret-format',
    });
    const goodDeliveryId = await insertDeliveryRow({ subscriptionId: goodSubscriptionId });
    const badDeliveryId = await insertDeliveryRow({ subscriptionId: badSubscriptionId });
    stubFetchResolved(new Response(null, { status: 200 }));

    const worker = new WebhookDeliveryWorker(db, webhookDeliveryService);
    await expect(worker.runOnce()).resolves.toBeUndefined();

    const goodRow = await readDeliveryRow(goodDeliveryId);
    expect(goodRow?.status).toBe('delivered');

    const badRow = await readDeliveryRow(badDeliveryId);
    expect(badRow?.status).not.toBe('delivered');
  });

  // ---------------------------------------------------------------------
  // (f) lastError never contains raw response-body content
  // ---------------------------------------------------------------------

  it('(f) lastError never contains raw response-body content, even when the mocked failing response body contains a marker string', async () => {
    const workspaceId = await createWorkspace();
    const subscriptionId = await createSubscription({ workspaceId });
    const deliveryId = await insertDeliveryRow({ subscriptionId, attempts: 0 });
    stubFetchResolved(new Response(LEAKED_BODY_MARKER, { status: 500 }));

    const worker = new WebhookDeliveryWorker(db, webhookDeliveryService);
    await worker.runOnce();

    const row = await readDeliveryRow(deliveryId);
    expect(row?.lastError).toBeDefined();
    expect(row?.lastError).not.toContain(LEAKED_BODY_MARKER);
  });
});
