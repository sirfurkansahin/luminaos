import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commentResource, objectResource } from '@luminaos/agent-runtime';
import type { ActionResourceReference, RollbackPlan } from '@luminaos/agent-runtime';
import { ForbiddenError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

/**
 * F3-T4 PR1b (RED step), ADR-0038 Karar (a)/(b)/(c)/(d)/(e) --
 * `AgentActionRecordsService`: the unified agent-action ledger ("Uçuş Kayıt
 * Cihazı" / Flight Recorder) backend, structurally mirroring
 * `AgentPermissionManifestsService`/`AgentResourceLimitsService`'s exact
 * split (`@Injectable()` class, `private readonly projection = new
 * AgentActionRecordProjection()`, `DATABASE_CONNECTION`/`EventStoreService`/
 * `ProjectionRunner` injected via constructor) -- BUT `record()` itself
 * follows `AgentResourceLimitsService.recordAgentAction`'s best-effort/
 * never-throws pattern (own try/catch, log-and-swallow, no propagation),
 * because a ledger-write failure must never break the real action it is
 * recording (ADR-0038 Karar c/d, the single most safety-critical behavior of
 * this service).
 *
 * `record`/`list` write a FRESH `randomUUID()` stream per `AgentActionRecord`
 * (each ledger entry is its own independent, never-updated row -- unlike
 * `AgentPermissionManifestsService`'s deterministic per-`(workspaceId,
 * agentIdentifier)` stream), mirroring `AgentDirectoryService.register`'s
 * "fresh stream per new entity" convention, not
 * `AgentPermissionManifestsService`'s "deterministic stream per toggle" one.
 *
 * `list`/`get` are `member`+ RBAC, workspace-wide -- NO personal (`req.user.id
 * === userId`) restriction (ADR-0038 Karar e: this is a workspace-wide audit
 * ledger, the same category as `AutomationTriggersService`'s "never
 * personal" principle, not `MemoryAccessPolicyService`'s self-service shape).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./agent-action-records.service.ts` (and its
 * collaborators `./agent-action-records.projection.ts` +
 * `../db/schema/agent-action-records.ts`) do not exist at all, so the dynamic
 * `import('./agent-action-records.service.js')` call inside `beforeAll`
 * REJECTS ("Cannot find module"), failing every `it` in this file -- mirrors
 * `agent-directory.service.integration.test.ts`'s own documented "service
 * doesn't exist yet" red state. The `agent_action_records` table (schema +
 * migration `0043_*.sql`, also not yet on disk) is likewise expected
 * missing -- this file's `beforeAll` will fail at `runMigrations` resolving
 * no relevant migration/table, or at the dynamic import, whichever the
 * implementer lands first; either is an acceptable RED failure mode, NOT a
 * bug in this test file. PR1a's pure domain types/factories
 * (`@luminaos/agent-runtime`'s `AgentActionRecord`/`ActionResourceReference`/
 * `RollbackPlan`/`objectResource`/`commentResource`/`agentResource`) ARE
 * already merged and importable statically -- only this PR's own
 * server-side pieces are missing.
 *
 * HARNESS NOTE: Testcontainers Postgres only (no Redis/HTTP) -- this entity
 * has no AI-gateway/embedding/webhook collaborator, so the lightweight
 * harness (`agent-directory.service.integration.test.ts`'s "direct `new
 * EventStoreService(db)` / `new ProjectionRunner(db, eventStore)`, no full
 * Nest app boot" shape) applies directly.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `AgentActionRecordsService(db, eventStore, projectionRunner)`:
 *   - `record(workspaceId: string, input: RecordAgentActionInput):
 *     Promise<void>` -- NO `callerRole` parameter at all (internal-only,
 *     never exposed via any controller route, called only by trusted server
 *     code -- future PR2's `executeXxx`s and PR3's `MentionActionWorker`).
 *     NEVER THROWS -- any failure (FK violation, projection error, etc.) is
 *     caught internally and only logged; the returned promise always
 *     resolves. Writes ONE fresh `randomUUID()` stream per call (`version 0`
 *     append), event `type: 'AgentActionRecorded'`, `streamType:
 *     'agent-action-record'`. The event's own envelope `actor`/`occurredAt`
 *     ARE `input.actor` / the moment of the call -- NOT duplicated into the
 *     event payload (PR1a's `agentActionRecordedPayloadSchema` design, which
 *     `.strict()`-rejects an `actor`/`occurredAt` payload key).
 *   - `list(workspaceId: string, callerRole: MembershipRole):
 *     Promise<AgentActionRecordContract[]>` -- `member`+ (else
 *     `ForbiddenError`); ALL rows for `workspaceId`, workspace-wide, no
 *     personal filter.
 *   - `get(workspaceId: string, recordId: string, callerRole:
 *     MembershipRole): Promise<AgentActionRecordContract | null>` --
 *     `member`+ (else `ForbiddenError`); scoped by `id` + `workspaceId`
 *     together (mirrors `AgentDirectoryService.getById`'s exact contract) --
 *     returns `null` (not a thrown `NotFoundError`) for a non-existent id OR
 *     an id belonging to a DIFFERENT workspace -- the controller layer is
 *     responsible for turning `null` into a 404.
 * ============================================================================
 */

/**
 * A field-for-field local copy of the `AgentActionRecord` shape pinned by
 * ADR-0038 Karar (b) -- declared locally rather than statically importing
 * `AgentActionRecord` from `@luminaos/agent-runtime` for the RETURN shape,
 * mirroring `agent-directory.service.integration.test.ts`'s
 * `AgentContract` convention: even though PR1a's pure types are already
 * merged, pinning the service's OWN return contract locally keeps this
 * file's red-state failure isolated to "service module missing", not a
 * accidental type-shape drift from a future PR1a change.
 */
interface AgentActionRecordContract {
  id: string;
  workspaceId: string;
  provenance: 'decided' | 'autonomous';
  actor: Actor;
  actionType: string;
  intent: string;
  rationale: string;
  resources: ActionResourceReference[];
  rollbackPlan: RollbackPlan;
  outcome: 'succeeded' | 'partially_succeeded' | 'failed' | 'rejected';
  resultRef: ActionResourceReference | null;
  causationEventId: string | null;
  occurredAt: Date;
}

interface RecordAgentActionInput {
  provenance: 'decided' | 'autonomous';
  actor: Actor;
  actionType: string;
  intent: string;
  rationale: string;
  resources: ActionResourceReference[];
  rollbackPlan: RollbackPlan;
  outcome: 'succeeded' | 'partially_succeeded' | 'failed' | 'rejected';
  resultRef: ActionResourceReference | null;
  causationEventId: string | null;
}

interface AgentActionRecordsServiceLike {
  record(workspaceId: string, input: RecordAgentActionInput): Promise<void>;
  list(workspaceId: string, callerRole: MembershipRole): Promise<AgentActionRecordContract[]>;
  get(
    workspaceId: string,
    recordId: string,
    callerRole: MembershipRole,
  ): Promise<AgentActionRecordContract | null>;
}

type AgentActionRecordsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
) => AgentActionRecordsServiceLike;

