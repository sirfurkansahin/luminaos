import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ForbiddenError, NotFoundError, QuotaExceededError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

/**
 * F3-T2 PR2 (RED step), ADR-0036 Karar (f) — `SkillExecutionService`, the
 * ONE integration point between the just-merged `packages/skill-sdk` (PR1,
 * `SkillRegistry`/`signSkillManifest`/`verifySkillManifestSignature`) and
 * F3-T1's already-merged `AgentPermissionManifestsService.checkPermission` +
 * `AgentResourceLimitsService.executeAgentAction` (both `apps/server/src/
 * agent-runtime/`, PR1 #191/PR2 #192/PR3 #193, all merged on `main`).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): NONE of `./skill-execution.service.ts`,
 * `../agent-runtime/agent-permission-manifests.service.ts` (merged, exists),
 * `../agent-runtime/agent-resource-limits.service.ts` (merged, exists) --
 * only `./skill-execution.service.ts` is actually missing as of this commit,
 * so the dynamic `import('./skill-execution.service.js')` call inside
 * `beforeAll` REJECTS ("Cannot find module"), failing every `it` in this
 * file -- mirrors `agent-permission-manifests.service.integration.test.ts`'s
 * and `agent-resource-limits.service.integration.test.ts`'s own documented
 * "service doesn't exist yet" red state.
 *
 * A SECOND, independently expected RED failure mode: `@luminaos/skill-sdk`
 * (PR1, already merged as its own package, `packages/skill-sdk/dist/`
 * already built) is NOT YET a declared dependency of `apps/server/package.
 * json` as of this commit -- adding it (alongside creating `./skill-
 * execution.service.ts` and `./skill-sdk-public-key.ts`) is implementer's
 * job in THIS PR. If pnpm has not linked `@luminaos/skill-sdk` into `apps/
 * server`'s `node_modules` yet, the static imports of `SkillRegistry`/
 * `signSkillManifest` below fail at module resolution BEFORE `beforeAll`
 * even runs -- an equally expected RED reason, NOT a bug in this test file.
 *
 * HARNESS NOTE: Testcontainers Postgres only (no Redis/HTTP) -- mirrors
 * `agent-permission-manifests.service.integration.test.ts`'s lightweight
 * shape (direct `new EventStoreService(db)` / `new ProjectionRunner(db,
 * eventStore)`, no full Nest app boot) PLUS `agent-resource-limits.service.
 * integration.test.ts`'s `env.ts`-singleton dance: `AgentResourceLimitsService`
 * transitively reads `env.agentSandboxTimeoutMs` / `env.
 * agentActionRateLimitPerWindow` / `env.agentActionRateLimitWindowMs` /
 * `env.agentSandboxMaxConcurrentPerAgent`, so every relevant `process.env.*`
 * value is set BEFORE any dynamic import in `beforeAll`, and this file has
 * NO top-level static import of anything that would transitively trigger
 * `env.ts` evaluation earlier.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `SkillExecutionService(skillRegistry: SkillRegistry, agentPermissionManifestsService:
 * AgentPermissionManifestsService, agentResourceLimitsService:
 * AgentResourceLimitsService)`:
 *   - `executeSkill<TInput, TOutput>(workspaceId, agentIdentifier, skillId,
 *     input): Promise<AgentActionResult<TOutput>>` -- EXACT, non-optional
 *     sequence (ADR-0036 Karar f, flagged as a security invariant):
 *       1. `skillRegistry.get(skillId)` -- `undefined` -> throws
 *          `NotFoundError` immediately, before any permission/resource-limit
 *          check.
 *       2. `agentPermissionManifestsService.checkPermission(workspaceId,
 *          agentIdentifier, {actionType: skillId, now: new Date()})` --
 *          `false` -> throws `ForbiddenError`; `skill.execute` MUST NEVER be
 *          called in this case.
 *       3. `agentResourceLimitsService.executeAgentAction(workspaceId,
 *          agentIdentifier, skillId, () => skill.execute(input))` -- the
 *          `AgentActionResult` from this call is returned UNCHANGED.
 * ============================================================================
 */

const AGENT_SANDBOX_TIMEOUT_MS = 500;
const AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT = 10;
const AGENT_ACTION_RATE_LIMIT_PER_WINDOW = 3;
const AGENT_ACTION_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * A field-for-field local re-declaration of `AgentActionResult`
 * (`@luminaos/agent-runtime`, already merged and already a declared
 * dependency of `apps/server`) -- kept local rather than imported so this
 * file's own RED reason stays scoped to `./skill-execution.service.ts` and
 * `@luminaos/skill-sdk`, not an incidental extra static import.
 */
