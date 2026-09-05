import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AgentActionResult } from '@luminaos/agent-runtime';
import { newObjectId } from '@luminaos/core-objects';
import type { Actor } from '@luminaos/shared';

import { CommentsService } from './object-comments.service.js';
import { AgentDirectoryService } from '../agent-runtime/agent-directory.service.js';
import { AgentPermissionManifestsService } from '../agent-runtime/agent-permission-manifests.service.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { objectComments } from '../db/schema/object-comments.js';
import { objectsView } from '../db/schema/objects-view.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { QAService } from '../qa/qa.service.js';
import { SkillExecutionService } from '../skills/skill-execution.service.js';

import type { Database } from '../db/client.js';
import type { INestApplication, Type } from '@nestjs/common';

/**
 * F3-T3 PR3 (RED step), ADR-0037 Karar (3) -- `MentionActionWorker`: the
 * claim-based background worker that is `SkillExecutionService`'s FIRST real
 * caller (ADR-0035 §e / ADR-0036 §g's long-accepted YAGNI risk, closed here).
 * Mirrors `WebhookDeliveryWorker`'s exact shape (`OnModuleInit`/
 * `OnModuleDestroy` + `setInterval`, a public `runOnce()` this file calls
 * DIRECTLY and NEVER via `onModuleInit()`, an atomic conditional-UPDATE
 * `claimRow`, per-row `try/catch`, `MAX_ATTEMPTS`/exponential backoff).
 *
 * Two independent harnesses in this one file, split by how much of the real
 * `SkillExecutionService` chain each group of scenarios needs to prove
 * (mirrors this task's own explicit "compose the REAL chain, fake only the
 * true I/O boundary; a narrow test double is acceptable where the real chain
 * is too heavy" guidance):
 *
 *   DESCRIBE A ("real chain"): full `AppModule` boot (Postgres + Redis
 *   Testcontainers, identical harness to `../skills/ai-command-skills.
 *   integration.test.ts`) -- proves the worker's success path and
 *   permission-denial path through the REAL `SkillExecutionService` ->
 *   `AgentPermissionManifestsService.checkPermission` ->
 *   `AgentResourceLimitsService.executeAgentAction` -> real `answer-question`
 *   skill -> real `QAService.answer` chain, with ONLY the outermost AI
 *   provider call faked via `AIProviderModule`'s production `MockProvider` +
 *   `unconfiguredResponder` "RETURN:" marker convention (`ANTHROPIC_API_KEY`
 *   deliberately unset).
 *
 *   DESCRIBE B ("worker queue-state logic"): a lightweight, DB-only harness
 *   (no Redis/AppModule -- mirrors `object-comments.service.integration.
 *   test.ts`'s own direct-construction precedent) with a hand-rolled,
 *   clearly-scripted `SkillExecutionServiceLike` test double, used ONLY for
 *   scenarios that need to deterministically simulate outcomes the real
 *   sandbox cannot practically produce in a test (a genuine 30s
 *   `env.agentSandboxTimeoutMs` timeout) or that are purely about the
 *   WORKER's own claim/retry/isolation bookkeeping (already proven not to
 *   depend on skill-execution internals by describe A above).
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `./mention-action-worker.service.ts` does not
 * exist at all, so the dynamic `import('./mention-action-worker.service.js')`
 * call inside EACH describe block's `beforeAll` REJECTS ("Cannot find
 * module"), failing every `it` in this file. The `mention_actions` TABLE
 * (raw SQL, no schema module exists yet either -- see this task's sibling
 * `mention-action-enqueue.projection.integration.test.ts` for why raw SQL is
 * used instead of a Drizzle schema import) does not exist yet either, so even
 * if the module import somehow succeeded, every raw INSERT/SELECT against
 * `mention_actions` would separately reject with a Postgres
 * `relation "mention_actions" does not exist` error. Either failure mode is
 * an acceptable RED reason, NOT a bug in this test file.
 *
 * `CommentsService`/`AgentDirectoryService`/`AgentPermissionManifestsService`/
 * `QAService`/`SkillExecutionService`/`object_comments`/`agents` all already
 * exist (merged, prior PRs/tasks) -- statically imported here.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *   `MentionActionWorker(db: Database, skillExecutionService:
 *   SkillExecutionService, commentsService: CommentsService)`, public
 *   `runOnce(): Promise<void>`.
 *   - Selects `mention_actions` rows `status='pending' AND
 *     next_attempt_at <= now()`, joined to `object_comments`/`objects_view`
 *     for `body`/`title`.
 *   - Per row, in its own try/catch: atomically claims (mirrors
 *     `WebhookDeliveryWorker.claimRow`'s conditional-UPDATE-on-
 *     `(id, status='pending', next_attempt_at=observed)` + `.returning()`
 *     shape); builds `question = 'Regarding "<title>": <body>'`; calls
 *     `skillExecutionService.executeSkill(workspaceId, agentIdentifier,
 *     'answer-question', {question}, objectType)`.
 *   - `ForbiddenError`/`NotFoundError` thrown synchronously by `executeSkill`
 *     -> `status: 'failed'` IMMEDIATELY, `attempts` incremented exactly once,
 *     NEVER retried, `last_error` a short fixed sanitized string (never the
 *     question/body/answer text) -- this test file pins the exact spec-given
 *     string `'Agent lacks permission or skill not registered'`.
 *   - Any other thrown error -> treated as transient, same retry path as
 *     `outcome: 'failure'`.
 *   - `outcome: 'success'` -> `commentsService.create(workspaceId,
 *     {type:'agent', id: agentIdentifier}, 'member', {objectId,
 *     body: result.value.answer})`; row `status: 'done'`, `reply_comment_id`
 *     set to the new comment's id.
 *   - `outcome: 'timeout' | 'failure'` -> increment `attempts`; if
 *     `< MAX_ATTEMPTS` (3, per `WebhookDeliveryWorker`'s own convention),
 *     stays `'pending'` with `next_attempt_at` pushed forward and
 *     `last_error` set (`result.error` for `'failure'`, the fixed string
 *     `'Skill execution timed out'` for `'timeout'` -- both pinned exactly by
 *     this test file per the task's own spec text); otherwise `'failed'`.
 * ============================================================================
 */

