import crypto from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { NewDomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { webhookSubscriptions } from '../db/schema/webhook-subscriptions.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

/**
 * F2-T16 PR2 (RED step), ADR-0033 Karar (d)/(e) — `WebhookDeliveryEnqueueProjection`,
 * the projection that turns `ActionsProposed`/`ActionsDecided` events into
 * `webhook_deliveries` rows, IN the same projection-runner catch-up
 * transaction as `command_proposals` (see `../commands/action-proposal.
 * projection.ts`, the closest structural precedent this file mirrors).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./webhook-delivery-enqueue.projection.ts` does
 * not exist yet -- the dynamic `import()` inside `beforeAll` rejects with a
 * "Cannot find module" error, failing every `it` below at setup. This is the
 * correct RED failure reason, not a test-logic bug. `webhook_subscriptions`/
 * `webhook_deliveries` (schema + migration) already exist from PR1, so those
 * tables themselves are NOT expected to be missing.
 *
 * ============================================================================
 * DESIGNED CONTRACT `implementer` must match precisely (per the PR2 task
 * brief, ADR-0033 §d/§e):
 *   export class WebhookDeliveryEnqueueProjection implements Projection {
 *     readonly name = 'webhook-delivery-enqueue';
 *     readonly handles = ['ActionsProposed', 'ActionsDecided'];
 *     async apply(event, tx): Promise<void> { ... }
 *     async reset(tx): Promise<void> { ... }
 *   }
 *
 *   `apply()` reads active (`lifecycle: 'active'`) `webhook_subscriptions`
 *   rows scoped to `event.workspaceId` (the DomainEvent's OWN top-level
 *   field -- NOT `event.payload.workspaceId`, which is ABSENT on a real
 *   `ActionsDecided` event's payload, confirmed against
 *   `CommandsService.decide()`'s own event-construction code:
 *   `payload: { proposalId, decisions }`, no `workspaceId` key), filters (in
 *   application code, not SQL) to subscriptions whose `eventTypes` array
 *   includes `event.type`, and for each matching subscription INSERTs one
 *   `webhook_deliveries` row with:
 *     - subscriptionId = the subscription's id
 *     - eventType = event.type
 *     - payload = { eventType: event.type, occurredAt: event.occurredAt.toISOString(), data: event.payload }
 *     - status: 'pending', attempts: 0, nextAttemptAt = now, createdAt = now
 *
 *   `reset()` deletes all rows from `webhook_deliveries` (mirrors
 *   `ActionProposalProjection.reset`'s `delete(commandProposals)`).
 * ============================================================================
 */

interface RawWebhookDeliveryRow {
  id: string;
  subscription_id: string;
  event_type: string;
  payload: { eventType: string; occurredAt: string; data: Record<string, unknown> };
  status: string;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
  delivered_at: Date | null;
}

const PROPOSAL_STREAM_TYPE = 'action-proposal';
const COMMAND_PARSER_ACTOR = { type: 'agent', id: 'command-parser' } as const;
const APPROVER_ACTOR = { type: 'user', id: 'deciding-user-1' } as const;

/**
 * The public contract `WebhookDeliveryEnqueueProjection` must satisfy,
 * declared locally (see this file's header) rather than imported statically
 * -- mirrors `ActionProposalProjection`'s own integration test's identical
 * "contains the import-x/no-unresolved finding to one line" technique.
 */
interface WebhookDeliveryEnqueueProjectionContract extends Projection {
  apply(event: Parameters<Projection['apply']>[0], tx: ProjectionTx): Promise<void>;
  reset(tx: ProjectionTx): Promise<void>;
}

type WebhookDeliveryEnqueueProjectionConstructor =
  new () => WebhookDeliveryEnqueueProjectionContract;

describe('WebhookDeliveryEnqueueProjection (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let projection: WebhookDeliveryEnqueueProjectionContract;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);

    // Deliberately unresolvable until `implementer` creates
    // `./webhook-delivery-enqueue.projection.ts` -- see this file's header.
    // The eslint-disable below only silences the STATIC-ANALYSIS finding for
    // this one line; the dynamic `import()` still throws a real "Cannot find
    // module" error at test-run time, which is the correct RED failure.

    const importedModule: unknown = await import('./webhook-delivery-enqueue.projection.js');
    const WebhookDeliveryEnqueueProjectionCtor = (
      importedModule as {
        WebhookDeliveryEnqueueProjection: WebhookDeliveryEnqueueProjectionConstructor;
      }
    ).WebhookDeliveryEnqueueProjection;
    projection = new WebhookDeliveryEnqueueProjectionCtor();
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
      throw new Error(`Failed to insert fixture workspace "${name}"`);
    }

    return workspace.id;
  }

  /** Seeds an ACTIVE subscription via a normal Drizzle insert against the already-existing `webhook_subscriptions` schema (PR1). */
  async function createActiveSubscription(params: {
    workspaceId: string;
    eventTypes: string[];
  }): Promise<string> {
    const id = ulid();
    const now = new Date();
    await db.insert(webhookSubscriptions).values({
      id,
      workspaceId: params.workspaceId,
      targetUrl: 'https://example.com/hook',
      eventTypes: params.eventTypes,
      encryptedSigningSecret: 'fixture-encrypted-secret-not-real',
      createdByUserId: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  /**
   * Seeds a `lifecycle: 'deleted'` subscription via RAW SQL -- the public
   * `WebhookSubscriptionsService` always writes `lifecycle: 'active'` on
   * create (PR1), so there is no service-level way to construct one; this
   * directly inserts the row to simulate an already-soft-deleted subscription.
   */
  async function createDeletedSubscriptionRaw(params: {
    workspaceId: string;
    eventTypes: string[];
  }): Promise<string> {
    const id = ulid();
    const now = new Date();
    await db.$client.query(
      `insert into webhook_subscriptions
         (id, workspace_id, target_url, event_types, encrypted_signing_secret, lifecycle, created_by_user_id, created_at, updated_at)
       values ($1, $2, $3, $4::jsonb, $5, 'deleted', $6, $7, $7)`,
      [
        id,
        params.workspaceId,
        'https://example.com/hook-deleted',
        JSON.stringify(params.eventTypes),
        'fixture-encrypted-secret-not-real',
        crypto.randomUUID(),
        now,
      ],
    );
    return id;
  }

  function buildActionsProposedEvent(
    workspaceId: string,
    payloadOverrides: Record<string, unknown> = {},
  ): { streamId: string; event: NewDomainEvent } {
    const streamId = crypto.randomUUID();
    const event: NewDomainEvent = {
      id: crypto.randomUUID(),
      streamType: PROPOSAL_STREAM_TYPE,
      workspaceId,
      type: 'ActionsProposed',
      payload: {
        proposalId: crypto.randomUUID(),
        workspaceId,
        command: 'create a follow-up task',
        actions: [
          {
            actionId: crypto.randomUUID(),
            type: 'createTask',
            intent: 'Create a follow-up task',
            rationale: 'The user asked for one',
            resources: [],
            rollbackNote: 'Delete the created task',
            params: { title: 'Follow up' },
          },
        ],
        ...payloadOverrides,
      },
      actor: COMMAND_PARSER_ACTOR,
      occurredAt: new Date(),
    };
    return { streamId, event };
  }

  /**
   * Mirrors `CommandsService.decide()`'s REAL `ActionsDecided` event shape
   * exactly: `payload: { proposalId, decisions }` -- deliberately NO
   * `workspaceId` key in the payload, since the projection under test must
   * read `event.workspaceId` (the envelope's own top-level field), never
   * `event.payload.workspaceId`.
   */
  function buildActionsDecidedEvent(
    workspaceId: string,
    payloadOverrides: Record<string, unknown> = {},
  ): { streamId: string; event: NewDomainEvent } {
    const streamId = crypto.randomUUID();
    const event: NewDomainEvent = {
      id: crypto.randomUUID(),
      streamType: PROPOSAL_STREAM_TYPE,
      workspaceId,
      type: 'ActionsDecided',
      payload: {
        proposalId: crypto.randomUUID(),
        decisions: [{ actionId: crypto.randomUUID(), decision: 'approved' }],
        ...payloadOverrides,
      },
      actor: APPROVER_ACTOR,
      occurredAt: new Date(),
    };
    return { streamId, event };
  }

  async function appendEvent(streamId: string, event: NewDomainEvent): Promise<void> {
    await eventStore.append(streamId, 0, [event]);
  }

  async function getDeliveryRowsForSubscription(
    subscriptionId: string,
  ): Promise<RawWebhookDeliveryRow[]> {
    const result = await db.$client.query<RawWebhookDeliveryRow>(
      `select id, subscription_id, event_type, payload, status, attempts, next_attempt_at,
              last_error, created_at, delivered_at
       from webhook_deliveries where subscription_id = $1`,
      [subscriptionId],
    );
    return result.rows;
  }

  async function countAllDeliveryRows(): Promise<number> {
    const result = await db.$client.query<{ count: string }>(
      'select count(*)::text as count from webhook_deliveries',
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  // ---------------------------------------------------------------------
  // (a) matching active subscription -> exactly one row enqueued, right shape
  // ---------------------------------------------------------------------

  it('(a) ActionsProposed in a workspace with one active subscription whose eventTypes includes it enqueues exactly one webhook_deliveries row with the right shape', async () => {
    const workspaceId = await createWorkspace('webhook-enqueue-ac-a');
    const subscriptionId = await createActiveSubscription({
      workspaceId,
      eventTypes: ['ActionsProposed'],
    });
    const { streamId, event } = buildActionsProposedEvent(workspaceId);
    const beforeAppend = Date.now();

    await appendEvent(streamId, event);
    await projectionRunner.catchUp(projection);

    const rows = await getDeliveryRowsForSubscription(subscriptionId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.event_type).toBe('ActionsProposed');
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
    expect(row?.last_error).toBeNull();
    expect(row?.delivered_at).toBeNull();
    expect(row?.payload.eventType).toBe('ActionsProposed');
    expect(row?.payload.occurredAt).toBe(event.occurredAt.toISOString());
    expect(row?.payload.data).toEqual(event.payload);
    expect(row?.created_at).toBeInstanceOf(Date);
    expect(row?.next_attempt_at.getTime()).toBeGreaterThanOrEqual(beforeAppend - 5_000);
    expect(row?.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  // ---------------------------------------------------------------------
  // (b) subscription's eventTypes does NOT include the event's type
  // ---------------------------------------------------------------------

  it("(b) a subscription whose eventTypes does NOT include the event's type is NOT enqueued", async () => {
    const workspaceId = await createWorkspace('webhook-enqueue-ac-b');
    const subscriptionId = await createActiveSubscription({
      workspaceId,
      eventTypes: ['ActionsDecided'],
    });
    const { streamId, event } = buildActionsProposedEvent(workspaceId);

    await appendEvent(streamId, event);
    await projectionRunner.catchUp(projection);

    const rows = await getDeliveryRowsForSubscription(subscriptionId);
    expect(rows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // (c) lifecycle: 'deleted' subscription -> NOT enqueued
  // ---------------------------------------------------------------------

  it("(c) a lifecycle:'deleted' subscription is NOT enqueued, even though its eventTypes matches", async () => {
    const workspaceId = await createWorkspace('webhook-enqueue-ac-c');
    const subscriptionId = await createDeletedSubscriptionRaw({
      workspaceId,
      eventTypes: ['ActionsProposed'],
    });
    const { streamId, event } = buildActionsProposedEvent(workspaceId);

    await appendEvent(streamId, event);
    await projectionRunner.catchUp(projection);

    const rows = await getDeliveryRowsForSubscription(subscriptionId);
    expect(rows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // (d) subscription in a DIFFERENT workspace -> NOT enqueued for this event
  // ---------------------------------------------------------------------

  it('(d) a subscription in a DIFFERENT workspace than the event is NOT enqueued', async () => {
    const subscriptionWorkspaceId = await createWorkspace('webhook-enqueue-ac-d-sub');
    const eventWorkspaceId = await createWorkspace('webhook-enqueue-ac-d-event');
    const subscriptionId = await createActiveSubscription({
      workspaceId: subscriptionWorkspaceId,
      eventTypes: ['ActionsProposed'],
    });
    const { streamId, event } = buildActionsProposedEvent(eventWorkspaceId);

    await appendEvent(streamId, event);
    await projectionRunner.catchUp(projection);

    const rows = await getDeliveryRowsForSubscription(subscriptionId);
    expect(rows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // (e) ActionsDecided -> enqueued using event.workspaceId (top-level),
  //     NOT event.payload.workspaceId (absent on a real ActionsDecided event)
  // ---------------------------------------------------------------------

  it('(e) an ActionsDecided event enqueues the same way, using the top-level event.workspaceId (payload has no workspaceId field)', async () => {
    const workspaceId = await createWorkspace('webhook-enqueue-ac-e');
    const subscriptionId = await createActiveSubscription({
      workspaceId,
      eventTypes: ['ActionsDecided'],
    });
    const { streamId, event } = buildActionsDecidedEvent(workspaceId);
    expect(Object.prototype.hasOwnProperty.call(event.payload, 'workspaceId')).toBe(false);

    await appendEvent(streamId, event);
    await projectionRunner.catchUp(projection);

    const rows = await getDeliveryRowsForSubscription(subscriptionId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.event_type).toBe('ActionsDecided');
    expect(row?.status).toBe('pending');
    expect(row?.payload.eventType).toBe('ActionsDecided');
    expect(row?.payload.data).toEqual(event.payload);
  });

  // ---------------------------------------------------------------------
  // (f) reset() clears all rows
  // ---------------------------------------------------------------------

  it('(f) reset(tx) empties webhook_deliveries entirely', async () => {
    const workspaceId = await createWorkspace('webhook-enqueue-ac-f');
    await createActiveSubscription({ workspaceId, eventTypes: ['ActionsProposed'] });
    const { streamId, event } = buildActionsProposedEvent(workspaceId);

    await appendEvent(streamId, event);
    await projectionRunner.catchUp(projection);

    expect(await countAllDeliveryRows()).toBeGreaterThan(0);

    await db.transaction(async (tx) => {
      await projection.reset(tx as unknown as ProjectionTx);
    });

    expect(await countAllDeliveryRows()).toBe(0);
  });
});
