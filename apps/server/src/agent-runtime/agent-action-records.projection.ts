import { newObjectId } from '@luminaos/core-objects';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';
import { InvalidObjectStateError } from '@luminaos/shared';

import { agentActionRecords } from '../db/schema/agent-action-records.js';

import type { Database } from '../db/client.js';

/** Mirrors `AgentPermissionManifestProjection`'s own `asDbTransaction`. */
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

/**
 * F3-T4 (ADR-0038 Karar a/b): `agent_action_records` read-model projection.
 * INSERT-ONLY -- each `AgentActionRecorded` event lives on its own fresh
 * stream and is never updated (unlike `AgentPermissionManifestProjection`'s
 * per-key upsert), so `apply` never needs an `onConflictDoUpdate`. The row's
 * own primary key is a fresh `newObjectId()` (ULID), independent of the
 * event's `streamId` -- mirrors `AgentDirectoryProjection`'s "row id decided
 * at projection time" convention. `actor`/`occurredAt` are read off the
 * envelope (`event.actor`/`event.occurredAt`), never off the payload --
 * matches `agentActionRecordedPayloadSchema`'s `.strict()` exclusion of both.
 */
export class AgentActionRecordProjection implements Projection {
  readonly name = 'agent-action-record';
  readonly handles: readonly string[] = ['AgentActionRecorded'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    const resultRef = event.payload['resultRef'];
    const causationEventId = event.payload['causationEventId'];

    await dbTx.insert(agentActionRecords).values({
      id: newObjectId(),
      workspaceId: event.workspaceId,
      provenance: requireStringPayloadField(event, 'provenance'),
      actorType: event.actor.type,
      actorId: event.actor.id,
      actionType: requireStringPayloadField(event, 'actionType'),
      intent: requireStringPayloadField(event, 'intent'),
      rationale: requireStringPayloadField(event, 'rationale'),
      resources: event.payload['resources'],
      rollbackPlan: event.payload['rollbackPlan'],
      outcome: requireStringPayloadField(event, 'outcome'),
      resultRef: resultRef === undefined ? null : resultRef,
      causationEventId:
        typeof causationEventId === 'string' && causationEventId.length > 0
          ? causationEventId
          : null,
      occurredAt: event.occurredAt,
    });
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(agentActionRecords);
  }
}
