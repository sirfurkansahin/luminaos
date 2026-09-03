import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deriveDeterministicUuid, ForbiddenError, ValidationError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { StoredEvent } from '../event-store/event-store.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

/**
 * F3-T1 PR2 (RED step), ADR-0035 — `AgentPermissionManifestsService`:
 * `grant`/`revoke` (admin+, ADR-0035 Karar d's flat, workspace-wide RBAC —
 * mirrors `AutomationTriggersService`'s `hasAtLeastRole(callerRole, 'admin')`
 * guard, NOT `MemoryAccessPolicyService`'s self-service-by-`req.user.id`
 * shape), `list` (member+, UNFILTERED by `revokedAt` — same audit-value
 * rationale as `MemoryAccessPolicyService.list`), `checkPermission` (no RBAC
 * — an internal read-point for future callers, ADR-0035 Karar e) that pipes
 * the current manifest row through the PURE `evaluateManifestGrant`
 * (`@luminaos/agent-runtime`, PR1, already merged).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./agent-permission-manifests.service.ts` does
 * not exist at all, so the dynamic `import('./agent-permission-manifests.
 * service.js')` call inside `beforeAll` REJECTS ("Cannot find module"),
 * failing every `it` in this file — mirrors `trigger-suggestions.service.
 * integration.test.ts`'s and `ai-usage.service.integration.test.ts`'s own
 * documented "service doesn't exist yet" red state. `agent_permission_
 * manifests` (schema + migration `0037_*`, also not yet on disk) is likewise
 * expected missing — this file's `beforeAll` will fail at `runMigrations`
 * resolving no new migration, or at the dynamic import, whichever the
 * implementer lands first; either is an acceptable RED failure mode, NOT a
 * bug in this test file.
 *
 * HARNESS NOTE: Testcontainers Postgres only (no Redis/HTTP) — this service
 * has no AI-gateway/webhook collaborator, so the lightweight harness
 * (`ai-usage.service.integration.test.ts`'s/`trigger-suggestions.service.
 * integration.test.ts`'s "direct `new EventStoreService(db)` / `new
 * ProjectionRunner(db, eventStore)`, no full Nest app boot" shape) applies
 * directly, without needing any `REDIS_URL` placeholder dance (this service
 * has no transitive `../config/env.ts` dependency).
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `AgentPermissionManifestsService(db, eventStore, projectionRunner)`:
 *   - `grant(workspaceId, actor, callerRole, input: {agentIdentifier,
 *     dataScope, actionTypes, timeWindow}): Promise<AgentPermissionManifest>`
 *     — admin+ (else `ForbiddenError`), calls `assertValidManifestGrant`
 *     FIRST (an invalid input throws `ValidationError` before any event is
 *     written), writes `AgentPermissionGranted` with actor `{type:'user',
 *     id: actor.id}` (ADR-0035 Karar i — the REAL granting admin, not a fixed
 *     system actor), UPSERTS on `(workspaceId, agentIdentifier)` (no second
 *     row on re-grant), resets `revokedAt` to `null` on re-grant.
 *   - `revoke(workspaceId, agentIdentifier, actor, callerRole):
 *     Promise<AgentPermissionManifest>` — admin+ (else `ForbiddenError`),
 *     writes `AgentPermissionRevoked` (same actor convention), sets
 *     `revokedAt`, does NOT physically delete the row.
 *   - `list(workspaceId, callerRole): Promise<AgentPermissionManifest[]>` —
 *     member+ (else `ForbiddenError`), ALL rows for `workspaceId`
 *     UNFILTERED by `revokedAt`.
 *   - `checkPermission(workspaceId, agentIdentifier, request: {actionType,
 *     objectType?, now}): Promise<boolean>` — NO RBAC parameter at all;
 *     looks up the current `(workspaceId, agentIdentifier)` row (or
 *     `undefined` if none exists) and delegates to the pure
 *     `evaluateManifestGrant` from `@luminaos/agent-runtime`.
 *
 * Deterministic per-`(workspaceId, agentIdentifier)` `streamId` derivation
 * mirrors `MemoryAccessPolicyService.streamIdFor` exactly (ADR-0035's closest
 * precedent, per its own §b/§d) — `deriveDeterministicUuid(NAMESPACE,
 * `${workspaceId}:${agentIdentifier}`)`. `agent_permission_manifests` has NO
 * `streamId` column (ADR-0035's own pinned schema, unlike `automation_
 * triggers`), so this MUST be a deterministic re-derivation, not a stored
 * lookup — a fixed, arbitrary namespace UUID is pinned below as
 * `AGENT_PERMISSION_MANIFEST_UUID_NAMESPACE`; implementer's own service-side
 * constant of the same name/value is what test #12 (event-log visibility)
 * independently verifies against.
 * ============================================================================
 */

