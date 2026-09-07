import { and, eq } from 'drizzle-orm';

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
