import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';

import { ForbiddenError, NotFoundError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { MentionActionEnqueueProjection } from './mention-action-enqueue.projection.js';
import { ObjectCommentsProjection } from './object-comments.projection.js';
import { AgentDirectoryService } from '../agent-runtime/agent-directory.service.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { objectComments } from '../db/schema/object-comments.js';
import { objectsView } from '../db/schema/objects-view.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';

import type { Database } from '../db/client.js';
import type { MembershipRole } from '../workspaces/membership.util.js';

const STREAM_TYPE = 'object-comment';

/**
 * Fixed handle-mention regex (ADR-0037 Karar c) — the exact same handle
 * character class as `registerAgentSchema`'s `^[A-Za-z0-9_-]{2,32}$`
 * (`apps/server/src/agent-runtime/dto/register-agent.schema.ts`), bounded to
 * `{2,32}` repetitions so a pathological input (a very long run of word
 * characters after `@`) cannot cause catastrophic backtracking.
 */
const MENTION_REGEX = /@([A-Za-z0-9_-]{2,32})\b/g;

export interface ObjectComment {
  id: string;
  workspaceId: string;
  objectId: string;
  authorActor: Actor;
  body: string;
  mentionedAgentIds: string[];
  createdAt: Date;
}

export interface CreateCommentInput {
  objectId: string;
  body: string;
}

type ObjectCommentRow = typeof objectComments.$inferSelect;

function toObjectComment(row: ObjectCommentRow): ObjectComment {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    objectId: row.objectId,
    authorActor: row.authorActor as Actor,
    body: row.body,
    mentionedAgentIds: row.mentionedAgentIds as string[],
    createdAt: row.createdAt,
  };
}

/**
 * Extracts every candidate `@handle` from `body` using the fixed
 * `MENTION_REGEX` (ADR-0037 Karar c). Duplicates are NOT de-duplicated here —
 * each occurrence is resolved independently, mirroring the pinned contract
 * test's "no implicit de-duplication assumed beyond what resolution
 * naturally produces" expectation.
 */
function extractMentionCandidates(body: string): string[] {
  const candidates: string[] = [];
  for (const match of body.matchAll(MENTION_REGEX)) {
    const handle = match[1];
    if (handle !== undefined) {
      candidates.push(handle);
    }
  }
  return candidates;
}

/**
 * F3-T3 PR2 (ADR-0037 Karar c): `CommentsService`, the schema + CRUD for the
 * new, purpose-built `object_comments` @mention surface on top of Lumina
 * Objects. `body` is scanned for `@handle` candidates at CREATION TIME ONLY;
 * each candidate is resolved via `AgentDirectoryService.resolveByName`
 * (workspace-scoped, active-only, case-insensitive) and the resolved id list
 * is embedded into the comment as an immutable SNAPSHOT
 * (`mentionedAgentIds`) — never a live/dynamic reference. A candidate that
 * does not resolve to any active agent is SILENTLY dropped (never blocks
 * comment creation).
 *
 * Mention -> skill-execution wiring is explicitly OUT of scope here (PR3's
 * `MentionActionWorker`) — nothing is ever executed as a result of a mention
 * in this service.
 */
@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);
  private readonly projection = new ObjectCommentsProjection();
  private readonly mentionActionEnqueueProjection = new MentionActionEnqueueProjection();

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
    private readonly agentDirectoryService: AgentDirectoryService,
  ) {}

  async create(
    workspaceId: string,
    actor: Actor,
    callerRole: MembershipRole,
    input: CreateCommentInput,
  ): Promise<ObjectComment> {
    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    await this.requireObjectExists(workspaceId, input.objectId);

    // Anti-recursion guard (F3-T3 PR3): an agent-authored comment's own
    // mentions are NEVER resolved -- closes the ping-pong loop an agent's
    // own `@mention`-containing reply could otherwise create via
    // `MentionActionEnqueueProjection`/`MentionActionWorker`.
    const mentionedAgentIds =
      actor.type === 'agent' ? [] : await this.resolveMentions(workspaceId, input.body);

    const commentId = ulid();
    const streamId = randomUUID();

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: STREAM_TYPE,
      workspaceId,
      type: 'CommentAdded',
      payload: {
        commentId,
        workspaceId,
        objectId: input.objectId,
        body: input.body,
        mentionedAgentIds,
      },
      actor,
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, 0, [event]);
    await this.projectionRunner.catchUp(this.projection);
    await this.catchUpMentionActionEnqueue();

    return {
      id: commentId,
      workspaceId,
      objectId: input.objectId,
      authorActor: actor,
      body: input.body,
      mentionedAgentIds,
      createdAt: event.occurredAt,
    };
  }

  async list(
    workspaceId: string,
    callerRole: MembershipRole,
    objectId: string,
  ): Promise<ObjectComment[]> {
    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    await this.requireObjectExists(workspaceId, objectId);

    const rows = await this.db
      .select()
      .from(objectComments)
      .where(
        and(eq(objectComments.workspaceId, workspaceId), eq(objectComments.objectId, objectId)),
      )
      .orderBy(asc(objectComments.createdAt));

    return rows.map(toObjectComment);
  }

  /**
   * Resolves each `@handle` candidate found in `body` against
   * `AgentDirectoryService.resolveByName`, silently dropping any candidate
   * that does not resolve to any active agent in this workspace (ADR-0037
   * Karar c's "best-effort, never block the main action" precedent).
   */
  private async resolveMentions(workspaceId: string, body: string): Promise<string[]> {
    const candidates = extractMentionCandidates(body);
    const resolvedIds: string[] = [];

    for (const candidate of candidates) {
      const agent = await this.agentDirectoryService.resolveByName(workspaceId, candidate);
      if (agent) {
        resolvedIds.push(agent.id);
      }
    }

    return resolvedIds;
  }

  /**
   * Workspace-scoped existence check against `objects_view`, mirroring
   * `AgentDirectoryService.lookupStreamId`'s exact discipline: an `objectId`
   * that belongs to a different workspace, or doesn't exist at all, is a 404.
   */
  private async requireObjectExists(workspaceId: string, objectId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: objectsView.id })
      .from(objectsView)
      .where(and(eq(objectsView.id, objectId), eq(objectsView.workspaceId, workspaceId)))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Object not found');
    }
  }

  /**
   * F3-T3 PR3: runs `MentionActionEnqueueProjection` in a SEPARATE
   * `ProjectionRunner.catchUp` transaction from this class's own primary
   * `ObjectCommentsProjection` catch-up, mirroring `CommandsService
   * .catchUpWebhookDeliveryEnqueue()`'s identical precedent -- a comment is
   * already durably committed to the event log by the time this runs, so an
   * enqueue-projection failure must never be able to undo that or fail the
   * whole `create()` call. Log-only, never rethrown.
   */
  private async catchUpMentionActionEnqueue(): Promise<void> {
    try {
      await this.projectionRunner.catchUp(this.mentionActionEnqueueProjection);
    } catch (error) {
      this.logger.error(
        'Mention action enqueue projection catch-up failed; the comment itself was already committed.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