/**
 * Pinned as this test file's OWN contract value — implementer's
 * `agent-permission-manifests.service.ts` MUST use this EXACT literal as its
 * `AGENT_PERMISSION_MANIFEST_UUID_NAMESPACE` constant (mirrors `memory-
 * access-policies.integration.test.ts`'s identical convention for
 * `MEMORY_ACCESS_POLICY_UUID_NAMESPACE`). MUST NEVER change once real data
 * exists.
 */
const AGENT_PERMISSION_MANIFEST_UUID_NAMESPACE = 'f4a1c8d2-9e3b-4a77-8c1d-2b6e9a0f5c31';

/**
 * A field-for-field local copy of `@luminaos/agent-runtime`'s
 * `AgentPermissionManifest` (PR1, already merged) — declared locally rather
 * than imported, mirroring `trigger-suggestions.service.integration.test.ts`'s
 * `TriggerTemplateSuggestionSummary` convention: `@luminaos/agent-runtime` is
 * not yet a declared dependency of `apps/server`'s `package.json` (that's
 * implementer's job in this PR, alongside the service itself), so a static
 * import of it here would itself be an unresolved-module error, cascading
 * into unrelated `no-unsafe-*` lint noise across this whole file.
 */
interface AgentPermissionManifestContract {
  id: string;
  workspaceId: string;
  agentIdentifier: string;
  dataScope: { objectTypes: string[] | 'all' };
  actionTypes: string[];
  timeWindow: { startsAt: Date | null; expiresAt: Date | null };
  grantedAt: Date;
  revokedAt: Date | null;
}

interface AgentPermissionManifestsServiceLike {
  grant(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: {
      agentIdentifier: string;
      dataScope: { objectTypes: string[] | 'all' };
      actionTypes: string[];
      timeWindow: { startsAt: Date | null; expiresAt: Date | null };
    },
  ): Promise<AgentPermissionManifestContract>;
  revoke(
    workspaceId: string,
    agentIdentifier: string,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<AgentPermissionManifestContract>;
  list(workspaceId: string, callerRole: MembershipRole): Promise<AgentPermissionManifestContract[]>;
  checkPermission(
    workspaceId: string,
    agentIdentifier: string,
    request: { actionType: string; objectType?: string; now: Date },
  ): Promise<boolean>;
}

type AgentPermissionManifestsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
) => AgentPermissionManifestsServiceLike;

