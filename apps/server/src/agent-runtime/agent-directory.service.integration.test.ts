import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConflictError, ForbiddenError, NotFoundError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

/**
 * F3-T3 PR1 (RED step), ADR-0037 Karar (b) -- `AgentDirectoryService`: a
 * flat, event-sourced CRUD entity mirroring `AutomationTriggersService`'s
 * exact shape (own `STREAM_TYPE='agent'`, a FRESH `randomUUID()` stream per
 * new agent -- NOT a deterministic per-key stream like
 * `AgentPermissionManifestsService`'s, since Agent is a freshly-minted
 * identity, not a toggle), `admin`+ write / `member`+ read flat RBAC via
 * `hasAtLeastRole`, a `lifecycle: 'active'|'deactivated'` soft-delete field,
 * and a `list()` filtered to `active` only.
 *
 * `register`/`deactivate` -- admin+ (`ForbiddenError` below admin);
 * `register` throws `ConflictError` when `(workspaceId, name)`
 * (case-insensitive) or `(workspaceId, agentIdentifier)` already has an
 * ACTIVE row. `deactivate` with a cross-workspace `agentId` throws
 * `NotFoundError` (mirrors `AutomationTriggersService.lookupStreamId`'s
 * `NotFoundError`-on-cross-workspace-lookup discipline, not a distinguishable
 * 403). `list` -- member+, ACTIVE rows only, workspace-scoped.
 * `resolveByName` -- NO RBAC parameter at all (mirrors
 * `AgentPermissionManifestsService.checkPermission`'s own no-RBAC internal
 * read-point convention), case-insensitive, ACTIVE only.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./agent-directory.service.ts` does not exist
 * at all, so the dynamic `import('./agent-directory.service.js')` call
 * inside `beforeAll` REJECTS ("Cannot find module"), failing every `it` in
 * this file -- mirrors `agent-permission-manifests.service.integration.
 * test.ts`'s own documented "service doesn't exist yet" red state. The
 * `agents` table (schema + migration, also not yet on disk -- confirmed no
 * `db/schema/agents.ts` file exists) is likewise expected missing -- this
 * file's `beforeAll` will fail at `runMigrations` resolving no relevant
 * migration/table, or at the dynamic import, whichever the implementer lands
 * first; either is an acceptable RED failure mode, NOT a bug in this test
 * file.
 *
 * HARNESS NOTE: Testcontainers Postgres only (no Redis/HTTP) -- this entity
 * has no AI-gateway/embedding/webhook collaborator, so the lightweight
 * harness (`agent-permission-manifests.service.integration.test.ts`'s
 * "direct `new EventStoreService(db)` / `new ProjectionRunner(db,
 * eventStore)`, no full Nest app boot" shape) applies directly.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `AgentDirectoryService(db, eventStore, projectionRunner)`:
 *   - `register(workspaceId, actor, callerRole, input: {name,
 *     agentIdentifier}): Promise<Agent>` -- admin+ (else `ForbiddenError`);
 *     `ConflictError` if `(workspaceId, name)` (case-insensitive) or
 *     `(workspaceId, agentIdentifier)` already has an ACTIVE row. Returns
 *     `lifecycle: 'active'`.
 *   - `deactivate(workspaceId, agentId, actor, callerRole): Promise<Agent>`
 *     -- admin+ (else `ForbiddenError`); a cross-workspace `agentId` throws
 *     `NotFoundError`.
 *   - `list(workspaceId, callerRole): Promise<Agent[]>` -- member+ (else
 *     `ForbiddenError`); ACTIVE rows only, workspace-scoped.
 *   - `resolveByName(workspaceId, name): Promise<Agent | null>` -- NO RBAC
 *     parameter; case-insensitive match; ACTIVE only; workspace-scoped.
 * ============================================================================
 */

/**
 * A field-for-field local copy of the `Agent` shape pinned by ADR-0037 Karar
 * (b) -- declared locally rather than imported, mirroring
 * `agent-permission-manifests.service.integration.test.ts`'s
 * `AgentPermissionManifestContract` convention: `agent-directory.service.ts`
 * does not exist yet, so a static import of its exported type here would
 * itself be an unresolved-module error.
 */
interface AgentContract {
  id: string;
  workspaceId: string;
  name: string;
  agentIdentifier: string;
  lifecycle: 'active' | 'deactivated';
  createdAt: Date;
}

