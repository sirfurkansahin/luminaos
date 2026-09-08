import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commentResource, objectResource } from '@luminaos/agent-runtime';
import type { AgentActionRecord, AgentActionResult } from '@luminaos/agent-runtime';
import type { EmbeddingProvider } from '@luminaos/ai-gateway';
import { newObjectId } from '@luminaos/core-objects';
import type { Actor } from '@luminaos/shared';
import { ForbiddenError } from '@luminaos/shared';

import { CommentsService } from './object-comments.service.js';
import { AgentActionRecordsService } from '../agent-runtime/agent-action-records.service.js';
import { AgentDirectoryService } from '../agent-runtime/agent-directory.service.js';
import { EMBEDDING_PROVIDER } from '../ai/embedding-provider.token.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { objectComments } from '../db/schema/object-comments.js';
import { objectsView } from '../db/schema/objects-view.js';
import { searchIndex } from '../db/schema/search-index.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

/**
 * Bug fix precedent (F3-T3 PR3, mirrored here verbatim): `QAService`/
 * `SkillExecutionService` transitively import `../config/env.js`, whose
 * `export const env: Env = readEnv()` calls `process.exit(1)` if
 * `DATABASE_URL`/`REDIS_URL` aren't set yet -- so these are `import type`
 * only, with the real runtime constructors obtained via a DYNAMIC
 * `await import(...)` inside `beforeAll`, AFTER the Testcontainers set both
 * env vars.
 */
import type { AgentPermissionManifestsService } from '../agent-runtime/agent-permission-manifests.service.js';
import type { Database } from '../db/client.js';
import type { SkillExecutionService } from '../skills/skill-execution.service.js';
import type { INestApplication, Type } from '@nestjs/common';

/**
 * F3-T4 PR3 (RED step), ADR-0038 Karar (d), spec
 * `docs/specs/F3-E2/F3-T4-ajan-aksiyon-kayit-defteri.md` PR3 section --
 * `MentionActionWorker.runOnce()`'s wiring into `AgentActionRecordsService.
 * record()` (PR1, ALREADY MERGED, imported here STATICALLY as a REAL
 * collaborator -- never mocked). Deliberately a SIBLING file to
 * `./mention-action-worker.service.integration.test.ts` (F3-T3 PR3, already
 * merged, unmodified) and mirrors `../commands/commands.service.ledger.
 * integration.test.ts` (F3-T4 PR2)'s own house style for pulling a real
 * `AgentActionRecordsService` out of a booted `AppModule` / constructing one
 * directly, and calling `.list(workspaceId, 'member')`.
 *
 * Two harnesses, same split as the sibling file:
 *
 *   DESCRIBE A ("real chain"): full `AppModule` boot (Postgres + Redis
 *   Testcontainers) -- extends the sibling file's own success / permission-
 *   denial scenarios with ledger assertions.
 *
 *   DESCRIBE B ("scripted double"): direct construction, no Redis/AppModule,
 *   a hand-rolled `SkillExecutionServiceLike` double -- this is the file's
 *   own most important RED-defining block: it proves NO ledger record is
 *   written for a merely-scheduled retry, and exactly ONE record is written
 *   once a row reaches its final, terminal attempt.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): `MentionActionWorker`'s constructor does not
 * accept a 4th `agentActionRecordsService` param and NOTHING inside
 * `runOnce()` calls `AgentActionRecordsService.record(...)` at all -- so
 * EVERY assertion below that expects a matching `AgentActionRecord` to exist
 * in `AgentActionRecordsService.list(workspaceId, 'member')` fails today
 * (the list comes back empty), which is the correct RED failure mode, NOT a
 * bug in this test file. Passing a 4th constructor argument to a class that
 * does not yet declare it is a harmless no-op at the JS call site (mirrors
 * `commands.service.ledger.integration.test.ts`'s own documented reasoning);
 * the RED signal here comes exclusively from the runtime ledger assertions.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *   `MentionActionWorker(db, skillExecutionService, commentsService,
 *   agentActionRecordsService: AgentActionRecordsService)`.
 *   - Success (after `markDone` succeeds): `provenance:'autonomous'`,
 *     `actor:{type:'agent', id: agentIdentifier}`, `actionType:
 *     'answer-question'`, fixed `intent`/`rationale` template strings (never
 *     the raw question/body/answer text), `resources:
 *     [objectResource(objectId), commentResource(commentId)]`,
 *     `rollbackPlan:{kind:'delete', targetResource:
 *     commentResource(replyId), description: <non-empty>}`,
 *     `outcome:'succeeded'`, `resultRef: commentResource(replyId)`,
 *     `causationEventId: null` (ALWAYS null on this autonomous path).
 *   - `ForbiddenError`/`NotFoundError` (`markFailedImmediately`, always
 *     terminal, never retried): same `intent`/`rationale`/`resources`,
 *     `rollbackPlan:{kind:'none', description:<non-empty>}`,
 *     `outcome:'failed'`, `resultRef:null`, `causationEventId:null`.
 *   - `retryOrFail` reaching `MAX_ATTEMPTS` (3rd attempt, from the
 *     `'failure'` or `'timeout'` outcome path, or from any other thrown
 *     error): same `resources`, `rollbackPlan:{kind:'none',
 *     description:<non-empty>}`, `outcome:'failed'`, `resultRef:null`,
 *     `causationEventId:null` -- written EXACTLY ONCE, only on the call that
 *     reaches the terminal state.
 *   - `retryOrFail` merely scheduling a retry (row stays `'pending'`): NO
 *     ledger record is written for that call at all.
 * ============================================================================
 */

