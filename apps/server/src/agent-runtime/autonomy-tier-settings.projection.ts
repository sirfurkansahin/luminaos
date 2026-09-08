import { newObjectId } from '@luminaos/core-objects';
import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { taskAutonomySettings } from '../db/schema/task-autonomy-settings.js';

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
 * F3-T5 (ADR-0039 Karar a/b): `task_autonomy_settings` read-model
 * projection — structurally the same shape as
 * `AgentPermissionManifestProjection`: upserts on `(workspaceId,
 * actionType)`, a single current value per key (no history rows).
 * `updatedByType`/`updatedById` come from the envelope's own `actor`, never
 * the payload.
 */
export class TaskAutonomySettingProjection implements Projection {
  readonly name = 'task-autonomy-setting';
  readonly handles: readonly string[] = ['TaskAutonomyTierSet'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    const workspaceId = event.workspaceId;
    const actionType = requireStringPayloadField(event, 'actionType');
    const tier = requireStringPayloadField(event, 'tier');

    await dbTx
      .insert(taskAutonomySettings)
      .values({
        id: newObjectId(),
        workspaceId,
        actionType,
        tier,
        updatedByType: event.actor.type,
        updatedById: event.actor.id,
        updatedAt: event.occurredAt,
      })
      .onConflictDoUpdate({
        target: [taskAutonomySettings.workspaceId, taskAutonomySettings.actionType],
        set: {
          tier,
          updatedByType: event.actor.type,
          updatedById: event.actor.id,
          updatedAt: event.occurredAt,
        },
      });
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(taskAutonomySettings);
  }
}