interface AgentDirectoryServiceLike {
  register(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: { name: string; agentIdentifier: string },
  ): Promise<AgentContract>;
  deactivate(
    workspaceId: string,
    agentId: string,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<AgentContract>;
  list(workspaceId: string, callerRole: MembershipRole): Promise<AgentContract[]>;
  resolveByName(workspaceId: string, name: string): Promise<AgentContract | null>;
}

type AgentDirectoryServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
) => AgentDirectoryServiceLike;

describe('F3-T3 PR1 (RED step): AgentDirectoryService — flat event-sourced agent directory entity (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let service: AgentDirectoryServiceLike;
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
    // modules (`agent-permission-manifests.service.integration.test.ts`). This
    // contains the resulting `import-x/no-unresolved` finding to this one
    // line, instead of cascading into a static-import failure across the
    // whole file (same documented convention as `ai-usage.service.
    // integration.test.ts`, `commands.service.integration.test.ts`, etc.).
    const serviceModule: unknown = await import('./agent-directory.service.js');
    const AgentDirectoryServiceCtor = (
      serviceModule as { AgentDirectoryService: AgentDirectoryServiceConstructor }
    ).AgentDirectoryService;

    service = new AgentDirectoryServiceCtor(db, eventStore, projectionRunner);
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
        name: `agent-directory-test-workspace-${String(workspaceCounter)}`,
        slug: `agent-directory-test-workspace-${String(workspaceCounter)}`,
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

  it('1. register by an admin succeeds and returns an Agent with the expected shape and lifecycle active', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();

    const agent = await service.register(workspaceId, actor, 'admin', {
      name: 'Research-Bot',
      agentIdentifier: 'research-bot-v1',
    });

    expect(agent.id).toBeDefined();
    expect(typeof agent.id).toBe('string');
    expect(agent.workspaceId).toBe(workspaceId);
    expect(agent.name).toBe('Research-Bot');
    expect(agent.agentIdentifier).toBe('research-bot-v1');
    expect(agent.lifecycle).toBe('active');
    expect(agent.createdAt).toBeDefined();
  });

  it('2. register by a "member" (not admin) throws ForbiddenError, and no row is created', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();

    await expect(
      service.register(workspaceId, actor, 'member', {
        name: 'Research-Bot',
        agentIdentifier: 'research-bot-v1',
      }),
    ).rejects.toThrow(ForbiddenError);

    const agents = await service.list(workspaceId, 'admin');
    expect(agents).toHaveLength(0);
  });

  it('3. register with a colliding name (exact match) against an existing ACTIVE agent in the same workspace throws ConflictError', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();
    await service.register(workspaceId, actor, 'admin', {
      name: 'Research-Bot',
      agentIdentifier: 'research-bot-v1',
    });

    await expect(
      service.register(workspaceId, actor, 'admin', {
        name: 'Research-Bot',
        agentIdentifier: 'research-bot-v2',
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('3b. register with a colliding name (different case) against an existing ACTIVE agent in the same workspace throws ConflictError', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();
    await service.register(workspaceId, actor, 'admin', {
      name: 'Research-Bot',
      agentIdentifier: 'research-bot-v1',
    });

    await expect(
      service.register(workspaceId, actor, 'admin', {
        name: 'research-bot',
        agentIdentifier: 'research-bot-v2',
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('4. register with a colliding agentIdentifier against an existing ACTIVE agent in the same workspace throws ConflictError, even when name differs', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();
    await service.register(workspaceId, actor, 'admin', {
      name: 'Research-Bot',
      agentIdentifier: 'research-bot-v1',
    });

    await expect(
      service.register(workspaceId, actor, 'admin', {
        name: 'Support-Bot',
        agentIdentifier: 'research-bot-v1',
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('5. the same name/agentIdentifier used in a DIFFERENT workspace does not conflict (per-workspace uniqueness)', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const actor = fakeActor();

    await service.register(workspaceIdA, actor, 'admin', {
      name: 'Research-Bot',
      agentIdentifier: 'research-bot-v1',
    });

    const agentInB = await service.register(workspaceIdB, actor, 'admin', {
      name: 'Research-Bot',
      agentIdentifier: 'research-bot-v1',
    });

    expect(agentInB.workspaceId).toBe(workspaceIdB);
    expect(agentInB.name).toBe('Research-Bot');
  });

  it('6. list returns only active agents for the given workspace, excludes other workspaces and deactivated agents', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const actor = fakeActor();

    const keep = await service.register(workspaceIdA, actor, 'admin', {
      name: 'Keep-Bot',
      agentIdentifier: 'keep-bot',
    });
    const toDeactivate = await service.register(workspaceIdA, actor, 'admin', {
      name: 'Gone-Bot',
      agentIdentifier: 'gone-bot',
    });
    await service.register(workspaceIdB, actor, 'admin', {
      name: 'Other-Workspace-Bot',
      agentIdentifier: 'other-workspace-bot',
    });

    await service.deactivate(workspaceIdA, toDeactivate.id, actor, 'admin');

    const listedA = await service.list(workspaceIdA, 'member');
    expect(listedA).toHaveLength(1);
    expect(listedA[0]?.id).toBe(keep.id);
    expect(listedA.some((a) => a.id === toDeactivate.id)).toBe(false);
  });

  it('7. list is callable by a "member"-role caller (read is member+, not admin+)', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();
    await service.register(workspaceId, actor, 'admin', {
      name: 'Research-Bot',
      agentIdentifier: 'research-bot-v1',
    });

    await expect(service.list(workspaceId, 'member')).resolves.not.toThrow();
    const agents = await service.list(workspaceId, 'member');
    expect(agents.some((a) => a.agentIdentifier === 'research-bot-v1')).toBe(true);
  });

  it('8. deactivate by admin sets lifecycle to deactivated, and a subsequent list no longer includes it', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();
    const agent = await service.register(workspaceId, actor, 'admin', {
      name: 'Research-Bot',
      agentIdentifier: 'research-bot-v1',
    });

    const deactivated = await service.deactivate(workspaceId, agent.id, actor, 'admin');
    expect(deactivated.lifecycle).toBe('deactivated');

    const agents = await service.list(workspaceId, 'member');
    expect(agents.some((a) => a.id === agent.id)).toBe(false);
  });

  it('9. deactivate by a "member"-role caller throws ForbiddenError', async () => {
    const workspaceId = await createWorkspace();
    const adminActor = fakeActor();
    const agent = await service.register(workspaceId, adminActor, 'admin', {
      name: 'Research-Bot',
      agentIdentifier: 'research-bot-v1',
    });

    await expect(service.deactivate(workspaceId, agent.id, fakeActor(), 'member')).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('10. deactivate with an agentId belonging to a DIFFERENT workspace throws NotFoundError, and the original workspace agent is left untouched', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const actor = fakeActor();
    const agentInA = await service.register(workspaceIdA, actor, 'admin', {
      name: 'Research-Bot',
      agentIdentifier: 'research-bot-v1',
    });

    await expect(service.deactivate(workspaceIdB, agentInA.id, actor, 'admin')).rejects.toThrow(
      NotFoundError,
    );

    const listedA = await service.list(workspaceIdA, 'member');
    const stillActive = listedA.find((a) => a.id === agentInA.id);
    expect(stillActive).toBeDefined();
    expect(stillActive?.lifecycle).toBe('active');
  });

  it('11. resolveByName finds an active agent by exact name and by a differently-cased variant', async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();
    const agent = await service.register(workspaceId, actor, 'admin', {
      name: 'Research-Bot',
      agentIdentifier: 'research-bot-v1',
    });

    const exact = await service.resolveByName(workspaceId, 'Research-Bot');
    expect(exact?.id).toBe(agent.id);

    const differentCase = await service.resolveByName(workspaceId, 'research-bot');
    expect(differentCase?.id).toBe(agent.id);
  });

  it('12. resolveByName returns null for a non-existent name', async () => {
    const workspaceId = await createWorkspace();

    const resolved = await service.resolveByName(workspaceId, 'Nonexistent-Bot');
    expect(resolved).toBeNull();
  });

  it("13. resolveByName returns null for a DEACTIVATED agent's name (not mention-resolvable)", async () => {
    const workspaceId = await createWorkspace();
    const actor = fakeActor();
    const agent = await service.register(workspaceId, actor, 'admin', {
      name: 'Research-Bot',
      agentIdentifier: 'research-bot-v1',
    });

    await service.deactivate(workspaceId, agent.id, actor, 'admin');

    const resolved = await service.resolveByName(workspaceId, 'Research-Bot');
    expect(resolved).toBeNull();
  });

  it('14. resolveByName is workspace-scoped -- the same name registered in workspace A does not resolve when queried against workspace B', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const actor = fakeActor();

    await service.register(workspaceIdA, actor, 'admin', {
      name: 'Research-Bot',
      agentIdentifier: 'research-bot-v1',
    });

    const resolvedInB = await service.resolveByName(workspaceIdB, 'Research-Bot');
    expect(resolvedInB).toBeNull();
  });
});