const RETURN_MARKER = 'RETURN:';
const AUTONOMOUS_MENTION_INTENT = "Bir yorumdaki @mention'a yanıt verildi";
const AUTONOMOUS_MENTION_RATIONALE =
  "Ajan, kendi izin manifestosu kapsamında bu nesnedeki bir mention'a otomatik yanıt verdi (ikinci bir insan onayı adımı yok, ADR-0037 Karar d).";

function returnDirective(value: string): string {
  return `${RETURN_MARKER}${value}`;
}

function expectNonEmptyString(value: unknown): void {
  expect(typeof value).toBe('string');
  expect((value as string).length).toBeGreaterThan(0);
}

interface MentionActionWorkerLike {
  runOnce(): Promise<void>;
}

// =============================================================================
// DESCRIBE A -- real SkillExecutionService chain (full AppModule, Postgres +
// Redis Testcontainers) -- ledger extensions of the sibling file's success /
// permission-denial scenarios.
// =============================================================================

type MentionActionWorkerConstructorReal = new (
  db: Database,
  skillExecutionService: SkillExecutionService,
  commentsService: CommentsService,
  agentActionRecordsService: AgentActionRecordsService,
) => MentionActionWorkerLike;

describe('F3-T4 PR3 (RED step): MentionActionWorker ledger wiring -- real SkillExecutionService chain (full AppModule, Postgres+Redis Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let app: INestApplication;
  let db: Database;
  let commentsService: CommentsService;
  let agentDirectoryService: AgentDirectoryService;
  let permissionsService: AgentPermissionManifestsService;
  let agentActionRecordsService: AgentActionRecordsService;
  let embeddingProvider: EmbeddingProvider;
  let worker: MentionActionWorkerLike;
  let workspaceCounter = 0;
  let agentCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    redisContainer = await new RedisContainer('redis:7').start();

    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = redisContainer.getConnectionUrl();
    delete process.env.ANTHROPIC_API_KEY;

    await runMigrations(container.getConnectionUri());
    db = createDatabaseClient(container.getConnectionUri());

    const { AppModule } = await import('../app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    commentsService = app.get(CommentsService);
    agentDirectoryService = app.get(AgentDirectoryService);
    agentActionRecordsService = app.get(AgentActionRecordsService);

    const permissionsModule: unknown =
      await import('../agent-runtime/agent-permission-manifests.service.js');
    const AgentPermissionManifestsServiceCtor = (
      permissionsModule as {
        AgentPermissionManifestsService: Type<AgentPermissionManifestsService>;
      }
    ).AgentPermissionManifestsService;
    permissionsService = app.get(AgentPermissionManifestsServiceCtor);

    embeddingProvider = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);

    // Deliberately NOT resolvable to a 4-arg-aware instance until
    // `implementer` wires `AgentActionRecordsService` into
    // `MentionActionWorker`'s constructor -- see this file's header for the
    // resulting RED state (the constructor resolves fine via Nest DI either
    // way; the RED signal comes from the ledger assertions below).
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
        name: `mention-worker-ledger-real-chain-test-${String(workspaceCounter)}`,
        slug: `mention-worker-ledger-real-chain-test-${String(workspaceCounter)}`,
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
    return `mention-worker-ledger-real-chain-test-${label}-agent-${String(agentCounter)}`;
  }

  async function seedSearchIndexRow(
    workspaceId: string,
    objectId: string,
    title: string,
    docText: string,
  ): Promise<void> {
    await db.insert(searchIndex).values({
      objectId,
      workspaceId,
      title,
      docText,
      tsv: sql`to_tsvector('simple', ${title} || ' ' || ${docText})`,
      updatedAt: new Date(),
    });
  }

  async function attachEmbeddingForText(objectId: string, text: string): Promise<void> {
    const { vector } = await embeddingProvider.embed({ text });
    await db
      .update(searchIndex)
      .set({ embedding: vector })
      .where(eq(searchIndex.objectId, objectId));
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
      createdBy: 'mention-worker-ledger-real-chain-test-harness',
      createdAt: now,
      updatedAt: now,
      lifecycle: 'active',
      fieldValues: {},
    });
    return objectId;
  }

  async function getLedgerRecords(workspaceId: string): Promise<AgentActionRecord[]> {
    return agentActionRecordsService.list(workspaceId, 'member');
  }

  function findRecordByActionType(
    records: AgentActionRecord[],
    actionType: string,
  ): AgentActionRecord | undefined {
    return records.find((record) => record.actionType === actionType);
  }

  it('12. success path: a real answer-question resolution writes exactly one ledger record with provenance autonomous, the fixed intent/rationale template strings, resources [object, comment], rollbackPlan delete targeting the reply comment, outcome succeeded, resultRef the reply comment, causationEventId null', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Ledger Mention Success Target');
    const agentIdentifier = freshAgentIdentifier('success');
    await agentDirectoryService.register(workspaceId, fakeActor(), 'admin', {
      name: 'LedgerMentionSuccessBot',
      agentIdentifier,
    });

    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['answer-question'],
      timeWindow: { startsAt: null, expiresAt: null },
    });

    const plantedAnswer = 'Ledger-driven planted answer, unique to this success test.';
    const body = `Hey @LedgerMentionSuccessBot, can you help? ${returnDirective(plantedAnswer)}`;
    const objectTitle = 'Ledger Mention Success Target';
    await seedSearchIndexRow(workspaceId, objectId, objectTitle, 'placeholder doc text');
    const expectedQuestion = `Regarding "${objectTitle}": ${body}`;
    await attachEmbeddingForText(objectId, expectedQuestion);

    const comment = await commentsService.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body,
    });
    expect(comment.mentionedAgentIds).toHaveLength(1);

    const recordsBefore = await getLedgerRecords(workspaceId);
    expect(findRecordByActionType(recordsBefore, 'answer-question')).toBeUndefined();

    await worker.runOnce();

    const records = await getLedgerRecords(workspaceId);
    const matching = records.filter((record) => record.actionType === 'answer-question');
    expect(matching).toHaveLength(1);
    const record = matching[0];

    expect(record?.provenance).toBe('autonomous');
    expect(record?.actor).toEqual({ type: 'agent', id: agentIdentifier });
    expect(record?.actionType).toBe('answer-question');
    expect(record?.intent).toBe(AUTONOMOUS_MENTION_INTENT);
    expect(record?.rationale).toBe(AUTONOMOUS_MENTION_RATIONALE);
    // Never the raw question/body/answer text leaking into intent/rationale.
    expect(record?.intent).not.toContain(plantedAnswer);
    expect(record?.rationale).not.toContain(plantedAnswer);
    expect(record?.resources).toEqual([objectResource(objectId), commentResource(comment.id)]);
    expect(record?.rollbackPlan.kind).toBe('delete');
    expectNonEmptyString(record?.rollbackPlan.description);
    expect(record?.outcome).toBe('succeeded');
    expect(record?.causationEventId).toBeNull();

    // `resultRef`/`rollbackPlan.targetResource` both reference the ACTUAL
    // reply comment id, read back independently from `mention_actions`.
    const replyRow = await db.execute<{ reply_comment_id: string | null }>(sql`
      SELECT reply_comment_id FROM mention_actions WHERE comment_id = ${comment.id}
    `);
    const replyCommentId = replyRow.rows[0]?.reply_comment_id;
    expect(replyCommentId).toBeTruthy();
    expect(record?.resultRef).toEqual(commentResource(replyCommentId as string));
    expect(record?.rollbackPlan.targetResource).toEqual(commentResource(replyCommentId as string));
  });

  it('13. permission-denial path: ForbiddenError from executeSkill writes exactly one terminal ledger record with outcome failed, rollbackPlan kind none, resultRef null, causationEventId null, on the FIRST (and only) attempt', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Ledger Denied Mention Target');
    const agentIdentifier = freshAgentIdentifier('denied');
    await agentDirectoryService.register(workspaceId, fakeActor(), 'admin', {
      name: 'LedgerMentionDeniedBot',
      agentIdentifier,
    });
    // Deliberately NO permissionsService.grant call.

    const secretBody = 'ledger-test-body-must-never-appear-in-any-ledger-field';
    const body = `Hey @LedgerMentionDeniedBot, are you allowed to help? ${secretBody} ${returnDirective('should never be reached')}`;
    const comment = await commentsService.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body,
    });

    await worker.runOnce();

    const records = await getLedgerRecords(workspaceId);
    const matching = records.filter((record) => record.actionType === 'answer-question');
    expect(matching).toHaveLength(1);
    const record = matching[0];

    expect(record?.provenance).toBe('autonomous');
    expect(record?.actor).toEqual({ type: 'agent', id: agentIdentifier });
    expect(record?.intent).toBe(AUTONOMOUS_MENTION_INTENT);
    expect(record?.rationale).toBe(AUTONOMOUS_MENTION_RATIONALE);
    expect(record?.resources).toEqual([objectResource(objectId), commentResource(comment.id)]);
    expect(record?.rollbackPlan.kind).toBe('none');
    expectNonEmptyString(record?.rollbackPlan.description);
    expect(record?.outcome).toBe('failed');
    expect(record?.resultRef).toBeNull();
    expect(record?.causationEventId).toBeNull();
    // The sanitized `last_error`/ledger fields never leak the mention body.
    expect(record?.rollbackPlan.description).not.toContain(secretBody);
    expect(record?.rationale).not.toContain(secretBody);

    // Never retried again -- a second runOnce() after granting permission
    // must not produce a second ledger record for the same mention.
    await permissionsService.grant(workspaceId, fakeActor(), 'admin', {
      agentIdentifier,
      dataScope: { objectTypes: 'all' },
      actionTypes: ['answer-question'],
      timeWindow: { startsAt: null, expiresAt: null },
    });
    await worker.runOnce();

    const recordsAfterSecondRun = await getLedgerRecords(workspaceId);
    expect(
      recordsAfterSecondRun.filter((entry) => entry.actionType === 'answer-question'),
    ).toHaveLength(1);
  });
});