type AgentActionResultLike<T> =
  | { outcome: 'success'; value: T }
  | { outcome: 'timeout' }
  | { outcome: 'failure'; error: unknown };

/**
 * Locally declared contract types for the two already-merged F3-T1
 * services -- NOT re-imported statically here (this file constructs real
 * instances of the actual, already-existing classes below via dynamic
 * import, exactly like its sibling F3-T1 integration test files do for
 * their own not-yet-existing modules), to keep this file's own "what is
 * missing" story limited to `./skill-execution.service.ts` and
 * `@luminaos/skill-sdk`.
 */
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
  ): Promise<{ id: string; agentIdentifier: string }>;
  revoke(
    workspaceId: string,
    agentIdentifier: string,
    actor: Actor,
    callerRole: MembershipRole,
  ): Promise<{ id: string; agentIdentifier: string }>;
}

interface AgentResourceLimitsServiceLike {
  executeAgentAction<T>(
    workspaceId: string,
    agentIdentifier: string,
    actionType: string,
    fn: () => Promise<T>,
  ): Promise<AgentActionResultLike<T>>;
}

type AgentPermissionManifestsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
) => AgentPermissionManifestsServiceLike;

interface AgentConcurrencyGuardContract {
  acquire(key: string): boolean;
  release(key: string): void;
}

type AgentConcurrencyGuardConstructor = new (
  maxConcurrentPerAgent: number,
) => AgentConcurrencyGuardContract;

type AgentResourceLimitsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
  concurrencyGuard: AgentConcurrencyGuardContract,
) => AgentResourceLimitsServiceLike;

interface SkillExecutionServiceLike {
  executeSkill(
    workspaceId: string,
    agentIdentifier: string,
    skillId: string,
    input: unknown,
  ): Promise<AgentActionResultLike<unknown>>;
}

type SkillExecutionServiceConstructor = new (
  skillRegistry: unknown,
  agentPermissionManifestsService: AgentPermissionManifestsServiceLike,
  agentResourceLimitsService: AgentResourceLimitsServiceLike,
) => SkillExecutionServiceLike;