const RETURN_MARKER = 'RETURN:';

function returnDirective(value: string): string {
  return `${RETURN_MARKER}${value}`;
}

// `type` (not `interface`) so this satisfies `db.execute<T>()`'s
// `T extends Record<string, unknown>` constraint -- an `interface` here
// fails that generic constraint check (TypeScript requires an explicit
// index signature for interfaces, but not for object-literal type aliases).
type MentionActionRow = {
  id: string;
  workspace_id: string;
  comment_id: string;
  object_id: string;
  object_type: string;
  agent_identifier: string;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  reply_comment_id: string | null;
  created_at: Date;
};

interface MentionActionWorkerLike {
  runOnce(): Promise<void>;
}

// =============================================================================
// DESCRIBE A -- real SkillExecutionService chain (full AppModule, Postgres +
// Redis Testcontainers)
// =============================================================================

type MentionActionWorkerConstructorReal = new (
  db: Database,
  skillExecutionService: SkillExecutionService,
  commentsService: CommentsService,
) => MentionActionWorkerLike;

describe('F3-T3 PR3 (RED step): MentionActionWorker -- real SkillExecutionService/answer-question/QAService chain (full AppModule, Postgres+Redis Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let db: Database;
  let commentsService: CommentsService;
  let agentDirectoryService: AgentDirectoryService;
  let permissionsService: AgentPermissionManifestsService;
  let qaService: QAService;
  let skillExecutionService: SkillExecutionService;
  let worker: MentionActionWorkerLike;
  let workspaceCounter = 0;
  let agentCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    redisContainer = await new RedisContainer('redis:7').start();

    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();
    // Deliberately unset -- forces DI to fall back to `MockProvider`'s
    // `unconfiguredResponder` "RETURN:" marker convention, mirroring
    // `qa.integration.test.ts`/`ai-command-skills.integration.test.ts`.
    delete process.env.ANTHROPIC_API_KEY;

    await runMigrations(container.getConnectionUri());
    db = createDatabaseClient(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    commentsService = app.get(CommentsService);
    agentDirectoryService = app.get(AgentDirectoryService);
    permissionsService = app.get(AgentPermissionManifestsService);
    qaService = app.get(QAService);
    skillExecutionService = app.get(SkillExecutionService);

    // Deliberately NOT resolvable until `implementer` creates
    // `./mention-action-worker.service.ts` and wires it as a `CommentsModule`
    // provider -- see this file's header for the resulting RED state.
    const workerModule: unknown = await import('./mention-action-worker.service.js');
    const MentionActionWorkerCtor = (
      workerModule as { MentionActionWorker: Type<MentionActionWorkerConstructorReal> }
    ).MentionActionWorker;
    worker = app.get(MentionActionWorkerCtor);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await db.$client.end();
    await container.stop();
    await redisContainer.stop();
  }, 120_000);

  async function createWorkspace(): Promise<string> {
    workspaceCounter += 1;
    const [row] = await db
      .insert(workspaces)
      .values({
        name: `mention-worker-real-chain-test-${String(workspaceCounter)}`,
        slug: `mention-worker-real-chain-test-${String(workspaceCounter)}`,
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

  function freshAgentIdentifier(label: string): string {
    agentCounter += 1;
    return `mention-worker-real-chain-test-${label}-agent-${String(agentCounter)}`;
  }

  async function insertObject(workspaceId: string, title: string): Promise<string> {
    const objectId = newObjectId();
    const now = new Date();
    await db.insert(objectsView).values({
      id: objectId,
      streamId: randomUUID(),
      type: 'task',
      workspaceId,
      title,
      createdBy: 'mention-worker-real-chain-test-harness',
      createdAt: now,
      updatedAt: now,
      lifecycle: 'active',
      fieldValues: {},
    });
    return objectId;
  }

  async function readMentionActionRowsForComment(commentId: string): Promise<MentionActionRow[]> {
    const result = await db.execute<MentionActionRow>(sql`
      SELECT id, workspace_id, comment_id, object_id, object_type, agent_identifier,
             status, attempts, next_attempt_at, last_error, reply_comment_id, created_at
      FROM mention_actions
      WHERE comment_id = ${commentId}
      ORDER BY agent_identifier
    `);
    return result.rows;
  }

  it('6. success path: agent has an active permission manifest allowing answer-question -- worker claims the row, calls the REAL executeSkill chain (with objectType always passed), creates an agent-authored reply comment via CommentsService, marks the row done with the correct replyCommentId, and the reply is readable via CommentsService.list', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Mention Target Object');
    const agentIdentifier = freshAgentIdentifier('success');
    const agent = await agentDirectoryService.register(workspaceId, fakeActor(), 'admin', {
      name: 'MentionSuccessBot',
      agentIdentifier,
    });

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['answer-question'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const plantedAnswer = 'Mention-driven planted answer, unique to this success test.';
    const body = `Hey @MentionSuccessBot, can you help? ${returnDirective(plantedAnswer)}`;
    const comment = await commentsService.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body,
    });
    expect(comment.mentionedAgentIds).toEqual([agent.id]);

    const rowsBefore = await readMentionActionRowsForComment(comment.id);
    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0]?.status).toBe('pending');
    expect(rowsBefore[0]?.agent_identifier).toBe(agentIdentifier);
    expect(rowsBefore[0]?.object_type).toBe('task');

    const executeSkillSpy = vi.spyOn(skillExecutionService, 'executeSkill');

    await worker.runOnce();

    expect(executeSkillSpy).toHaveBeenCalledTimes(1);
    const call = executeSkillSpy.mock.calls[0];
    expect(call?.[0]).toBe(workspaceId);
    expect(call?.[1]).toBe(agentIdentifier);
    expect(call?.[2]).toBe('answer-question');
    // "objectType MUTLAKA executeSkill'e geçirilir" -- pinned directly.
    expect(call?.[4]).toBe('task');

    const rowsAfter = await readMentionActionRowsForComment(comment.id);
    expect(rowsAfter[0]?.status).toBe('done');
    const replyCommentId = rowsAfter[0]?.reply_comment_id;
    expect(replyCommentId).toBeTruthy();

    const comments = await commentsService.list(workspaceId, 'member', objectId);
    const reply = comments.find((c) => c.id === replyCommentId);
    expect(reply).toBeDefined();
    expect(reply?.authorActor).toEqual({ type: 'agent', id: agentIdentifier });
    expect(reply?.body).toBe(plantedAnswer);
  });

  it('7. permission-denial path: an agent with NO permission manifest allowing answer-question goes straight to "failed" after exactly one attempt (never retried); the underlying skill/QAService code never runs, no reply comment is ever created, and last_error never leaks the question/body/answer text', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Denied Mention Target');
    const agentIdentifier = freshAgentIdentifier('denied');
    await agentDirectoryService.register(workspaceId, fakeActor(), 'admin', {
      name: 'MentionDeniedBot',
      agentIdentifier,
    });
    // Deliberately NO permissionsService.grant call -- this agent has zero
    // manifest, so `checkPermission` must deny before the skill ever runs.

    const secretBody = 'this-body-text-must-never-appear-in-last_error';
    const body = `Hey @MentionDeniedBot, are you allowed to help? ${secretBody} ${returnDirective('should never be reached')}`;
    const comment = await commentsService.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body,
    });

    const qaAnswerSpy = vi.spyOn(qaService, 'answer');
    const callsBefore = qaAnswerSpy.mock.calls.length;

    await worker.runOnce();

    expect(qaAnswerSpy.mock.calls.length).toBe(callsBefore);

    const rowsAfterFirstRun = await readMentionActionRowsForComment(comment.id);
    expect(rowsAfterFirstRun).toHaveLength(1);
    expect(rowsAfterFirstRun[0]?.status).toBe('failed');
    expect(rowsAfterFirstRun[0]?.attempts).toBe(1);
    expect(rowsAfterFirstRun[0]?.last_error).toBe('Agent lacks permission or skill not registered');
    expect(rowsAfterFirstRun[0]?.last_error).not.toContain(secretBody);

    const comments = await commentsService.list(workspaceId, 'member', objectId);
    expect(comments).toHaveLength(1);

    // Never retried, even once the permission gap is fixed afterwards.
    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['answer-question'],
      timeWindow: { startsAt: null, expiresAt: null },
    });
    await worker.runOnce();

    const rowsAfterSecondRun = await readMentionActionRowsForComment(comment.id);
    expect(rowsAfterSecondRun[0]?.status).toBe('failed');
    expect(rowsAfterSecondRun[0]?.attempts).toBe(1);
    expect(qaAnswerSpy.mock.calls.length).toBe(callsBefore);
  });
});