describe('F3-T1 PR2 (RED step): AgentPermissionManifestsService — event-sourced, workspace-scoped agent runtime permission grant/revoke (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let service: AgentPermissionManifestsServiceLike;
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
    // modules (`trigger-suggestions.service.integration.test.ts`,
    // `ai-usage.service.integration.test.ts`).
    const serviceModule: unknown = await import('./agent-permission-manifests.service.js');
    const AgentPermissionManifestsServiceCtor = (
      serviceModule as {
        AgentPermissionManifestsService: AgentPermissionManifestsServiceConstructor;
      }
    ).AgentPermissionManifestsService;

    service = new AgentPermissionManifestsServiceCtor(db, eventStore, projectionRunner);
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
        name: `agent-permission-manifest-test-workspace-${String(workspaceCounter)}`,
        slug: `agent-permission-manifest-test-workspace-${String(workspaceCounter)}`,
      })
      .returning({ id: workspaces.id });
    if (!row) {
      throw new Error('Failed to create test workspace');
    }
    return row.id;
  }

  function fakeActor(): Actor {
    return { type: 'user', id: randomUUID() };
  }

  function allScopeGrantInput(
    agentIdentifier: string,
    overrides?: {
      actionTypes?: string[];
      dataScope?: { objectTypes: string[] | 'all' };
      timeWindow?: { startsAt: Date | null; expiresAt: Date | null };
    },
  ) {
    return {
      agentIdentifier,
      dataScope: overrides?.dataScope ?? { objectTypes: 'all' as const },
      actionTypes: overrides?.actionTypes ?? ['read-task'],
      timeWindow: overrides?.timeWindow ?? { startsAt: null, expiresAt: null },
    };
  }

  it('1. grant by an admin succeeds and returns an AgentPermissionManifest with the expected fields', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();

    const manifest = await service.grant(
      workspaceId,
      actor,
      'admin',
      allScopeGrantInput('summarizer-agent'),
    );

    expect(manifest.id).toBeDefined();
    expect(typeof manifest.id).toBe('string');
    expect(manifest.workspaceId).toBe(workspaceId);
    expect(manifest.agentIdentifier).toBe('summarizer-agent');
    expect(manifest.dataScope).toEqual({ objectTypes: 'all' });
    expect(manifest.actionTypes).toEqual(['read-task']);
    expect(manifest.timeWindow).toEqual({ startsAt: null, expiresAt: null });
    expect(manifest.grantedAt).toBeDefined();
    expect(manifest.revokedAt).toBeNull();
  });

  it('2. grant by a "member" (not admin) throws ForbiddenError', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();

    await expect(
      service.grant(workspaceId, actor, 'member', allScopeGrantInput('summarizer-agent')),
    ).rejects.toThrow(ForbiddenError);
  });

  it('3. grant with invalid input (empty actionTypes) throws ValidationError -- assertValidManifestGrant is called before any event is written', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();

    await expect(
      service.grant(
        workspaceId,
        actor,
        'admin',
        allScopeGrantInput('summarizer-agent', { actionTypes: [] }),
      ),
    ).rejects.toThrow(ValidationError);

    const manifests = await service.list(workspaceId, 'member');
    expect(manifests.some((m) => m.agentIdentifier === 'summarizer-agent')).toBe(false);
  });

  it('4. revoke by a "member" (not admin) throws ForbiddenError; revoke by admin succeeds and sets revokedAt', async () => {
    const workspaceId = await createWorkspace();
    const adminActor = fakeActor();
    await service.grant(workspaceId, adminActor, 'admin', allScopeGrantInput('summarizer-agent'));

    await expect(
      service.revoke(workspaceId, 'summarizer-agent', fakeActor(), 'member'),
    ).rejects.toThrow(ForbiddenError);

    const revoked = await service.revoke(workspaceId, 'summarizer-agent', adminActor, 'admin');
    expect(revoked.agentIdentifier).toBe('summarizer-agent');
    expect(revoked.revokedAt).toBeDefined();
    expect(revoked.revokedAt).not.toBeNull();
  });

  it('5. list is callable by a "member" (no throw) and returns granted manifests', async () => {
    const workspaceId = await createWorkspace();
    await service.grant(workspaceId, fakeActor(), 'admin', allScopeGrantInput('summarizer-agent'));

    const manifests = await service.list(workspaceId, 'member');
    expect(manifests.some((m) => m.agentIdentifier === 'summarizer-agent')).toBe(true);
  });

  it("6. cross-workspace isolation: a manifest granted in workspace A does not appear in workspace B's list, and checkPermission against workspace B returns false", async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();

    await service.grant(workspaceIdA, fakeActor(), 'admin', allScopeGrantInput('summarizer-agent'));

    const listInB = await service.list(workspaceIdB, 'member');
    expect(listInB.some((m) => m.agentIdentifier === 'summarizer-agent')).toBe(false);

    const allowedInB = await service.checkPermission(workspaceIdB, 'summarizer-agent', {
      actionType: 'read-task',
      now: new Date(),
    });
    expect(allowedInB).toBe(false);
  });

  it('7. grant -> revoke -> re-grant is an UPSERT: revokedAt resets to null, dataScope/actionTypes/timeWindow reflect the new grant, and exactly one row exists for that agent', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();

    await service.grant(
      workspaceId,
      actor,
      'admin',
      allScopeGrantInput('summarizer-agent', { actionTypes: ['read-task'] }),
    );
    await service.revoke(workspaceId, 'summarizer-agent', actor, 'admin');

    const reGranted = await service.grant(
      workspaceId,
      actor,
      'admin',
      allScopeGrantInput('summarizer-agent', {
        actionTypes: ['write-task'],
        dataScope: { objectTypes: ['task'] },
      }),
    );

    expect(reGranted.revokedAt).toBeNull();
    expect(reGranted.actionTypes).toEqual(['write-task']);
    expect(reGranted.dataScope).toEqual({ objectTypes: ['task'] });

    const manifests = await service.list(workspaceId, 'member');
    const matching = manifests.filter((m) => m.agentIdentifier === 'summarizer-agent');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.revokedAt).toBeNull();
    expect(matching[0]?.actionTypes).toEqual(['write-task']);
  });

  it('8. checkPermission end-to-end: true after a real grant matching the request, false after revoke, false for a never-granted agentIdentifier', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();
    const now = new Date();

    const neverGranted = await service.checkPermission(workspaceId, 'ghost-agent', {
      actionType: 'read-task',
      now,
    });
    expect(neverGranted).toBe(false);

    await service.grant(
      workspaceId,
      actor,
      'admin',
      allScopeGrantInput('summarizer-agent', { actionTypes: ['read-task'] }),
    );

    const allowed = await service.checkPermission(workspaceId, 'summarizer-agent', {
      actionType: 'read-task',
      now,
    });
    expect(allowed).toBe(true);

    await service.revoke(workspaceId, 'summarizer-agent', actor, 'admin');

    const disallowedAfterRevoke = await service.checkPermission(workspaceId, 'summarizer-agent', {
      actionType: 'read-task',
      now,
    });
    expect(disallowedAfterRevoke).toBe(false);
  });

  it('9. checkPermission respects a future startsAt: now before startsAt returns false', async () => {
    const workspaceId = await createWorkspace();
    const future = new Date(Date.now() + 60 * 60 * 1000);

    await service.grant(
      workspaceId,
      fakeActor(),
      'admin',
      allScopeGrantInput('summarizer-agent', {
        actionTypes: ['read-task'],
        timeWindow: { startsAt: future, expiresAt: null },
      }),
    );

    const allowed = await service.checkPermission(workspaceId, 'summarizer-agent', {
      actionType: 'read-task',
      now: new Date(),
    });
    expect(allowed).toBe(false);
  });

  it('10. checkPermission respects a past expiresAt: now after expiresAt returns false', async () => {
    const workspaceId = await createWorkspace();
    const past = new Date(Date.now() - 60 * 60 * 1000);

    await service.grant(
      workspaceId,
      fakeActor(),
      'admin',
      allScopeGrantInput('summarizer-agent', {
        actionTypes: ['read-task'],
        timeWindow: { startsAt: null, expiresAt: past },
      }),
    );

    const allowed = await service.checkPermission(workspaceId, 'summarizer-agent', {
      actionType: 'read-task',
      now: new Date(),
    });
    expect(allowed).toBe(false);
  });

  it('11. checkPermission returns false for a mismatched actionType even when a manifest exists and is otherwise valid', async () => {
    const workspaceId = await createWorkspace();

    await service.grant(
      workspaceId,
      fakeActor(),
      'admin',
      allScopeGrantInput('summarizer-agent', { actionTypes: ['read-task'] }),
    );

    const allowed = await service.checkPermission(workspaceId, 'summarizer-agent', {
      actionType: 'delete-task',
      now: new Date(),
    });
    expect(allowed).toBe(false);
  });

  it('12. event-log visibility: grant/revoke append AgentPermissionGranted/AgentPermissionRevoked to the deterministic per-(workspace,agentIdentifier) stream, actor is the real granting admin', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();

    await service.grant(
      workspaceId,
      actor,
      'admin',
      allScopeGrantInput('summarizer-agent', { actionTypes: ['read-task'] }),
    );

    const expectedStreamId = deriveDeterministicUuid(
      AGENT_PERMISSION_MANIFEST_UUID_NAMESPACE,
      `${workspaceId}:summarizer-agent`,
    );

    let streamEvents: StoredEvent[] = await eventStore.readStream(expectedStreamId);
    expect(streamEvents).toHaveLength(1);
    expect(streamEvents[0]?.type).toBe('AgentPermissionGranted');
    expect(streamEvents[0]?.actor).toEqual({ type: 'user', id: actor.id });
    expect(streamEvents[0]?.payload['agentIdentifier']).toBe('summarizer-agent');

    await service.revoke(workspaceId, 'summarizer-agent', actor, 'admin');

    streamEvents = await eventStore.readStream(expectedStreamId);
    expect(streamEvents).toHaveLength(2);
    expect(streamEvents[1]?.type).toBe('AgentPermissionRevoked');
    expect(streamEvents[1]?.actor).toEqual({ type: 'user', id: actor.id });
  });
});