describe('F3-T2 PR2 (RED step): SkillExecutionService — the ONE integration point between SkillRegistry and F3-T1 permission/resource-limit services (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let permissionsService: AgentPermissionManifestsServiceLike;
  let resourceLimitsService: AgentResourceLimitsServiceLike;
  let workspaceCounter = 0;

  // `@luminaos/skill-sdk` types/values are imported LAZILY inside
  // `beforeAll` via dynamic `import()` -- not because the package itself is
  // RED (PR1 is merged, `dist/` already built), but because it is not yet a
  // declared dependency of `apps/server`'s `package.json` as of this commit
  // (see this file's header). Declared here as `unknown`-typed holders,
  // narrowed after the dynamic import resolves.
  let SkillRegistryCtor: new () => {
    register(skill: unknown, publicKeyPem: string): void;
    get(id: string): unknown;
  };
  let signSkillManifestFn: (
    manifest: { id: string; version: string; capability: string },
    privateKeyPem: string,
  ) => string;

  let validKeyPair: { privateKeyPem: string; publicKeyPem: string };

  function generateEd25519Pem(): { privateKeyPem: string; publicKeyPem: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    };
  }

  /**
   * Builds a real, validly-signed test-double skill: `manifest` signed via
   * `signSkillManifest`, `execute` a simple tracked function (increments a
   * call counter, records the last input it was called with, resolves to a
   * fixed value) -- so every test below can assert whether the underlying
   * skill code was EVER actually invoked, independent of the structured
   * `AgentActionResult` `executeSkill` returns.
   */
  function buildTrackedSkill(
    skillId: string,
    fixedReturnValue: unknown,
  ): {
    skill: { manifest: { id: string; version: string; capability: string; signature: string } };
    getCallCount: () => number;
    getLastInput: () => unknown;
  } {
    let callCount = 0;
    let lastInput: unknown;
    const unsigned = {
      id: skillId,
      version: '1.0.0',
      capability: `Test-double skill for ${skillId}`,
    };
    const signature = signSkillManifestFn(unsigned, validKeyPair.privateKeyPem);

    return {
      skill: {
        manifest: { ...unsigned, signature },
        execute: (input: unknown) => {
          callCount += 1;
          lastInput = input;
          return Promise.resolve(fixedReturnValue);
        },
      } as unknown as {
        manifest: { id: string; version: string; capability: string; signature: string };
      },
      getCallCount: () => callCount,
      getLastInput: () => lastInput,
    };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    process.env.DATABASE_URL = connectionString;
    process.env.REDIS_URL = 'redis://skill-execution-test-placeholder:6379';
    process.env.AGENT_SANDBOX_TIMEOUT_MS = String(AGENT_SANDBOX_TIMEOUT_MS);
    process.env.AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT = String(
      AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT,
    );
    process.env.AGENT_ACTION_RATE_LIMIT_PER_WINDOW = String(AGENT_ACTION_RATE_LIMIT_PER_WINDOW);
    process.env.AGENT_ACTION_RATE_LIMIT_WINDOW_MS = String(AGENT_ACTION_RATE_LIMIT_WINDOW_MS);

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);

    // `@luminaos/skill-sdk` -- PR1, already merged, but not yet a declared
    // dependency of `apps/server` (see header). Dynamic import so a
    // still-missing dependency link fails INSIDE `beforeAll`, not as a
    // static-import-time crash of the whole test file.
    const skillSdkModule: unknown = await import('@luminaos/skill-sdk');
    SkillRegistryCtor = (
      skillSdkModule as {
        SkillRegistry: new () => {
          register(skill: unknown, publicKeyPem: string): void;
          get(id: string): unknown;
        };
      }
    ).SkillRegistry;
    signSkillManifestFn = (
      skillSdkModule as {
        signSkillManifest: (
          manifest: { id: string; version: string; capability: string },
          privateKeyPem: string,
        ) => string;
      }
    ).signSkillManifest;

    validKeyPair = generateEd25519Pem();

    // Already-merged F3-T1 services -- dynamically imported anyway, purely
    // to keep this file's construction style uniform and avoid a second,
    // unrelated static-import surface.
    const permissionsModule: unknown =
      await import('../agent-runtime/agent-permission-manifests.service.js');
    const AgentPermissionManifestsServiceCtor = (
      permissionsModule as {
        AgentPermissionManifestsService: AgentPermissionManifestsServiceConstructor;
      }
    ).AgentPermissionManifestsService;
    permissionsService = new AgentPermissionManifestsServiceCtor(db, eventStore, projectionRunner);

    const guardModule: unknown = await import('../agent-runtime/agent-concurrency-guard.js');
    const AgentConcurrencyGuardCtor = (
      guardModule as { AgentConcurrencyGuard: AgentConcurrencyGuardConstructor }
    ).AgentConcurrencyGuard;
    const concurrencyGuard = new AgentConcurrencyGuardCtor(AGENT_SANDBOX_MAX_CONCURRENT_PER_AGENT);

    const resourceLimitsModule: unknown =
      await import('../agent-runtime/agent-resource-limits.service.js');
    const AgentResourceLimitsServiceCtor = (
      resourceLimitsModule as {
        AgentResourceLimitsService: AgentResourceLimitsServiceConstructor;
      }
    ).AgentResourceLimitsService;
    resourceLimitsService = new AgentResourceLimitsServiceCtor(
      db,
      eventStore,
      projectionRunner,
      concurrencyGuard,
    );
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
        name: `skill-execution-test-workspace-${String(workspaceCounter)}`,
        slug: `skill-execution-test-workspace-${String(workspaceCounter)}`,
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

  /**
   * The SOLE call site in this file that dynamically imports `./skill-
   * execution.service.js` -- every `it` below goes through this one helper
   * (given its own fresh `registry`, so each test's test-double skills stay
   * isolated) rather than re-importing per test, keeping this file's own
   * "not yet on disk" RED reason confined to a single, clearly-marked spot.
   */
  async function buildSkillExecutionService(
    registry: InstanceType<typeof SkillRegistryCtor>,
  ): Promise<SkillExecutionServiceLike> {
    const module: unknown = await import('./skill-execution.service.js');
    const SkillExecutionServiceCtor = (
      module as { SkillExecutionService: SkillExecutionServiceConstructor }
    ).SkillExecutionService;
    return new SkillExecutionServiceCtor(registry, permissionsService, resourceLimitsService);
  }

  it("1. no manifest granted at all -> throws ForbiddenError, and the skill's execute is NEVER called", async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = 'skill-exec-no-manifest-agent';
    const registry = new SkillRegistryCtor();
    const tracked = buildTrackedSkill('no-manifest-skill', 'unused');
    registry.register(tracked.skill, validKeyPair.publicKeyPem);

    const service = await buildSkillExecutionService(registry);

    await expect(
      service.executeSkill(workspaceId, agentIdentifier, 'no-manifest-skill', { some: 'input' }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(tracked.getCallCount()).toBe(0);
  });

  it('2. manifest granted with actionTypes including the skillId, unrestricted time window -> resolves {outcome:"success", value}; execute called exactly once with the correct input', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = 'skill-exec-granted-agent';
    const registry = new SkillRegistryCtor();
    const tracked = buildTrackedSkill('granted-skill', { done: true });
    registry.register(tracked.skill, validKeyPair.publicKeyPem);

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['granted-skill'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const service = await buildSkillExecutionService(registry);

    const input = { taskId: 'task-123' };
    const result = await service.executeSkill(workspaceId, agentIdentifier, 'granted-skill', input);

    expect(result).toEqual({ outcome: 'success', value: { done: true } });
    expect(tracked.getCallCount()).toBe(1);
    // `executeSkill` injects the authoritative workspaceId/agentIdentifier
    // into the input it hands to `skill.execute` (F3-T2 PR3 security fix --
    // a skill must never be able to trust a caller-supplied workspaceId in
    // `input` over the one that was actually permission-checked).
    expect(tracked.getLastInput()).toEqual({ ...input, workspaceId, agentIdentifier });
  });

  it('2b. a caller-supplied, SPOOFED workspaceId/agentIdentifier inside input is overridden by the authoritative, permission-checked values -- proves the fix actually closes the workspace-isolation bypass, not just that unrelated fields pass through', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const agentIdentifier = 'skill-exec-spoof-agent';
    const otherAgentIdentifier = 'skill-exec-spoof-other-agent';
    const registry = new SkillRegistryCtor();
    const tracked = buildTrackedSkill('spoof-check-skill', 'ok');
    registry.register(tracked.skill, validKeyPair.publicKeyPem);

    // Permission is granted for (workspaceIdA, agentIdentifier) ONLY.
    await permissionsService.grant(workspaceIdA, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['spoof-check-skill'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const service = await buildSkillExecutionService(registry);

    // The caller passes workspaceIdA/agentIdentifier as executeSkill's own
    // (correctly permission-checked) arguments, but tries to smuggle a
    // DIFFERENT workspaceId/agentIdentifier inside `input` itself.
    const spoofedInput = { workspaceId: workspaceIdB, agentIdentifier: otherAgentIdentifier };
    const result = await service.executeSkill(
      workspaceIdA,
      agentIdentifier,
      'spoof-check-skill',
      spoofedInput,
    );

    expect(result).toEqual({ outcome: 'success', value: 'ok' });
    // The skill must have received the AUTHORITATIVE values, not the
    // attacker-supplied ones -- if the override were missing or the spread
    // order reversed, this would instead see workspaceIdB/otherAgentIdentifier.
    expect(tracked.getLastInput()).toEqual({ workspaceId: workspaceIdA, agentIdentifier });
  });

  it('3. manifest granted then revoked -> throws ForbiddenError, execute never called', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = 'skill-exec-revoked-agent';
    const registry = new SkillRegistryCtor();
    const tracked = buildTrackedSkill('revoked-skill', 'unused');
    registry.register(tracked.skill, validKeyPair.publicKeyPem);

    const actor = fakeActor();
    await permissionsService.grant(workspaceId, actor, 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['revoked-skill'],
      timeWindow: { startsAt: null, expiresAt: null },
    });
    await permissionsService.revoke(workspaceId, agentIdentifier, actor, 'admin');

    const service = await buildSkillExecutionService(registry);

    await expect(
      service.executeSkill(workspaceId, agentIdentifier, 'revoked-skill', {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(tracked.getCallCount()).toBe(0);
  });

  it('4. manifest actionTypes does NOT include this skillId (granted for a different action) -> throws ForbiddenError, execute never called', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = 'skill-exec-wrong-action-agent';
    const registry = new SkillRegistryCtor();
    const tracked = buildTrackedSkill('unauthorized-skill', 'unused');
    registry.register(tracked.skill, validKeyPair.publicKeyPem);

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['some-other-skill'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const service = await buildSkillExecutionService(registry);

    await expect(
      service.executeSkill(workspaceId, agentIdentifier, 'unauthorized-skill', {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(tracked.getCallCount()).toBe(0);
  });

  it('5. manifest time window already expired -> throws ForbiddenError, execute never called', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = 'skill-exec-expired-agent';
    const registry = new SkillRegistryCtor();
    const tracked = buildTrackedSkill('expired-skill', 'unused');
    registry.register(tracked.skill, validKeyPair.publicKeyPem);

    const past = new Date(Date.now() - 60 * 60 * 1000);
    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['expired-skill'],
      timeWindow: { startsAt: null, expiresAt: past },
    });

    const service = await buildSkillExecutionService(registry);

    await expect(
      service.executeSkill(workspaceId, agentIdentifier, 'expired-skill', {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(tracked.getCallCount()).toBe(0);
  });

  it('6. skillId not registered in the SkillRegistry at all -> throws NotFoundError (distinct from ForbiddenError), regardless of whether a manifest exists', async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = 'skill-exec-unregistered-agent';
    const registry = new SkillRegistryCtor();
    // A manifest DOES exist for this agent -- but for a DIFFERENT skillId,
    // never for 'never-registered-skill'.
    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['never-registered-skill'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const service = await buildSkillExecutionService(registry);

    const error = await service
      .executeSkill(workspaceId, agentIdentifier, 'never-registered-skill', {})
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).not.toBeInstanceOf(ForbiddenError);
  });

  it('7. cross-workspace isolation: a manifest granted in workspace A does NOT authorize the same agentIdentifier/skillId in workspace B', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const agentIdentifier = 'skill-exec-cross-workspace-agent';
    const registry = new SkillRegistryCtor();
    const tracked = buildTrackedSkill('cross-workspace-skill', 'unused');
    registry.register(tracked.skill, validKeyPair.publicKeyPem);

    await permissionsService.grant(workspaceIdA, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['cross-workspace-skill'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const service = await buildSkillExecutionService(registry);

    await expect(
      service.executeSkill(workspaceIdB, agentIdentifier, 'cross-workspace-skill', {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(tracked.getCallCount()).toBe(0);

    // Sanity check: workspace A itself still works, proving the rejection
    // above is genuinely about workspace isolation, not a broken grant.
    const resultInA = await service.executeSkill(
      workspaceIdA,
      agentIdentifier,
      'cross-workspace-skill',
      {},
    );
    expect(resultInA).toEqual({ outcome: 'success', value: 'unused' });
  });

  it(`8. no bypass of executeAgentAction's resource limits: after ${String(AGENT_ACTION_RATE_LIMIT_PER_WINDOW)} successful executeSkill calls, the NEXT call throws QuotaExceededError -- proving SkillExecutionService genuinely routes through executeAgentAction`, async () => {
    const workspaceId = await createWorkspace();
    const agentIdentifier = 'skill-exec-rate-limited-agent';
    const registry = new SkillRegistryCtor();
    const tracked = buildTrackedSkill('rate-limited-skill', 'ok');
    registry.register(tracked.skill, validKeyPair.publicKeyPem);

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['rate-limited-skill'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const service = await buildSkillExecutionService(registry);

    for (let i = 0; i < AGENT_ACTION_RATE_LIMIT_PER_WINDOW; i += 1) {
      const result = await service.executeSkill(
        workspaceId,
        agentIdentifier,
        'rate-limited-skill',
        {},
      );
      expect(result).toEqual({ outcome: 'success', value: 'ok' });
    }

    expect(tracked.getCallCount()).toBe(AGENT_ACTION_RATE_LIMIT_PER_WINDOW);

    await expect(
      service.executeSkill(workspaceId, agentIdentifier, 'rate-limited-skill', {}),
    ).rejects.toBeInstanceOf(QuotaExceededError);

    // The call count must be UNCHANGED -- the rejected call's underlying
    // skill.execute was never invoked at all, proving the rate limit was
    // enforced BEFORE skill code ran, exactly like AgentResourceLimitsService's
    // own contract.
    expect(tracked.getCallCount()).toBe(AGENT_ACTION_RATE_LIMIT_PER_WINDOW);
  });
});