// =============================================================================
// DESCRIBE B -- ledger-only queue-state logic via a scripted
// SkillExecutionServiceLike test double (Postgres Testcontainers only, no
// Redis/AppModule) -- this file's most important RED-defining block: proves
// "only the FINAL outcome is recorded, never one record per attempt".
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

function buildScriptedSkillExecutionService(
  script: Map<string, ScriptedOutcome[]>,
): SkillExecutionServiceLike {
  return {
    executeSkill: (workspaceId, agentIdentifier) => {
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
  };
}

/** This PR's own pinned constructor shape: the CURRENT 3 args PLUS a 4th and
 * FINAL `agentActionRecordsService` -- exactly the shape this task's
 * description pins. Passing a 4th arg to a constructor that doesn't declare
 * it yet is a safe, non-throwing JS call (mirrors this file's header /
 * `commands.service.ledger.integration.test.ts`'s own identical reasoning). */
type MentionActionWorkerConstructorScripted = new (
  db: Database,
  skillExecutionService: SkillExecutionServiceLike,
  commentsService: CommentsService,
  agentActionRecordsService: AgentActionRecordsService,
) => MentionActionWorkerLike;

describe('F3-T4 PR3 (RED step): MentionActionWorker ledger wiring -- only the FINAL outcome is recorded (scripted SkillExecutionServiceLike double, Postgres Testcontainers only)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let agentDirectoryService: AgentDirectoryService;
  let commentsService: CommentsService;
  let agentActionRecordsService: AgentActionRecordsService;
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
    // Real (never mocked) collaborator -- mirrors PR2's own ledger test file
    // convention of instantiating already-merged PR1 collaborators directly.
    agentActionRecordsService = new AgentActionRecordsService(db, eventStore, projectionRunner);

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
        name: `mention-worker-ledger-scripted-test-${String(workspaceCounter)}`,
        slug: `mention-worker-ledger-scripted-test-${String(workspaceCounter)}`,
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
    return `mention-worker-ledger-scripted-test-${label}-agent-${String(agentCounter)}`;
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
      createdBy: 'mention-worker-ledger-scripted-test-harness',
      createdAt: now,
      updatedAt: now,
      lifecycle: 'active',
      fieldValues: {},
    });
    return objectId;
  }

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

  async function readMentionActionRow(
    id: string,
  ): Promise<{ status: string; attempts: number } | undefined> {
    const result = await db.execute<{ status: string; attempts: number }>(sql`
      SELECT status, attempts FROM mention_actions WHERE id = ${id}
    `);
    return result.rows[0];
  }

  async function getLedgerRecords(workspaceId: string): Promise<AgentActionRecord[]> {
    return agentActionRecordsService.list(workspaceId, 'member');
  }

  function assertTerminalFailureRecordShape(
    record: AgentActionRecord | undefined,
    agentIdentifier: string,
    objectId: string,
    commentId: string,
  ): void {
    expect(record).toBeDefined();
    expect(record?.provenance).toBe('autonomous');
    expect(record?.actor).toEqual({ type: 'agent', id: agentIdentifier });
    expect(record?.actionType).toBe('answer-question');
    expect(record?.intent).toBe(AUTONOMOUS_MENTION_INTENT);
    expect(record?.rationale).toBe(AUTONOMOUS_MENTION_RATIONALE);
    expect(record?.resources).toEqual([objectResource(objectId), commentResource(commentId)]);
    expect(record?.rollbackPlan.kind).toBe('none');
    expectNonEmptyString(record?.rollbackPlan.description);
    expect(record?.outcome).toBe('failed');
    expect(record?.resultRef).toBeNull();
    expect(record?.causationEventId).toBeNull();
  }

  it('14. a "failure" outcome retried across 3 ticks (attempts 0->1->2->3): NO ledger record is written on the 1st or 2nd (merely-scheduled-retry) tick -- exactly ONE terminal "failed" record appears only after the 3rd (terminal) tick', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Ledger Failure Retry Target');
    const commentId = await insertCommentRow({ workspaceId, objectId, body: 'please help' });
    const agentIdentifier = freshAgentIdentifier('failure-retry');
    const rowId = await insertMentionActionRow({
      workspaceId,
      commentId,
      objectId,
      objectType: 'task',
      agentIdentifier,
    });

    function scriptedFailureWorker(errorMessage: string): MentionActionWorkerLike {
      const service = buildScriptedSkillExecutionService(
        new Map([
          [
            agentIdentifier,
            [{ kind: 'result', result: { outcome: 'failure', error: errorMessage } }],
          ],
        ]),
      );
      return new MentionActionWorker(db, service, commentsService, agentActionRecordsService);
    }

    // `retryOrFail` schedules the next attempt 30s+ (exponential backoff)
    // in the future -- force `next_attempt_at` back to "now" between ticks
    // so the row is actually due again immediately, rather than waiting out
    // real wall-clock backoff (no precedent for that anywhere in this
    // codebase; the sibling file's own equivalent scenario, test 8c,
    // presets `attempts` directly instead of ticking through real retries).
    // A JS-side `Date` value is passed as a query PARAMETER (not SQL
    // `now()`) so the exact millisecond-precision value written is what
    // `runOnce()`'s own SELECT reads back and `claimRow`'s optimistic-
    // concurrency equality check compares against -- `now()`'s own
    // microsecond precision would round-trip through node-postgres's
    // JS-`Date` (millisecond) representation and intermittently fail that
    // equality check.
    async function forceRowDueNow(): Promise<void> {
      const dueNow = new Date();
      await db.execute(
        sql`UPDATE mention_actions SET next_attempt_at = ${dueNow} WHERE id = ${rowId}`,
      );
    }

    // Tick 1: attempts 0 -> 1, stays pending.
    await scriptedFailureWorker('boom-1').runOnce();
    let row = await readMentionActionRow(rowId);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(await getLedgerRecords(workspaceId)).toHaveLength(0);

    // Tick 2: attempts 1 -> 2, stays pending -- STILL no ledger record.
    await forceRowDueNow();
    await scriptedFailureWorker('boom-2').runOnce();
    row = await readMentionActionRow(rowId);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(2);
    expect(await getLedgerRecords(workspaceId)).toHaveLength(0);

    await forceRowDueNow();

    // Tick 3: attempts 2 -> 3, terminal "failed" -- exactly ONE record now.
    await scriptedFailureWorker('boom-3-final').runOnce();
    row = await readMentionActionRow(rowId);
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(3);

    const records = await getLedgerRecords(workspaceId);
    expect(records).toHaveLength(1);
    assertTerminalFailureRecordShape(records[0], agentIdentifier, objectId, commentId);
  });

  it('15. a "timeout" outcome exhausting MAX_ATTEMPTS also writes exactly ONE terminal "failed" ledger record, never one per attempt', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Ledger Timeout Retry Target');
    const commentId = await insertCommentRow({ workspaceId, objectId, body: 'please help' });
    const agentIdentifier = freshAgentIdentifier('timeout-retry');
    // Preset at attempts:2 -- mirrors the sibling file's own test 8c
    // precedent for exercising the terminal branch directly.
    const rowId = await insertMentionActionRow({
      workspaceId,
      commentId,
      objectId,
      objectType: 'task',
      agentIdentifier,
      attempts: 2,
    });

    const service = buildScriptedSkillExecutionService(
      new Map([[agentIdentifier, [{ kind: 'result', result: { outcome: 'timeout' } }]]]),
    );
    const worker = new MentionActionWorker(db, service, commentsService, agentActionRecordsService);
    await worker.runOnce();

    const row = await readMentionActionRow(rowId);
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(3);

    const records = await getLedgerRecords(workspaceId);
    expect(records).toHaveLength(1);
    assertTerminalFailureRecordShape(records[0], agentIdentifier, objectId, commentId);
  });

  it('16. a ForbiddenError thrown by executeSkill on the very FIRST attempt (markFailedImmediately, never retried) writes exactly ONE terminal "failed" ledger record immediately -- no earlier or later record appears', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Ledger Immediate Forbidden Target');
    const commentId = await insertCommentRow({ workspaceId, objectId, body: 'please help' });
    const agentIdentifier = freshAgentIdentifier('immediate-forbidden');
    const rowId = await insertMentionActionRow({
      workspaceId,
      commentId,
      objectId,
      objectType: 'task',
      agentIdentifier,
    });

    const service = buildScriptedSkillExecutionService(
      new Map([[agentIdentifier, [{ kind: 'throw', error: new ForbiddenError() }]]]),
    );
    const worker = new MentionActionWorker(db, service, commentsService, agentActionRecordsService);
    await worker.runOnce();

    const row = await readMentionActionRow(rowId);
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(1);

    const records = await getLedgerRecords(workspaceId);
    expect(records).toHaveLength(1);
    assertTerminalFailureRecordShape(records[0], agentIdentifier, objectId, commentId);
  });

  it('17. a scripted "success" outcome writes exactly ONE ledger record with outcome succeeded, resultRef/rollbackPlan.targetResource pointing at the real reply comment id, causationEventId null', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Ledger Scripted Success Target');
    const commentId = await insertCommentRow({ workspaceId, objectId, body: 'please help' });
    const agentIdentifier = freshAgentIdentifier('scripted-success');
    const rowId = await insertMentionActionRow({
      workspaceId,
      commentId,
      objectId,
      objectType: 'task',
      agentIdentifier,
    });

    const plantedAnswer = 'Scripted planted answer, unique to this ledger success test.';
    const service = buildScriptedSkillExecutionService(
      new Map([
        [
          agentIdentifier,
          [{ kind: 'result', result: { outcome: 'success', value: { answer: plantedAnswer } } }],
        ],
      ]),
    );
    const worker = new MentionActionWorker(db, service, commentsService, agentActionRecordsService);
    await worker.runOnce();

    const row = await readMentionActionRow(rowId);
    expect(row?.status).toBe('done');

    const replyRow = await db.execute<{ reply_comment_id: string | null }>(sql`
      SELECT reply_comment_id FROM mention_actions WHERE id = ${rowId}
    `);
    const replyCommentId = replyRow.rows[0]?.reply_comment_id;
    expect(replyCommentId).toBeTruthy();

    const records = await getLedgerRecords(workspaceId);
    expect(records).toHaveLength(1);
    const record = records[0];

    expect(record?.provenance).toBe('autonomous');
    expect(record?.actor).toEqual({ type: 'agent', id: agentIdentifier });
    expect(record?.actionType).toBe('answer-question');
    expect(record?.intent).toBe(AUTONOMOUS_MENTION_INTENT);
    expect(record?.rationale).toBe(AUTONOMOUS_MENTION_RATIONALE);
    expect(record?.intent).not.toContain(plantedAnswer);
    expect(record?.resources).toEqual([objectResource(objectId), commentResource(commentId)]);
    expect(record?.rollbackPlan.kind).toBe('delete');
    expect(record?.rollbackPlan.targetResource).toEqual(commentResource(replyCommentId as string));
    expectNonEmptyString(record?.rollbackPlan.description);
    expect(record?.outcome).toBe('succeeded');
    expect(record?.resultRef).toEqual(commentResource(replyCommentId as string));
    expect(record?.causationEventId).toBeNull();
  });

  it('18. per-row isolation extends to the ledger: one row throwing an unexpected error (transient, retried, NOT yet terminal) writes no ledger record, while another row in the same runOnce() scan that succeeds writes exactly its own record', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Ledger Isolation Target');

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

    const service = buildScriptedSkillExecutionService(
      new Map([
        [agentA, [{ kind: 'throw', error: new Error('unexpected boom, not Forbidden/NotFound') }]],
        [
          agentB,
          [
            {
              kind: 'result',
              result: { outcome: 'success', value: { answer: 'B answered fine.' } },
            },
          ],
        ],
      ]),
    );
    const worker = new MentionActionWorker(db, service, commentsService, agentActionRecordsService);
    await worker.runOnce();

    const rowA = await readMentionActionRow(rowIdA);
    expect(rowA?.status).toBe('pending');
    expect(rowA?.attempts).toBe(1);

    const rowB = await readMentionActionRow(rowIdB);
    expect(rowB?.status).toBe('done');

    const records = await getLedgerRecords(workspaceId);
    // Row A is merely scheduled for retry (not terminal) -- no record for it.
    // Row B succeeded -- exactly one record, for agent B only.
    expect(records).toHaveLength(1);
    expect(records[0]?.actor).toEqual({ type: 'agent', id: agentB });
    expect(records[0]?.resources).toEqual([objectResource(objectId), commentResource(commentIdB)]);
  });
});
