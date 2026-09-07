import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';
import { InvalidObjectStateError } from '@luminaos/shared';

import { dmMessages } from '../db/schema/dm-messages.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `MemoryAccessPolicyProjection`'s own `asDbTransaction`). */
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

function nullableStringPayloadField(event: DomainEvent, field: string): string | null {
  const value = event.payload[field];

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new InvalidObjectStateError(
      `"${event.type}" event has an invalid "${field}" payload field (expected string or null)`,
    );
  }

  return value;
}

/**
 * `dm_messages` read-model projection (F3-T3 PR5, ADR-0037 §4): inserts one
 * row per `DirectMessageSent` event, plain insert-only (no upsert) — every
 * message is its own immutable row, mirroring `ActionProposalProjection`'s
 * insert-only shape for `ActionsProposed`, not `MemoryAccessPolicyProjection`'s
 * upsert-on-key shape.
 */
export class DmMessageProjection implements Projection {
  readonly name = 'dm-message';
  readonly handles: readonly string[] = ['DirectMessageSent'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    if (event.type !== 'DirectMessageSent') {
      return;
    }

    const messageId = requireStringPayloadField(event, 'messageId');
    const userId = requireStringPayloadField(event, 'userId');
    const agentIdentifier = requireStringPayloadField(event, 'agentIdentifier');
    const sender = requireStringPayloadField(event, 'sender');
    const body = requireStringPayloadField(event, 'body');
    const proposalId = nullableStringPayloadField(event, 'proposalId');

    await dbTx.insert(dmMessages).values({
      id: messageId,
      workspaceId: event.workspaceId,
      userId,
      agentIdentifier,
      sender,
      body,
      proposalId,
      createdAt: event.occurredAt,
    });
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(dmMessages);
  }
}
