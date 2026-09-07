import { Logger } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';

import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { agents } from '../db/schema/agents.js';
import { mentionActions } from '../db/schema/mention-actions.js';
import { objectsView } from '../db/schema/objects-view.js';

import type { Database } from '../db/client.js';

/**
 * Security-review finding (F3-T3 PR3): `mentionedAgentIds` is a creation-time
 * snapshot that is NOT de-duplicated at the `CommentsService.create` layer
 * (each `@handle` occurrence resolves independently, per PR2's own pinned
 * contract) -- without a cap here, a single comment packed with repeated
 * `@handle` text could enqueue an unbounded number of `mention_actions` rows
 * and drive an unbounded number of real skill executions for the SAME
 * mention. Capped well below anything a legitimate comment would need.
 */
const MAX_MENTION_ACTIONS_PER_COMMENT = 20;

/**
 * F3-T3 PR6 (ADR-0037 hardening pass): `MAX_MENTION_ACTIONS_PER_COMMENT`
 * above only caps a SINGLE comment -- without a workspace-wide ceiling
 * across TIME, a user could post many separate comments in quick succession
 * and drive unbounded real skill executions for the workspace. Fixed module
 * constants (not env-configurable) deliberately mirror
 * `MAX_MENTION_ACTIONS_PER_COMMENT`'s own established style -- this file has
 * never read process config, and routing these two values through the
 * shared `env.ts` singleton would force this projection's (and every
 * caller's) tests to satisfy `env.ts`'s unrelated `DATABASE_URL`/`REDIS_URL`
 * boot-time guard just to import this module, which is not a tradeoff this
 * hardening-only change should make.
 */
const MENTION_ENQUEUE_RATE_LIMIT_PER_WINDOW = 100;

/** Rolling window size in milliseconds for `MENTION_ENQUEUE_RATE_LIMIT_PER_WINDOW` (F3-T3 PR6) -- 60 seconds, matching `AgentResourceLimitsService`'s own default window. */
const MENTION_ENQUEUE_RATE_LIMIT_WINDOW_MS = 60_000;

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `WebhookDeliveryEnqueueProjection`'s own `asDbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function asDbTransaction(tx: ProjectionTx): DbTransaction {
  return tx as unknown as DbTransaction;
}

/**
 * `mention_actions` enqueue projection (F3-T3 PR3, ADR-0037 Karar (c)/(3)):
 * turns a `CommentAdded` event's creation-time `mentionedAgentIds` snapshot
 * into one `mention_actions` queue row per resolved, still-active agent,
 * mirroring `WebhookDeliveryEnqueueProjection`'s exact shape. Run in a
 * SEPARATE `ProjectionRunner.catchUp` transaction from `CommentsService
 * .create`'s own primary `ObjectCommentsProjection` catch-up (see
 * `CommentsService.catchUpMentionActionEnqueue()`).
 *
 * Reads `mentionedAgentIds`/`objectId`/`commentId` from `event.payload`,
 * `workspaceId` from the event ENVELOPE's own `workspaceId` field (never
 * `event.payload.workspaceId`) -- mirrors `WebhookDeliveryEnqueueProjection`'s
 * identical discipline.
 *
 * Re-checks each mentioned agent id against `agents` (workspace-scoped,
 * `lifecycle: 'active'`) -- defense in depth against the brief window
 * between `CommentsService.create`'s own resolution-time snapshot and this
 * catch-up (an agent could be deactivated, or -- crafted-event edge case --
 * an id belonging to a DIFFERENT workspace could be force-injected into the
 * event payload). Looks up `objectId`'s `type` from `objects_view`
 * (workspace-scoped).
 */
export class MentionActionEnqueueProjection implements Projection {
  readonly name = 'mention-action-enqueue';
  readonly handles: readonly string[] = ['CommentAdded'];
  private readonly logger = new Logger(MentionActionEnqueueProjection.name);

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);
    const payload = event.payload as {
      commentId: string;
      objectId: string;
      mentionedAgentIds: string[];
    };

    if (payload.mentionedAgentIds.length === 0) {
      return;
    }

    const [objectRow] = await dbTx
      .select({ type: objectsView.type })
      .from(objectsView)
      .where(
        and(eq(objectsView.id, payload.objectId), eq(objectsView.workspaceId, event.workspaceId)),
      )
      .limit(1);

    if (!objectRow) {
      return;
    }

    const activeAgents = await dbTx
      .select({ id: agents.id, agentIdentifier: agents.agentIdentifier })
      .from(agents)
      .where(and(eq(agents.workspaceId, event.workspaceId), eq(agents.lifecycle, 'active')));

    const activeAgentsById = new Map(activeAgents.map((agent) => [agent.id, agent]));

    // Security-review finding (F3-T3 PR3): `mentionedAgentIds` can contain
    // the SAME agent id more than once (mention resolution is intentionally
    // not de-duplicated upstream) -- collapse to one action per distinct
    // agent, then cap the total, so one comment can never fan out into an
    // unbounded number of real skill executions for the same mention.
    const resolvedAgentsById = new Map<string, { id: string; agentIdentifier: string }>();
    for (const agentId of payload.mentionedAgentIds) {
      const agent = activeAgentsById.get(agentId);
      if (agent) {
        resolvedAgentsById.set(agent.id, agent);
      }
    }

    const resolvedAgents = Array.from(resolvedAgentsById.values()).slice(
      0,
      MAX_MENTION_ACTIONS_PER_COMMENT,
    );

    if (resolvedAgents.length === 0) {
      return;
    }

    // F3-T3 PR6 (ADR-0037 hardening pass): `MAX_MENTION_ACTIONS_PER_COMMENT`
    // above only caps a SINGLE comment -- without a workspace-wide ceiling
    // across TIME, a user could post many separate comments in quick
    // succession and drive unbounded real skill executions for the
    // workspace. Mirrors `AgentResourceLimitsService.assertActionRateNotExceeded`'s
    // COUNT-in-window pattern exactly, but UNLIKE that method, this NEVER
    // throws: `apply()` runs inside `ProjectionRunner.catchUp`, and throwing
    // here would drop ALL of this comment's mentions (including ones under
    // any limit) and disrupt the catch-up cycle for other comments too --
    // strictly worse than the "cap and skip" discipline already used above
    // for `MAX_MENTION_ACTIONS_PER_COMMENT`. Only `event.workspaceId` is
    // logged -- NEVER the comment body, `mentionedAgentIds`, or agent
    // identifiers.
    const windowStart = new Date(Date.now() - MENTION_ENQUEUE_RATE_LIMIT_WINDOW_MS);
    const [rateRow] = await dbTx
      .select({ total: sql<string>`COUNT(*)` })
      .from(mentionActions)
      .where(
        and(
          eq(mentionActions.workspaceId, event.workspaceId),
          gte(mentionActions.createdAt, windowStart),
        ),
      );
    const totalRecentlyEnqueued = Number(rateRow?.total ?? 0);

    if (totalRecentlyEnqueued >= MENTION_ENQUEUE_RATE_LIMIT_PER_WINDOW) {
      this.logger.warn(
        `Mention enqueue rate limit exceeded for workspace ${event.workspaceId}; skipping this comment's mentions.`,
      );
      return;
    }

    const now = new Date();

    await dbTx.insert(mentionActions).values(
      resolvedAgents.map((agent) => ({
        workspaceId: event.workspaceId,
        commentId: payload.commentId,
        objectId: payload.objectId,
        objectType: objectRow.type,
        agentIdentifier: agent.agentIdentifier,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        replyCommentId: null,
        lastError: null,
        createdAt: now,
      })),
    );
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(mentionActions);
  }
}