describe('F3-T4 PR1b (RED step): AgentActionRecordsService — unified agent-action ledger backend (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let service: AgentActionRecordsServiceLike;
  let workspaceCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();
    process.env.DATABASE_URL = connectionString;

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);

    // Imported dynamically, not statically at the top of this file, per the
    // established convention for "does not exist yet" RED-step service
    // modules (`agent-directory.service.integration.test.ts`,
    // `agent-permission-manifests.service.integration.test.ts`). This
    // contains the resulting `import-x/no-unresolved` finding to this one
    // line, instead of cascading into a static-import failure across the
    // whole file.
    const serviceModule: unknown = await import('./agent-action-records.service.js');
    const AgentActionRecordsServiceCtor = (
      serviceModule as { AgentActionRecordsService: AgentActionRecordsServiceConstructor }
    ).AgentActionRecordsService;

    service = new AgentActionRecordsServiceCtor(db, eventStore, projectionRunner);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await container.stop();
  }, 60_000);

  async function createWorkspace(): Promise<string> {
    workspaceCounter += 1;
    const [row] = await db
      .insert(workspaces)
      .values({
        name: `agent-action-records-test-workspace-${String(workspaceCounter)}`,
        slug: `agent-action-records-test-workspace-${String(workspaceCounter)}`,
      })
      .returning({ id: workspaces.id });
    if (!row) {
      throw new Error('Failed to create test workspace');
    }
    return row.id;
  }

  function fakeUserActor(): Actor {
    return { type: 'user', id: randomUUID() };
  }

  function fakeAgentActor(agentIdentifier: string): Actor {
    return { type: 'agent', id: agentIdentifier };
  }

  function decidedInput(overrides: Partial<RecordAgentActionInput> = {}): RecordAgentActionInput {
    return {
      provenance: 'decided',
      actor: fakeUserActor(),
      actionType: 'createTask',
      intent: 'Create a follow-up task from a meeting action item.',
      rationale: 'The meeting transcript flagged an unassigned action item.',
      resources: [objectResource('obj-meeting-123')],
      rollbackPlan: {
        kind: 'delete',
        targetResource: objectResource('obj-newly-created-task-456'),
        description: 'Delete the created task.',
      },
      outcome: 'succeeded',
      resultRef: objectResource('obj-newly-created-task-456'),
      causationEventId: randomUUID(),
      ...overrides,
    };
  }

  function autonomousInput(
    overrides: Partial<RecordAgentActionInput> = {},
  ): RecordAgentActionInput {
    const agentIdentifier = 'research-bot-v1';
    return {
      provenance: 'autonomous',
      actor: fakeAgentActor(agentIdentifier),
      actionType: 'answer-question',
      intent: "Bir yorumdaki @mention'a yanıt verildi",
      rationale:
        'Ajan, kendi izin manifestosu kapsamında bu nesnedeki bir mentiona otomatik yanıt verdi.',
      resources: [objectResource('obj-789'), commentResource('comment-abc')],
      rollbackPlan: {
        kind: 'delete',
        targetResource: commentResource('comment-reply-xyz'),
        description: 'Ajanın yanıt yorumunu sil.',
      },
      outcome: 'succeeded',
      resultRef: commentResource('comment-reply-xyz'),
      causationEventId: null,
      ...overrides,
    };
  }

  /**
   * `record()` is documented as `Promise<void>` (best-effort, no readback) --
   * to obtain the generated `id` for a just-recorded entry, seed with a
   * unique `actionType` marker, then find it back via `list()`. This avoids
   * assuming any particular `record()` return shape beyond "resolves".
   */
  async function recordAndFetch(
    workspaceId: string,
    input: RecordAgentActionInput,
  ): Promise<AgentActionRecordContract> {
    await service.record(workspaceId, input);
    const rows = await service.list(workspaceId, 'admin');
    const match = rows.find((row) => row.actionType === input.actionType);
    if (!match) {
      throw new Error(
        `Expected a record with actionType "${input.actionType}" to be listed after record().`,
      );
    }
    return match;
  }

  it('1. record() with a full valid "decided"-provenance input persists a row readable via list(), with actor/occurredAt sourced from the envelope (not the payload)', async () => {
    const workspaceId = await createWorkspace();
    const input = decidedInput({ actionType: 'createTask-decided-1' });
    const beforeCall = new Date();

    const created = await recordAndFetch(workspaceId, input);

    expect(created.id).toBeDefined();
    expect(typeof created.id).toBe('string');
    expect(created.workspaceId).toBe(workspaceId);
    expect(created.provenance).toBe('decided');
    expect(created.actor).toEqual(input.actor);
    expect(created.actionType).toBe('createTask-decided-1');
    expect(created.intent).toBe(input.intent);
    expect(created.rationale).toBe(input.rationale);
    expect(created.resources).toEqual(input.resources);
    expect(created.rollbackPlan).toEqual(input.rollbackPlan);
    expect(created.outcome).toBe('succeeded');
    expect(created.resultRef).toEqual(input.resultRef);
    expect(created.causationEventId).toBe(input.causationEventId);
    expect(created.occurredAt).toBeInstanceOf(Date);
    expect(created.occurredAt.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
  });

  it('2. record() with a full valid "autonomous"-provenance input (causationEventId: null, agent actor) persists a row readable via list()', async () => {
    const workspaceId = await createWorkspace();
    const input = autonomousInput({ actionType: 'answer-question-autonomous-1' });

    const created = await recordAndFetch(workspaceId, input);

    expect(created.provenance).toBe('autonomous');
    expect(created.actor).toEqual({ type: 'agent', id: 'research-bot-v1' });
    expect(created.causationEventId).toBeNull();
    expect(created.resources).toEqual(input.resources);
    expect(created.resultRef).toEqual(input.resultRef);
  });

  it('3. record() is best-effort: a workspaceId that violates the events table FK constraint causes an internal write failure that record() swallows -- it resolves without throwing', async () => {
    const nonExistentWorkspaceId = randomUUID();
    const input = decidedInput({ actionType: 'createTask-best-effort-1' });

    await expect(service.record(nonExistentWorkspaceId, input)).resolves.not.toThrow();
    await expect(service.record(nonExistentWorkspaceId, input)).resolves.toBeUndefined();
  });

  it("4. record()'s best-effort failure does not affect an unrelated, valid workspace's own ledger", async () => {
    const nonExistentWorkspaceId = randomUUID();
    const realWorkspaceId = await createWorkspace();

    await service.record(nonExistentWorkspaceId, decidedInput({ actionType: 'poison-pill' }));
    await service.record(realWorkspaceId, decidedInput({ actionType: 'unaffected-real-record' }));

    const rows = await service.list(realWorkspaceId, 'member');
    expect(rows.some((row) => row.actionType === 'unaffected-real-record')).toBe(true);
    expect(rows.some((row) => row.actionType === 'poison-pill')).toBe(false);
  });

  it('5. list(workspaceId, "member") succeeds and returns records for that workspace', async () => {
    const workspaceId = await createWorkspace();
    await service.record(workspaceId, decidedInput({ actionType: 'listable-1' }));

    const rows = await service.list(workspaceId, 'member');
    expect(rows.some((row) => row.actionType === 'listable-1')).toBe(true);
  });

  it('6. list(workspaceId, "guest") throws ForbiddenError (guest is below member)', async () => {
    const workspaceId = await createWorkspace();

    await expect(service.list(workspaceId, 'guest')).rejects.toThrow(ForbiddenError);
  });

  it("7. cross-workspace isolation: a record written for workspace A never appears in workspace B's list()", async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();

    await service.record(workspaceIdA, decidedInput({ actionType: 'only-in-a' }));

    const rowsA = await service.list(workspaceIdA, 'member');
    const rowsB = await service.list(workspaceIdB, 'member');

    expect(rowsA.some((row) => row.actionType === 'only-in-a')).toBe(true);
    expect(rowsB.some((row) => row.actionType === 'only-in-a')).toBe(false);
  });

  it('8. get(workspaceId, recordId, "member") fetches a specific record by id', async () => {
    const workspaceId = await createWorkspace();
    const created = await recordAndFetch(workspaceId, decidedInput({ actionType: 'gettable-1' }));

    const fetched = await service.get(workspaceId, created.id, 'member');

    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.actionType).toBe('gettable-1');
  });

  it('9. get() returns null for a non-existent recordId', async () => {
    const workspaceId = await createWorkspace();

    const fetched = await service.get(workspaceId, randomUUID(), 'member');

    expect(fetched).toBeNull();
  });

  it('10. get() returns null for a recordId that belongs to a DIFFERENT workspace (not a data leak)', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const created = await recordAndFetch(
      workspaceIdA,
      decidedInput({ actionType: 'cross-workspace-get-1' }),
    );

    const fetched = await service.get(workspaceIdB, created.id, 'member');

    expect(fetched).toBeNull();
  });

  it('11. get(workspaceId, recordId, "guest") throws ForbiddenError', async () => {
    const workspaceId = await createWorkspace();
    const created = await recordAndFetch(
      workspaceId,
      decidedInput({ actionType: 'guest-forbidden-get-1' }),
    );

    await expect(service.get(workspaceId, created.id, 'guest')).rejects.toThrow(ForbiddenError);
  });

  it('12. rejected/failed DecideActionResult-shaped outcomes are recorded too (outcome:"rejected"/"failed" are not silently dropped)', async () => {
    const workspaceId = await createWorkspace();

    await service.record(
      workspaceId,
      decidedInput({
        actionType: 'rejected-action-1',
        outcome: 'rejected',
        resultRef: null,
        rollbackPlan: {
          kind: 'none',
          description: 'No mutation occurred; the action was rejected.',
        },
      }),
    );
    await service.record(
      workspaceId,
      decidedInput({
        actionType: 'failed-action-1',
        outcome: 'failed',
        resultRef: null,
        rollbackPlan: { kind: 'none', description: 'No mutation occurred; the action failed.' },
      }),
    );

    const rows = await service.list(workspaceId, 'member');
    const rejected = rows.find((row) => row.actionType === 'rejected-action-1');
    const failed = rows.find((row) => row.actionType === 'failed-action-1');

    expect(rejected?.outcome).toBe('rejected');
    expect(rejected?.resultRef).toBeNull();
    expect(failed?.outcome).toBe('failed');
    expect(failed?.resultRef).toBeNull();
  });
});
