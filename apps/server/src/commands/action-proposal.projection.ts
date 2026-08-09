import { eq } from 'drizzle-orm';

import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { commandProposals } from '../db/schema/command-proposals.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `RelationsViewProjection`/`AIUsageProjection`'s own `asDbTransaction`). */
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

function optionalStringPayloadField(event: DomainEvent, field: string): string | undefined {
  const value = event.payload[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidObjectStateError(
      `"${event.type}" event has an invalid "${field}" payload field`,
    );
  }

  return value;
}

function requireArrayPayloadField(event: DomainEvent, field: string): unknown[] {
  const value = event.payload[field];

  if (!Array.isArray(value)) {
    throw new InvalidObjectStateError(
      `"${event.type}" event is missing a valid "${field}" payload field`,
    );
  }

  return value;
}

/**
 * `command_proposals` read-model projection (F1-T16 PR4, ADR-0015 §a/§b):
 * one row per proposal, keyed by `proposalId` (`command_proposals.id`).
 * `ActionsProposed` inserts the row (idempotent, mirroring
 * `AIUsageProjection`'s `onConflictDoNothing` convention); `ActionsDecided`
 * updates the SAME row (matched by `proposalId`) — mirroring
 * `RelationsViewProjection`'s "switch on event.type, same table, one event
 * type per lifecycle stage" shape, since a proposal genuinely has two stages
 * writing to the same row.
 */
export class ActionProposalProjection implements Projection {
  readonly name = 'action-proposal';
  readonly handles: readonly string[] = ['ActionsProposed', 'ActionsDecided'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    switch (event.type) {
      case 'ActionsProposed': {
        const proposalId = requireStringPayloadField(event, 'proposalId');
        const workspaceId = requireStringPayloadField(event, 'workspaceId');
        const command = requireStringPayloadField(event, 'command');
        const actions = requireArrayPayloadField(event, 'actions');
        const sourceObjectId = optionalStringPayloadField(event, 'sourceObjectId');

        await dbTx
          .insert(commandProposals)
          .values({
            id: proposalId,
            streamId: event.streamId,
            workspaceId,
            command,
            sourceObjectId: sourceObjectId ?? null,
            actions,
            decisions: null,
            createdAt: event.occurredAt,
            decidedAt: null,
          })
          .onConflictDoNothing({ target: commandProposals.id });
        return;
      }
      case 'ActionsDecided': {
        const proposalId = requireStringPayloadField(event, 'proposalId');
        const decisions = requireArrayPayloadField(event, 'decisions');

        await dbTx
          .update(commandProposals)
          .set({ decisions, decidedAt: event.occurredAt })
          .where(eq(commandProposals.id, proposalId));
        return;
      }
      default:
        return;
    }
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(commandProposals);
  }
}