// =============================================================================
// DESCRIBE B -- worker queue-state logic only, via a scripted
// SkillExecutionServiceLike test double (Postgres Testcontainers only, no
// Redis/AppModule -- mirrors `object-comments.service.integration.test.ts`'s
// own lightweight direct-construction harness)
// =============================================================================

interface ScriptedOutcome {
  kind: 'result' | 'throw';
  result?: AgentActionResult<{ answer: string }>;
  error?: Error;
}

interface SkillExecutionServiceLike {
  executeSkill<TOutput>(
    workspaceId: string,
    agentIdentifier: string,
    skillId: string,
    input: Record<string, unknown>,
    objectType?: string,
  ): Promise<AgentActionResult<TOutput>>;
}

interface ScriptedSkillExecutionServiceCall {
  workspaceId: string;
  agentIdentifier: string;
  skillId: string;
  input: Record<string, unknown>;
  objectType?: string;
}

function buildScriptedSkillExecutionService(script: Map<string, ScriptedOutcome[]>): {
  service: SkillExecutionServiceLike;
  calls: ScriptedSkillExecutionServiceCall[];
} {
  const calls: ScriptedSkillExecutionServiceCall[] = [];
  return {
    calls,
    service: {
      executeSkill: (workspaceId, agentIdentifier, skillId, input, objectType) => {
        calls.push({
          workspaceId,
          agentIdentifier,
          skillId,
          input,
          ...(objectType === undefined ? {} : { objectType }),
        });
        const queue = script.get(agentIdentifier);
        const next = queue?.shift();
        if (!next) {
          return Promise.reject(
            new Error(`No scripted outcome left for agentIdentifier "${agentIdentifier}"`),
          );
        }
        if (next.kind === 'throw') {
          return Promise.reject(
            next.error ?? new Error('Scripted "throw" outcome with no error provided'),
          );
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by `kind !== 'throw'` above
        return Promise.resolve(next.result! as never);
      },
    },
  };
}

type MentionActionWorkerConstructorScripted = new (
  db: Database,
  skillExecutionService: SkillExecutionServiceLike,
  commentsService: CommentsService,
) => MentionActionWorkerLike;

describe('F3-T3 PR3 (RED step): MentionActionWorker -- claim/retry/backoff/isolation queue-state logic (real Postgres via Testcontainers, scripted SkillExecutionServiceLike double)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let agentDirectoryService: AgentDirectoryService;
  let commentsService: CommentsService;
  let MentionActionWorker: MentionActionWorkerConstructorScripted;
  let workspaceCounter = 0;
  let agentCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    const connectionString = container.getConnectionUri();

    await runMigrations(connectionString);
    db = createDatabaseClient(connectionString);
    eventStore = new EventStoreService(db);
    projectionRunner = new ProjectionRunner(db, eventStore);
    agentDirectoryService = new AgentDirectoryService(db, eventStore, projectionRunner);
    commentsService = new CommentsService(db, eventStore, projectionRunner, agentDirectoryService);

    const workerModule: unknown = await import('./mention-action-worker.service.js');
    MentionActionWorker = (
      workerModule as { MentionActionWorker: MentionActionWorkerConstructorScripted }
    ).MentionActionWorker;
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
        name: `mention-worker-scripted-test-${String(workspaceCounter)}`,
        slug: `mention-worker-scripted-test-${String(workspaceCounter)}`,
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

  function freshAgentIdentifier(label: string): string {
    agentCounter += 1;
    return `mention-worker-scripted-test-${label}-agent-${String(agentCounter)}`;
  }

  async function insertObject(workspaceId: string, title: string): Promise<string> {
    const objectId = newObjectId();
    const now = new Date();
    await db.insert(objectsView).values({
      id: objectId,
      streamId: randomUUID(),
      type: 'task',
      workspaceId,
      title,
      createdBy: 'mention-worker-scripted-test-harness',
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
  ): Promise<{ id: string; agentIdentifier: string }> {
    const agent = await agentDirectoryService.register(workspaceId, fakeActor(), 'admin', {
      name,
      agentIdentifier,
    });
    return { id: agent.id, agentIdentifier: agent.agentIdentifier };
  }

  /** Direct `object_comments` insert -- bypasses the enqueue-projection entirely, keeping these tests focused only on the WORKER's own logic. */
  async function insertCommentRow(params: {
    workspaceId: string;
    objectId: string;
    body: string;
    authorActor?: Actor;
  }): Promise<string> {
    const id = ulid();
    const now = new Date();
    await db.insert(objectComments).values({
      id,
      streamId: randomUUID(),
      workspaceId: params.workspaceId,
      objectId: params.objectId,
      authorActor: params.authorActor ?? fakeActor(),
      body: params.body,
      mentionedAgentIds: [],
      createdAt: now,
    });
    return id;
  }

  async function insertMentionActionRow(params: {
    workspaceId: string;
    commentId: string;
    objectId: string;
    objectType: string;
    agentIdentifier: string;
    status?: string;
    attempts?: number;
    nextAttemptAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    await db.execute(sql`
      INSERT INTO mention_actions
        (id, workspace_id, comment_id, object_id, object_type, agent_identifier, status, attempts, next_attempt_at, created_at)
      VALUES
        (${id}, ${params.workspaceId}, ${params.commentId}, ${params.objectId}, ${params.objectType},
         ${params.agentIdentifier}, ${params.status ?? 'pending'}, ${params.attempts ?? 0},
         ${params.nextAttemptAt ?? now}, ${now})
    `);
    return id;
  }

  async function readMentionActionRow(id: string): Promise<MentionActionRow | undefined> {
    const result = await db.execute<MentionActionRow>(sql`
      SELECT id, workspace_id, comment_id, object_id, object_type, agent_identifier,
             status, attempts, next_attempt_at, last_error, reply_comment_id, created_at
      FROM mention_actions
      WHERE id = ${id}
    `);
    return result.rows[0];
  }

  async function readMentionActionRowsForComment(commentId: string): Promise<MentionActionRow[]> {
    const result = await db.execute<MentionActionRow>(sql`
      SELECT id, workspace_id, comment_id, object_id, object_type, agent_identifier,
             status, attempts, next_attempt_at, last_error, reply_comment_id, created_at
      FROM mention_actions
      WHERE comment_id = ${commentId}
    `);
    return result.rows;
  }

  it('8a. a "failure" outcome: attempts 0 -> 1, stays "pending", nextAttemptAt pushed into the future, lastError set to the exact result.error string', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Failure Retry Target');
    const commentId = await insertCommentRow({ workspaceId, objectId, body: 'please help' });
    const agentIdentifier = freshAgentIdentifier('failure-retry');
    const rowId = await insertMentionActionRow({
      workspaceId,
      commentId,
      objectId,
      objectType: 'task',
      agentIdentifier,
    });

    const failureResult: AgentActionResult<{ answer: string }> = {
      outcome: 'failure',
      error: 'boom-transient-error',
    };
    const { service, calls } = buildScriptedSkillExecutionService(
      new Map([[agentIdentifier, [{ kind: 'result', result: failureResult }]]]),
    );

    const worker = new MentionActionWorker(db, service, commentsService);
    const beforeRun = Date.now();
    await worker.runOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.objectType).toBe('task');

    const row = await readMentionActionRow(rowId);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.next_attempt_at.getTime()).toBeGreaterThan(beforeRun);
    expect(row?.last_error).toBe('boom-transient-error');
  });

  it('8b. a "timeout" outcome: attempts incremented, stays "pending", lastError set to the fixed string "Skill execution timed out"', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Timeout Retry Target');
    const commentId = await insertCommentRow({ workspaceId, objectId, body: 'please help' });
    const agentIdentifier = freshAgentIdentifier('timeout-retry');
    const rowId = await insertMentionActionRow({
      workspaceId,
      commentId,
      objectId,
      objectType: 'task',
      agentIdentifier,
    });

    const timeoutResult: AgentActionResult<{ answer: string }> = {
      outcome: 'timeout',
    };
    const { service } = buildScriptedSkillExecutionService(
      new Map([[agentIdentifier, [{ kind: 'result', result: timeoutResult }]]]),
    );

    const worker = new MentionActionWorker(db, service, commentsService);
    await worker.runOnce();

    const row = await readMentionActionRow(rowId);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBe('Skill execution timed out');
  });

  it('8c. exhausting MAX_ATTEMPTS (3): a row already at attempts:2 that fails again becomes attempts:3, status:"failed" (terminal), and is never touched by a subsequent runOnce() even with a fresh scripted success outcome queued', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Exhausted Retry Target');
    const commentId = await insertCommentRow({ workspaceId, objectId, body: 'please help' });
    const agentIdentifier = freshAgentIdentifier('exhausted-retry');
    const rowId = await insertMentionActionRow({
      workspaceId,
      commentId,
      objectId,
      objectType: 'task',
      agentIdentifier,
      attempts: 2,
    });

    const failureResult: AgentActionResult<{ answer: string }> = {
      outcome: 'failure',
      error: 'boom-final-error',
    };
    const { service } = buildScriptedSkillExecutionService(
      new Map([[agentIdentifier, [{ kind: 'result', result: failureResult }]]]),
    );
    const worker = new MentionActionWorker(db, service, commentsService);
    await worker.runOnce();

    const row = await readMentionActionRow(rowId);
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(3);
    expect(row?.last_error).toBe('boom-final-error');

    const successResult: AgentActionResult<{ answer: string }> = {
      outcome: 'success',
      value: { answer: 'too late, should never be reached' },
    };
    const { service: secondService, calls: secondCalls } = buildScriptedSkillExecutionService(
      new Map([[agentIdentifier, [{ kind: 'result', result: successResult }]]]),
    );
    const secondWorker = new MentionActionWorker(db, secondService, commentsService);
    await secondWorker.runOnce();

    expect(secondCalls).toHaveLength(0);
    const rowAfterSecondRun = await readMentionActionRow(rowId);
    expect(rowAfterSecondRun?.status).toBe('failed');
    expect(rowAfterSecondRun?.attempts).toBe(3);
  });

  it('9. concurrent-tick claim-race safety: two concurrent runOnce() calls against the same due row -- only ONE claims and executes it (no double-execution, no double-reply-comment)', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Claim Race Target');
    const commentId = await insertCommentRow({ workspaceId, objectId, body: 'please help' });
    const agentIdentifier = freshAgentIdentifier('claim-race');
    const rowId = await insertMentionActionRow({
      workspaceId,
      commentId,
      objectId,
      objectType: 'task',
      agentIdentifier,
    });

    const successResult: AgentActionResult<{ answer: string }> = {
      outcome: 'success',
      value: { answer: 'All good, no mentions here.' },
    };
    // Deliberately only ONE scripted outcome available for this
    // agentIdentifier -- if the claim guard failed and both concurrent
    // `runOnce()` calls executed the skill, the second would hit the
    // "No scripted outcome left" throw path instead of skipping cleanly.
    const { service, calls } = buildScriptedSkillExecutionService(
      new Map([[agentIdentifier, [{ kind: 'result', result: successResult }]]]),
    );
    const worker = new MentionActionWorker(db, service, commentsService);

    await Promise.all([worker.runOnce(), worker.runOnce()]);

    expect(calls).toHaveLength(1);

    const row = await readMentionActionRow(rowId);
    expect(row?.status).toBe('done');
    expect(row?.reply_comment_id).toBeTruthy();

    const comments = await commentsService.list(workspaceId, 'member', objectId);
    expect(comments).toHaveLength(2); // the original mention comment + exactly one reply
    const replies = comments.filter((c) => c.id === row?.reply_comment_id);
    expect(replies).toHaveLength(1);
  });

  it('10. per-row isolation: one row throwing an unexpected error during processing does not prevent ANOTHER due row in the same runOnce() scan from being processed successfully', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Isolation Target');

    const commentIdA = await insertCommentRow({ workspaceId, objectId, body: 'row A' });
    const agentA = freshAgentIdentifier('isolation-a');
    const rowIdA = await insertMentionActionRow({
      workspaceId,
      commentId: commentIdA,
      objectId,
      objectType: 'task',
      agentIdentifier: agentA,
    });

    const commentIdB = await insertCommentRow({ workspaceId, objectId, body: 'row B' });
    const agentB = freshAgentIdentifier('isolation-b');
    const rowIdB = await insertMentionActionRow({
      workspaceId,
      commentId: commentIdB,
      objectId,
      objectType: 'task',
      agentIdentifier: agentB,
    });

    const successResultB: AgentActionResult<{ answer: string }> = {
      outcome: 'success',
      value: { answer: 'B answered fine.' },
    };
    const { service } = buildScriptedSkillExecutionService(
      new Map([
        [agentA, [{ kind: 'throw', error: new Error('unexpected boom, not Forbidden/NotFound') }]],
        [agentB, [{ kind: 'result', result: successResultB }]],
      ]),
    );
    const worker = new MentionActionWorker(db, service, commentsService);

    await expect(worker.runOnce()).resolves.toBeUndefined();

    const rowA = await readMentionActionRow(rowIdA);
    expect(rowA?.status).toBe('pending');
    expect(rowA?.attempts).toBe(1);

    const rowB = await readMentionActionRow(rowIdB);
    expect(rowB?.status).toBe('done');
    expect(rowB?.reply_comment_id).toBeTruthy();
  });

  it('11. a success reply never re-triggers a second round of mention-action enqueueing that could itself infinite-loop: an agent-authored reply whose OWN body contains a real active agent handle never gets a mention_actions row enqueued for it (anti-recursion guard exercised end-to-end through the worker)', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Anti Recursion Target');

    const agentAIdentifier = freshAgentIdentifier('anti-recursion-a');
    await registerAgent(workspaceId, 'AgentA', agentAIdentifier);
    await registerAgent(workspaceId, 'AgentB', freshAgentIdentifier('anti-recursion-b'));

    const commentId = await insertCommentRow({
      workspaceId,
      objectId,
      body: '@AgentA can you help here?',
    });
    const rowId = await insertMentionActionRow({
      workspaceId,
      commentId,
      objectId,
      objectType: 'task',
      agentIdentifier: agentAIdentifier,
    });

    const successResult: AgentActionResult<{ answer: string }> = {
      outcome: 'success',
      value: { answer: 'Sure thing! Looping in @AgentB for visibility.' },
    };
    const { service } = buildScriptedSkillExecutionService(
      new Map([[agentAIdentifier, [{ kind: 'result', result: successResult }]]]),
    );
    const worker = new MentionActionWorker(db, service, commentsService);
    await worker.runOnce();

    const row = await readMentionActionRow(rowId);
    expect(row?.status).toBe('done');
    expect(row?.reply_comment_id).toBeTruthy();

    const comments = await commentsService.list(workspaceId, 'member', objectId);
    const reply = comments.find((c) => c.id === row?.reply_comment_id);
    expect(reply).toBeDefined();
    expect(reply?.authorActor).toEqual({ type: 'agent', id: agentAIdentifier });
    // Anti-recursion guard: an agent-authored comment's OWN mentions are
    // never resolved, even though the reply body literally contains
    // "@AgentB" (a real, active agent in this workspace).
    expect(reply?.mentionedAgentIds).toEqual([]);

    const rowsForReply = await readMentionActionRowsForComment(reply?.id ?? '');
    expect(rowsForReply).toHaveLength(0);
  });
});
