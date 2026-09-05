import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newObjectId } from '@luminaos/core-objects';
import { ForbiddenError, NotFoundError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { AgentDirectoryService } from '../agent-runtime/agent-directory.service.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { objectsView } from '../db/schema/objects-view.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

/**
 * F3-T3 PR2 (RED step), ADR-0037 Karar (c) -- `CommentsService`: schema +
 * CRUD for the new, purpose-built `object_comments` @mention surface on top
 * of Lumina Objects. Mention -> skill-execution wiring is explicitly OUT of
 * scope here (that's PR3's `MentionActionWorker`) -- this PR only parses,
 * resolves-and-snapshots, and stores `mentionedAgentIds`; nothing is EVER
 * executed as a result of a mention in this PR.
 *
 * RBAC (spec `Kabul Kriterleri` line "Yorum oluşturma: var olmayan nesnede
 * 404; member+ RBAC"; ADR-0037 RBAC özeti: "Yorum oluştur/listele = member+"):
 * `create`/`list` both require `hasAtLeastRole(callerRole, 'member')` --
 * i.e. `member`/`admin`/`owner` are allowed, only `guest` (below `member`)
 * is rejected with `ForbiddenError`. This mirrors `AgentDirectoryService
 * .list`'s own member+ read gate exactly -- there is no admin-only cutoff
 * anywhere in the comments surface per ADR-0037 §(c).
 *
 * Mention resolution (ADR-0037 §(c)): `body` is scanned with the FIXED regex
 * `/@([A-Za-z0-9_-]{2,32})\b/g` (the exact same handle character class as
 * `registerAgentSchema`'s `^[A-Za-z0-9_-]{2,32}$`,
 * `apps/server/src/agent-runtime/dto/register-agent.schema.ts`), each
 * candidate handle is resolved via the ALREADY-MERGED
 * `AgentDirectoryService.resolveByName(workspaceId, name)` (case-insensitive,
 * active-only, workspace-scoped, no RBAC), and the resolved agent id(s) are
 * embedded into the comment as a creation-time SNAPSHOT
 * (`mentionedAgentIds: string[]`) -- never a live/dynamic reference. A
 * candidate handle that does not resolve to any active agent in this
 * workspace is SILENTLY ignored: no error, no entry in `mentionedAgentIds`,
 * and the comment is still created successfully (`applyAssigneeHint`'s
 * "best-effort, never block the main action" precedent, per ADR-0037 §(c)).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): neither `./object-comments.service.ts` nor
 * `db/schema/object-comments.ts` exist yet (confirmed via repo grep before
 * writing this file) -- the dynamic `import('./object-comments.service.js')`
 * call inside `beforeAll` REJECTS ("Cannot find module"), failing every `it`
 * in this file, mirroring `agent-directory.service.integration.test.ts`'s own
 * documented "service doesn't exist yet" RED state for PR1. `runMigrations`
 * is expected to succeed (the `agents` table/migration from PR1 is already on
 * disk and merged), but reading/writing an `object_comments` table will fail
 * once the implementer's own migration is added -- whichever failure mode the
 * implementer hits first (missing module vs. missing table) is an acceptable
 * RED failure, NOT a bug in this test file.
 *
 * HARNESS: Testcontainers Postgres 16 ONLY (no Redis/HTTP) -- this service's
 * only real collaborators are the database and the already-merged, already
 * directly-constructible `AgentDirectoryService` (itself DB-only, no
 * AI-gateway/webhook/embedding dependency) -- same lightweight-harness
 * rationale as `agent-directory.service.integration.test.ts`. A real Lumina
 * Object row is required for the "create on an existing/non-existent
 * objectId" assertions below; rather than driving the full
 * `ObjectsService.create` dependency chain (AI provider, task-recurrence,
 * timeblock-push, search-index scheduler/embedding services -- unrelated
 * machinery for a comments test), this file follows
 * `trigger-condition-evaluator.service.integration.test.ts`'s own established
 * "lightweight `insertObject` helper: direct `db.insert(objectsView)`"
 * precedent to seed a minimal, valid `objects_view` row directly.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *
 * `CommentsService(db, eventStore, projectionRunner, agentDirectoryService)`:
 *   - `create(workspaceId, actor, callerRole, { objectId, body }):
 *     Promise<ObjectComment>` -- member+ (else `ForbiddenError`); the
 *     referenced `objectId` must exist in THIS workspace, else
 *     `NotFoundError` (mirrors `ObjectsService.lookupStreamId`'s exact
 *     workspace+id-scoped 404 discipline); scans `body` for `@handle`
 *     candidates, resolves each via `agentDirectoryService.resolveByName`,
 *     silently drops unresolved handles, and stores the resolved id list as
 *     `mentionedAgentIds` on the created row.
 *   - `list(workspaceId, callerRole, objectId): Promise<ObjectComment[]>` --
 *     member+ (else `ForbiddenError`); the referenced `objectId` must exist
 *     in THIS workspace, else `NotFoundError`; returns every comment for
 *     that `(workspaceId, objectId)` pair in creation order (oldest first).
 * ============================================================================
 */

/**
 * A field-for-field local copy of the `ObjectComment` shape pinned by
 * ADR-0037 Karar (c) -- declared locally (not imported), same
 * "`object-comments.service.ts` does not exist yet, so a static import of its
 * exported type here would itself be an unresolved-module error" reasoning as
 * `agent-directory.service.integration.test.ts`'s own `AgentContract`.
 */
interface ObjectCommentContract {
  id: string;
  workspaceId: string;
  objectId: string;
  authorActor: Actor;
  body: string;
  mentionedAgentIds: string[];
  createdAt: Date;
}

interface CreateCommentInput {
  objectId: string;
  body: string;
}

interface CommentsServiceLike {
  create(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: CreateCommentInput,
  ): Promise<ObjectCommentContract>;
  list(
    workspaceId: string,
    callerRole: MembershipRole,
    objectId: string,
  ): Promise<ObjectCommentContract[]>;
}

type CommentsServiceConstructor = new (
  db: Database,
  eventStore: EventStoreService,
  projectionRunner: ProjectionRunner,
  agentDirectoryService: AgentDirectoryService,
) => CommentsServiceLike;

describe('F3-T3 PR2 (RED step): CommentsService — object_comments schema + CRUD + creation-time @mention resolution/snapshot, no execution (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let agentDirectoryService: AgentDirectoryService;
  let service: CommentsServiceLike;
  let workspaceCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();
    process.env.DATABASE_URL = connectionString;

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);
    agentDirectoryService = new AgentDirectoryService(db, eventStore, projectionRunner);

    // Imported dynamically, not statically at the top of this file -- the
    // established "does not exist yet" RED-step convention (see
    // `agent-directory.service.integration.test.ts`). Contains the resulting
    // `import-x/no-unresolved` finding to this one line.
    const serviceModule: unknown = await import('./object-comments.service.js');
    const CommentsServiceCtor = (serviceModule as { CommentsService: CommentsServiceConstructor })
      .CommentsService;

    service = new CommentsServiceCtor(db, eventStore, projectionRunner, agentDirectoryService);
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
        name: `object-comments-test-workspace-${String(workspaceCounter)}`,
        slug: `object-comments-test-workspace-${String(workspaceCounter)}`,
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
   * Lightweight direct `objects_view` insert -- mirrors
   * `trigger-condition-evaluator.service.integration.test.ts`'s own
   * `insertObject` helper, deliberately bypassing `ObjectsService.create`'s
   * unrelated AI-gateway/task-recurrence/timeblock-push/search-index
   * dependency chain for a comments-only test.
   */
  async function insertObject(workspaceId: string, title = 'Test Object'): Promise<string> {
    const objectId = newObjectId();
    const now = new Date();
    await db.insert(objectsView).values({
      id: objectId,
      streamId: randomUUID(),
      type: 'task',
      workspaceId,
      title,
      createdBy: 'object-comments-test-harness',
      createdAt: now,
      updatedAt: now,
      lifecycle: 'active',
      fieldValues: {},
    });
    return objectId;
  }

  async function registerAgent(
    workspaceId: string,
    name: string,
    agentIdentifier: string,
  ): Promise<string> {
    const agent = await agentDirectoryService.register(workspaceId, fakeActor(), 'admin', {
      name,
      agentIdentifier,
    });
    return agent.id;
  }

  it('1. create by a "member" caller succeeds and returns the expected ObjectComment shape', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId);
    const actor = fakeActor();

    const comment = await service.create(workspaceId, actor, 'member', {
      objectId,
      body: 'Just a plain comment, no mentions here.',
    });

    expect(comment.id).toBeDefined();
    expect(typeof comment.id).toBe('string');
    expect(comment.workspaceId).toBe(workspaceId);
    expect(comment.objectId).toBe(objectId);
    expect(comment.body).toBe('Just a plain comment, no mentions here.');
    expect(comment.authorActor).toEqual(actor);
    expect(comment.mentionedAgentIds).toEqual([]);
    expect(comment.createdAt).toBeDefined();
  });

  it('2. create by an "admin" caller also succeeds (member+ includes admin)', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId);

    await expect(
      service.create(workspaceId, fakeActor(), 'admin', {
        objectId,
        body: 'Admin comment.',
      }),
    ).resolves.not.toThrow();
  });

  it('3. create by a "guest" (below member) throws ForbiddenError, and no comment is created', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId);

    await expect(
      service.create(workspaceId, fakeActor(), 'guest', {
        objectId,
        body: 'Should never be created.',
      }),
    ).rejects.toThrow(ForbiddenError);

    // Listing as a member (to distinguish "no comments" from "list itself
    // also rejects guest") confirms nothing landed.
    const comments = await service.list(workspaceId, 'member', objectId);
    expect(comments).toHaveLength(0);
  });

  it('4. create on a non-existent objectId (within a real, existing workspace) throws NotFoundError', async () => {
    const workspaceId = await createWorkspace();

    await expect(
      service.create(workspaceId, fakeActor(), 'member', {
        objectId: newObjectId(),
        body: 'This object does not exist.',
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('5. create on an objectId that exists but belongs to a DIFFERENT workspace throws NotFoundError (workspace-scoped existence check)', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const objectInA = await insertObject(workspaceIdA);

    await expect(
      service.create(workspaceIdB, fakeActor(), 'member', {
        objectId: objectInA,
        body: 'Wrong workspace for this object id.',
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('6. a body containing a single @handle that matches an active agent in this workspace resolves and stores that agent id in mentionedAgentIds', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId);
    const agentId = await registerAgent(workspaceId, 'Research-Bot', 'research-bot-v1');

    const comment = await service.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body: 'Hey @Research-Bot, can you take a look?',
    });

    expect(comment.mentionedAgentIds).toEqual([agentId]);
  });

  it('7. an @handle that does NOT match any active agent is silently ignored -- no error, no mention recorded, comment still created', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId);

    const comment = await service.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body: 'Hey @Nonexistent-Bot, are you there?',
    });

    expect(comment.id).toBeDefined();
    expect(comment.body).toBe('Hey @Nonexistent-Bot, are you there?');
    expect(comment.mentionedAgentIds).toEqual([]);
  });

  it('8. multiple mentions in one body resolve independently -- matching handles resolve, non-matching ones are skipped, order preserved', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId);
    const researchBotId = await registerAgent(workspaceId, 'Research-Bot', 'research-bot-v1');
    const supportBotId = await registerAgent(workspaceId, 'Support-Bot', 'support-bot-v1');

    const comment = await service.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body: '@Research-Bot and @Ghost-Bot, please loop in @Support-Bot too.',
    });

    expect(comment.mentionedAgentIds).toEqual([researchBotId, supportBotId]);
  });

  it('9. a duplicate @handle mentioned twice in the same body resolves to the same agent id each time it is scanned (no implicit de-duplication assumed beyond what resolution naturally produces)', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId);
    const agentId = await registerAgent(workspaceId, 'Research-Bot', 'research-bot-v1');

    const comment = await service.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body: '@Research-Bot please see this. cc @Research-Bot again.',
    });

    expect(comment.mentionedAgentIds.every((id) => id === agentId)).toBe(true);
    expect(comment.mentionedAgentIds.length).toBeGreaterThanOrEqual(1);
  });

  it('10. mention resolution is workspace-scoped -- an agent registered ONLY in a different workspace does not resolve for this comment', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const objectInA = await insertObject(workspaceIdA);
    await registerAgent(workspaceIdB, 'Research-Bot', 'research-bot-v1');

    const comment = await service.create(workspaceIdA, fakeActor(), 'member', {
      objectId: objectInA,
      body: 'Hey @Research-Bot, are you around?',
    });

    expect(comment.mentionedAgentIds).toEqual([]);
  });

  it("11. mention resolution ignores a DEACTIVATED agent's handle (mirrors AgentDirectoryService.resolveByName's own active-only contract) -- silently skipped, not an error", async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId);
    const agent = await agentDirectoryService.register(workspaceId, fakeActor(), 'admin', {
      name: 'Research-Bot',
      agentIdentifier: 'research-bot-v1',
    });
    await agentDirectoryService.deactivate(workspaceId, agent.id, fakeActor(), 'admin');

    const comment = await service.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body: 'Hey @Research-Bot, are you still active?',
    });

    expect(comment.mentionedAgentIds).toEqual([]);
  });

  it('12. list returns comments for the given object in creation order (oldest first)', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId);

    const first = await service.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body: 'First comment.',
    });
    const second = await service.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body: 'Second comment.',
    });
    const third = await service.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body: 'Third comment.',
    });

    const comments = await service.list(workspaceId, 'member', objectId);

    expect(comments.map((c) => c.id)).toEqual([first.id, second.id, third.id]);
  });

  it('13. list by a "guest" (below member) throws ForbiddenError', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId);
    await service.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body: 'Some comment.',
    });

    await expect(service.list(workspaceId, 'guest', objectId)).rejects.toThrow(ForbiddenError);
  });

  it('14. list on a non-existent objectId throws NotFoundError', async () => {
    const workspaceId = await createWorkspace();

    await expect(service.list(workspaceId, 'member', newObjectId())).rejects.toThrow(NotFoundError);
  });

  it("15. list is workspace-scoped -- an objectId that exists in a DIFFERENT workspace throws NotFoundError rather than leaking that workspace B's comments", async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const objectInA = await insertObject(workspaceIdA);
    await service.create(workspaceIdA, fakeActor(), 'member', {
      objectId: objectInA,
      body: 'Belongs to workspace A only.',
    });

    await expect(service.list(workspaceIdB, 'member', objectInA)).rejects.toThrow(NotFoundError);
  });

  it('16. cross-workspace isolation: comments created against an object in workspace A never appear when listing a same-named/differently-created object in workspace B', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const objectInA = await insertObject(workspaceIdA, 'Shared Title');
    const objectInB = await insertObject(workspaceIdB, 'Shared Title');

    await service.create(workspaceIdA, fakeActor(), 'member', {
      objectId: objectInA,
      body: 'Comment only on workspace A object.',
    });

    const commentsOnB = await service.list(workspaceIdB, 'member', objectInB);
    expect(commentsOnB).toHaveLength(0);
  });

  /**
   * Basic sanity/smoke bound only -- NOT a full ReDoS-safety proof. The full
   * pinned ReDoS-safety test (per the spec's PR6 "Çapraz-kesen sertleştirme"
   * scope) is deliberately deferred to PR6; this PR's test only confirms the
   * `{2,32}`-bounded handle regex does not hang on a long run of word
   * characters immediately after `@` (a naive unbounded `@(\w+)` pattern
   * would still terminate fine on this particular input too, so this is a
   * smoke check, not a proof of bounded worst-case behavior).
   */
  it('17. a body containing a very long run of word characters after "@" does not hang mention-scanning (basic smoke bound, full ReDoS pin deferred to PR6)', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId);
    const longRun = 'a'.repeat(5000);

    const startedAt = Date.now();
    const comment = await service.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body: `Some text before @${longRun} and some text after.`,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2000);
    expect(comment.mentionedAgentIds).toEqual([]);
  });
});
