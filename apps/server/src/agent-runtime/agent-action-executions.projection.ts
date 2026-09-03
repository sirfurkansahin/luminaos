import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { agentActionExecutions } from '../db/schema/agent-action-executions.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `AIUsageProjection`'s own `asDbTransaction`). */
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

function requireIntegerPayloadField(event: DomainEvent, field: string): number {
  const value = event.payload[field];

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new InvalidObjectStateError(
      `"${event.type}" event is missing a valid "${field}" payload field`,
    );
  }

  return value;
}

/**
 * `agent_action_executions` read-model projection (F3-T1 PR3, ADR-0035 Karar
 * g): one row per `AgentActionExecutionRecorded` event -- a pure
 * append-only audit/accounting log, structurally identical to
 * `AIUsageProjection`, with no business-uniqueness constraint to reconcile
 * beyond the event's own id (idempotent replay never double-inserts).
 */
export class AgentActionExecutionsProjection implements Projection {
  readonly name = 'agent-action-executions';
  readonly handles: readonly string[] = ['AgentActionExecutionRecorded'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    if (event.type !== 'AgentActionExecutionRecorded') {
      return;
    }

    const dbTx = asDbTransaction(tx);

    const workspaceId = requireStringPayloadField(event, 'workspaceId');
    const agentIdentifier = requireStringPayloadField(event, 'agentIdentifier');
    const actionType = requireStringPayloadField(event, 'actionType');
    const outcome = requireStringPayloadField(event, 'outcome');
    const durationMs = requireIntegerPayloadField(event, 'durationMs');

    await dbTx
      .insert(agentActionExecutions)
      .values({
        id: event.id,
        workspaceId,
        agentIdentifier,
        actionType,
        outcome,
        durationMs,
        occurredAt: event.occurredAt,
      })
      .onConflictDoNothing({ target: agentActionExecutions.id });
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(agentActionExecutions);
  }
}
