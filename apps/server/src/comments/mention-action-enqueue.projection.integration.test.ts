import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newObjectId } from '@luminaos/core-objects';
import type { Actor, NewDomainEvent, Projection } from '@luminaos/shared';

import { CommentsService } from './object-comments.service.js';
import { AgentDirectoryService } from '../agent-runtime/agent-directory.service.js';
import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { objectsView } from '../db/schema/objects-view.js';
import { workspaces } from '../db/schema/workspaces.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

/**
 * F3-T3 PR3 (RED step), ADR-0037 Karar (c)/(3) -- `MentionActionEnqueueProjection`:
 * the NEW projection that turns a `CommentAdded` event's creation-time
 * `mentionedAgentIds` snapshot into one `mention_actions` queue row per
 * resolved, still-active agent, mirroring `WebhookDeliveryEnqueueProjection`'s
 * exact shape (`implements Projection`, `handles: ['CommentAdded']`, run in a
 * SEPARATE `ProjectionRunner.catchUp` transaction from `CommentsService
 * .create`'s own primary `ObjectCommentsProjection` catch-up, wrapped in a
 * private `catchUpMentionActionEnqueue()` that only logs on failure, never
 * rethrows -- see `CommandsService.catchUpWebhookDeliveryEnqueue`'s identical
 * precedent).
 *
 * This file ALSO pins PR3's new anti-recursion guard on the ALREADY-MERGED
 * `CommentsService.create`: when `actor.type === 'agent'`, mention resolution
 * must be skipped ENTIRELY (`mentionedAgentIds` stays `[]`, nothing is ever
 * enqueued), closing the ping-pong loop an agent's own `@mention`-containing
 * reply could otherwise create.
 *
 * ============================================================================
 * EXPECTED RED STATE (today): the `mention_actions` TABLE does not exist yet
 * (no migration on disk) and `./mention-action-enqueue.projection.ts` does not
 * exist at all. Every `it` below therefore fails one of two ways -- both
 * acceptable RED reasons, NOT a bug in this test file:
 *   - tests 1-4 (`CommentsService.create` -> `readMentionActionRowsForComment`
 *     raw-SQL read): `db.execute` REJECTS with a Postgres
 *     `relation "mention_actions" does not exist` error the first time the
 *     raw SQL runs.
 *   - test 5 (direct projection invocation) additionally depends on the
 *     dynamic `import('./mention-action-enqueue.projection.js')` inside
 *     `beforeAll`, which REJECTS ("Cannot find module") -- since this
 *     `beforeAll` import failure aborts the whole file's setup, tests 1-4
 *     above will in PRACTICE also report this same "Cannot find module"
 *     failure rather than ever reaching their own raw-SQL rejection. Either
 *     failure mode implementer actually hits first is fine.
 *
 * `CommentsService`/`AgentDirectoryService`/`object_comments`/`agents` all
 * already exist (merged, PR1/PR2) -- statically imported here, exactly like
 * `object-comments.service.integration.test.ts`'s own already-GREEN file.
 *
 * `mention_actions` is read via raw parameterized SQL (`db.execute(sql\`...\`)`)
 * rather than a Drizzle schema import: unlike every prior PR in this task,
 * the table AND the projection that writes to it are BOTH introduced in this
 * same PR, so there is no already-existing, statically-importable schema
 * module to query through (mirrors this codebase's own established
 * precedent of never directly querying a schema that doesn't exist yet --
 * `agent-directory.service.integration.test.ts`'s PR1 RED file verified
 * everything through the SERVICE's own methods only). Column names below
 * (`workspace_id`, `comment_id`, `object_id`, `object_type`,
 * `agent_identifier`, `status`, `attempts`, `next_attempt_at`, `last_error`,
 * `reply_comment_id`, `created_at`) are the exact snake_case column names
 * this task's spec dictates for `apps/server/src/db/schema/mention-actions.ts`.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT PINNED BY THIS TEST FILE (implementer must match precisely):
 *   - `MentionActionEnqueueProjection` (`implements Projection`,
 *     `handles: ['CommentAdded']`): reads `mentionedAgentIds`/`objectId`/
 *     `commentId` from `event.payload`, `workspaceId` from the event
 *     ENVELOPE's own `workspaceId` field (never `event.payload.workspaceId`).
 *     Re-checks each mentioned agent id against `agents` (workspace-scoped,
 *     `lifecycle: 'active'`) -- defense in depth against the brief window
 *     between the original snapshot and this catch-up. Looks up `objectId`'s
 *     `type` from `objects_view` (workspace-scoped). Inserts one
 *     `mention_actions` row per resolved agent: `status: 'pending'`,
 *     `attempts: 0`, `next_attempt_at: now`, `reply_comment_id: null`,
 *     `last_error: null`.
 *   - `CommentsService.create`'s NEW anti-recursion guard: `actor.type ===
 *     'agent'` -> `mentionedAgentIds` is ALWAYS `[]`, mention resolution is
 *     skipped entirely, and (transitively, via the enqueue projection never
 *     seeing any mentioned ids) nothing is ever enqueued for an
 *     agent-authored comment.
 *   - `CommentsService.create`'s NEW enqueue wiring: after its existing
 *     `ObjectCommentsProjection` catch-up, a private
 *     `catchUpMentionActionEnqueue()` runs `MentionActionEnqueueProjection`
 *     in a SEPARATE catch-up call, log-only on failure, never rethrown.
 * ============================================================================
 */

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

