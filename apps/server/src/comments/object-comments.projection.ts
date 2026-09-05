import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { objectComments } from '../db/schema/object-comments.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `AgentDirectoryProjection`'s own `asDbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function asDbTransaction(tx: ProjectionTx): DbTransaction {
  return tx as unknown as DbTransaction;
}

function requireStringPayloadField(event: DomainEvent, field: string): string {
  const value = event.payload[field];

  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidObjectStateError(
      `"${event.type}" event is missing a valid "${field}" payload field`,
    );
  }

  return value;
}

function requireStringArrayPayloadField(event: DomainEvent, field: string): string[] {
  const value = event.payload[field];

  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new InvalidObjectStateError(
      `"${event.type}" event is missing a valid "${field}" payload field`,
    );
  }

  return value;
}

/**
 * `object_comments` read-model projection (F3-T3, ADR-0037 Karar c) — mirrors
 * `AgentDirectoryProjection`'s exact shape. Each `CommentAdded` event lives on
 * its OWN fresh stream (one event per stream, never updated in place) —
 * there is no "comment edited/deleted" event yet, so `apply` only ever
 * inserts, never updates.
 */
export class ObjectCommentsProjection implements Projection {
  readonly name = 'object-comments';
  readonly handles: readonly string[] = ['CommentAdded'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    switch (event.type) {
      case 'CommentAdded': {
        const commentId = requireStringPayloadField(event, 'commentId');
        const workspaceId = requireStringPayloadField(event, 'workspaceId');
        const objectId = requireStringPayloadField(event, 'objectId');
        const body = requireStringPayloadField(event, 'body');
        const mentionedAgentIds = requireStringArrayPayloadField(event, 'mentionedAgentIds');

        await dbTx.insert(objectComments).values({
          id: commentId,
          streamId: event.streamId,
          workspaceId,
          objectId,
          authorActor: event.actor,
          body,
          mentionedAgentIds,
          createdAt: event.occurredAt,
        });
        return;
      }
      default:
        return;
    }
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(objectComments);
  }
}
