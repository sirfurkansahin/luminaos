import { eq } from 'drizzle-orm';

import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { automationTriggers } from '../db/schema/automation-triggers.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `SavedViewsViewProjection`'s own `asDbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * `ProjectionTx` is intentionally opaque at the `packages/shared` level
 * (framework-free per CLAUDE.md); this concrete projection lives in
 * `apps/server` and needs a real Drizzle transaction to run queries —
 * mirrors `SavedViewsViewProjection`'s own `asDbTransaction` pattern exactly.
 */
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
 * `automation_triggers` read-model projection: maps a trigger's `id` (ULID)
 * to its event stream's `streamId` (UUID) and mirrors its current, derived
 * state for cheap reads — the same role `SavedViewsViewProjection` plays for
 * `saved_views` (ADR-0032).
 *
 * `TriggerDeleted` does NOT hard-delete the row — it sets
 * `lifecycle: 'deleted'`, mirroring `SavedViewsViewProjection`'s
 * `SavedViewDeleted` handler exactly.
 */
export class AutomationTriggersViewProjection implements Projection {
  readonly name = 'automation-triggers';
  readonly handles: readonly string[] = ['TriggerCreated', 'TriggerUpdated', 'TriggerDeleted'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    switch (event.type) {
      case 'TriggerCreated': {
        const triggerId = requireStringPayloadField(event, 'triggerId');
        const workspaceId = requireStringPayloadField(event, 'workspaceId');
        const name = requireStringPayloadField(event, 'name');
        const kind = requireStringPayloadField(event, 'kind');
        const spec = event.payload['spec'];

        if (typeof spec !== 'object' || spec === null) {
          throw new InvalidObjectStateError(
            '"TriggerCreated" event is missing a valid "spec" payload field',
          );
        }

        await dbTx.insert(automationTriggers).values({
          id: triggerId,
          streamId: event.streamId,
          workspaceId,
          name,
          kind,
          spec,
          lifecycle: 'active',
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        });
        return;
      }
      case 'TriggerUpdated': {
        const triggerId = requireStringPayloadField(event, 'triggerId');

        const updates: Partial<typeof automationTriggers.$inferInsert> = {
          updatedAt: event.occurredAt,
        };

        const name = event.payload['name'];
        if (name !== undefined) {
          if (typeof name !== 'string' || name.length === 0) {
            throw new InvalidObjectStateError(
              '"TriggerUpdated" event has an invalid "name" payload field',
            );
          }
          updates.name = name;
        }

        const spec = event.payload['spec'];
        if (spec !== undefined) {
          if (typeof spec !== 'object' || spec === null) {
            throw new InvalidObjectStateError(
              '"TriggerUpdated" event has an invalid "spec" payload field',
            );
          }

          const kind = (spec as Record<string, unknown>)['kind'];
          if (typeof kind !== 'string' || kind.length === 0) {
            throw new InvalidObjectStateError(
              '"TriggerUpdated" event has an invalid "spec.kind" payload field',
            );
          }

          updates.spec = spec;
          updates.kind = kind;
        }

        await dbTx
          .update(automationTriggers)
          .set(updates)
          .where(eq(automationTriggers.id, triggerId));
        return;
      }
      case 'TriggerDeleted': {
        const triggerId = requireStringPayloadField(event, 'triggerId');

        await dbTx
          .update(automationTriggers)
          .set({ lifecycle: 'deleted', updatedAt: event.occurredAt })
          .where(eq(automationTriggers.id, triggerId));
        return;
      }
      default:
        return;
    }
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(automationTriggers);
  }
}