type MentionActionEnqueueProjectionConstructor = new () => Projection;

describe('F3-T3 PR3 (RED step): MentionActionEnqueueProjection -- CommentAdded -> mention_actions enqueue, plus CommentsService.create anti-recursion guard (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let eventStore: EventStoreService;
  let projectionRunner: ProjectionRunner;
  let agentDirectoryService: AgentDirectoryService;
  let commentsService: CommentsService;
  let MentionActionEnqueueProjection: MentionActionEnqueueProjectionConstructor;
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

    // Deliberately NOT resolvable until `implementer` creates
    // `./mention-action-enqueue.projection.ts` -- see this file's header for
    // the resulting "Cannot find module" RED state this line produces.
    const projectionModule: unknown = await import('./mention-action-enqueue.projection.js');
    MentionActionEnqueueProjection = (
      projectionModule as {
        MentionActionEnqueueProjection: MentionActionEnqueueProjectionConstructor;
      }
    ).MentionActionEnqueueProjection;
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
        name: `mention-enqueue-test-workspace-${String(workspaceCounter)}`,
        slug: `mention-enqueue-test-workspace-${String(workspaceCounter)}`,
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
    return `mention-enqueue-test-${label}-agent-${String(agentCounter)}`;
  }

  /** Mirrors `object-comments.service.integration.test.ts`'s own `insertObject` helper. */
  async function insertObject(workspaceId: string, title = 'Test Object'): Promise<string> {
    const objectId = newObjectId();
    const now = new Date();
    await db.insert(objectsView).values({
      id: objectId,
      streamId: randomUUID(),
      type: 'task',
      workspaceId,
      title,
      createdBy: 'mention-enqueue-test-harness',
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

  async function appendCraftedCommentAddedEvent(params: {
    workspaceId: string;
    objectId: string;
    commentId: string;
    body: string;
    mentionedAgentIds: string[];
  }): Promise<void> {
    const streamId = randomUUID();
    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: 'object-comment',
      workspaceId: params.workspaceId,
      type: 'CommentAdded',
      payload: {
        commentId: params.commentId,
        workspaceId: params.workspaceId,
        objectId: params.objectId,
        body: params.body,
        mentionedAgentIds: params.mentionedAgentIds,
      },
      actor: fakeActor(),
      occurredAt: new Date(),
    };
    await eventStore.append(streamId, 0, [event]);
  }

  it('1. a comment mentioning one active agent enqueues exactly one mention_actions row with the correct workspaceId/commentId/objectId/objectType/agentIdentifier/status', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Enqueue Target');
    const agent = await registerAgent(
      workspaceId,
      'EnqueueBot',
      freshAgentIdentifier('enqueue-one'),
    );

    const comment = await commentsService.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body: 'Hey @EnqueueBot, please take a look.',
    });

    const rows = await readMentionActionRowsForComment(comment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspace_id).toBe(workspaceId);
    expect(rows[0]?.comment_id).toBe(comment.id);
    expect(rows[0]?.object_id).toBe(objectId);
    expect(rows[0]?.object_type).toBe('task');
    expect(rows[0]?.agent_identifier).toBe(agent.agentIdentifier);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.attempts).toBe(0);
    expect(rows[0]?.reply_comment_id).toBeNull();
  });

  it('2. a comment mentioning zero agents enqueues nothing', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'No Mention Target');

    const comment = await commentsService.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body: 'Just a plain comment, nobody mentioned here.',
    });

    const rows = await readMentionActionRowsForComment(comment.id);
    expect(rows).toHaveLength(0);
  });

  it('3. a comment mentioning multiple agents enqueues one row per agent', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Multi Mention Target');
    const agentA = await registerAgent(workspaceId, 'FirstBot', freshAgentIdentifier('multi-a'));
    const agentB = await registerAgent(workspaceId, 'SecondBot', freshAgentIdentifier('multi-b'));

    const comment = await commentsService.create(workspaceId, fakeActor(), 'member', {
      objectId,
      body: '@FirstBot and @SecondBot, please both take a look.',
    });

    const rows = await readMentionActionRowsForComment(comment.id);
    expect(rows).toHaveLength(2);
    const agentIdentifiers = rows.map((row) => row.agent_identifier).sort();
    expect(agentIdentifiers).toEqual([agentA.agentIdentifier, agentB.agentIdentifier].sort());
    for (const row of rows) {
      expect(row.status).toBe('pending');
      expect(row.object_id).toBe(objectId);
    }
  });

  it('4. an agent-authored comment (actor.type === "agent") NEVER resolves mentions or enqueues anything, even when its body contains a real active agent handle (anti-recursion guard)', async () => {
    const workspaceId = await createWorkspace();
    const objectId = await insertObject(workspaceId, 'Agent Authored Target');
    await registerAgent(workspaceId, 'EnqueueBot', freshAgentIdentifier('anti-recursion'));
    const callingAgentIdentifier = freshAgentIdentifier('caller');

    const comment = await commentsService.create(
      workspaceId,
      { type: 'agent', id: callingAgentIdentifier },
      'member',
      {
        objectId,
        body: 'Thanks for the context, looping in @EnqueueBot for visibility.',
      },
    );

    expect(comment.mentionedAgentIds).toEqual([]);

    const rows = await readMentionActionRowsForComment(comment.id);
    expect(rows).toHaveLength(0);
  });

  it('5. cross-workspace isolation: an agent id belonging to a DIFFERENT workspace never gets a row enqueued, even when force-injected into a crafted CommentAdded event (defense-in-depth re-check, not just resolveByName scoping)', async () => {
    const workspaceIdA = await createWorkspace();
    const workspaceIdB = await createWorkspace();
    const objectInA = await insertObject(workspaceIdA, 'Cross Workspace Target');
    const agentInB = await registerAgent(
      workspaceIdB,
      'ForeignBot',
      freshAgentIdentifier('foreign'),
    );

    const commentId = ulid();
    await appendCraftedCommentAddedEvent({
      workspaceId: workspaceIdA,
      objectId: objectInA,
      commentId,
      body: 'Crafted event referencing a foreign-workspace agent id directly.',
      mentionedAgentIds: [agentInB.id],
    });

    await projectionRunner.catchUp(new MentionActionEnqueueProjection());

    const rows = await readMentionActionRowsForComment(commentId);
    expect(rows).toHaveLength(0);
  });
});
