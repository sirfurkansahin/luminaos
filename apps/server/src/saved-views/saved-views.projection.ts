import { eq } from 'drizzle-orm';

import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { savedViews } from '../db/schema/saved-views.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `FieldDefinitionsViewProjection`'s own `asDbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * `ProjectionTx` is intentionally opaque at the `packages/shared` level
 * (framework-free per CLAUDE.md); this concrete projection lives in
 * `apps/server` and needs a real Drizzle transaction to run queries —
 * mirrors `FieldDefinitionsViewProjection`'s own `asDbTransaction` pattern
 * exactly.
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
 * `saved_views` read-model projection: maps a saved view's `id` (ULID) to its
 * event stream's `streamId` (UUID) and mirrors its current, derived state for
 * cheap reads — the same role `FieldDefinitionsViewProjection` plays for
 * `field_definitions`.
 *
 * `SavedViewDeleted` does NOT hard-delete the row (unlike
 * `RelationsViewProjection`'s `RelationRemoved`) — it sets
 * `lifecycle: 'deleted'`, mirroring `field-definitions.projection.ts`'s
 * `FieldArchived` handler exactly (F1-T9 plan's soft-delete discipline).
 */
export class SavedViewsViewProjection implements Projection {
  readonly name = 'saved-views';
  readonly handles: readonly string[] = [
    'SavedViewCreated',
    'SavedViewUpdated',
    'SavedViewDeleted',
  ];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    switch (event.type) {
      case 'SavedViewCreated': {
        const savedViewId = requireStringPayloadField(event, 'savedViewId');
        const workspaceId = requireStringPayloadField(event, 'workspaceId');
        const objectType = requireStringPayloadField(event, 'objectType');
        const name = requireStringPayloadField(event, 'name');
        const icon = requireStringPayloadField(event, 'icon');
        const viewType = requireStringPayloadField(event, 'viewType');
        const querySpec = event.payload['querySpec'];
        const ownerId = event.payload['ownerId'];
        const dateField = event.payload['dateField'];
        const startField = event.payload['startField'];
        const endField = event.payload['endField'];

        if (typeof querySpec !== 'object' || querySpec === null) {
          throw new InvalidObjectStateError(
            '"SavedViewCreated" event is missing a valid "querySpec" payload field',
          );
        }

        if (ownerId !== null && typeof ownerId !== 'string') {
          throw new InvalidObjectStateError(
            '"SavedViewCreated" event has an invalid "ownerId" payload field',
          );
        }

        await dbTx.insert(savedViews).values({
          id: savedViewId,
          streamId: event.streamId,
          workspaceId,
          objectType,
          name,
          icon,
          viewType,
          querySpec,
          dateField: typeof dateField === 'string' ? dateField : null,
          startField: typeof startField === 'string' ? startField : null,
          endField: typeof endField === 'string' ? endField : null,
          ownerId,
          lifecycle: 'active',
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        });
        return;
      }
      case 'SavedViewUpdated': {
        const savedViewId = requireStringPayloadField(event, 'savedViewId');

        const updates: Partial<typeof savedViews.$inferInsert> = {
          updatedAt: event.occurredAt,
        };

        const name = event.payload['name'];
        if (name !== undefined) {
          if (typeof name !== 'string' || name.length === 0) {
            throw new InvalidObjectStateError(
              '"SavedViewUpdated" event has an invalid "name" payload field',
            );
          }
          updates.name = name;
        }

        const icon = event.payload['icon'];
        if (icon !== undefined) {
          if (typeof icon !== 'string' || icon.length === 0) {
            throw new InvalidObjectStateError(
              '"SavedViewUpdated" event has an invalid "icon" payload field',
            );
          }
          updates.icon = icon;
        }

        const querySpec = event.payload['querySpec'];
        if (querySpec !== undefined) {
          if (typeof querySpec !== 'object' || querySpec === null) {
            throw new InvalidObjectStateError(
              '"SavedViewUpdated" event has an invalid "querySpec" payload field',
            );
          }
          updates.querySpec = querySpec;
        }

        const dateField = event.payload['dateField'];
        if (dateField !== undefined) {
          if (typeof dateField !== 'string') {
            throw new InvalidObjectStateError(
              '"SavedViewUpdated" event has an invalid "dateField" payload field',
            );
          }
          updates.dateField = dateField;
        }

        const startField = event.payload['startField'];
        if (startField !== undefined) {
          if (typeof startField !== 'string') {
            throw new InvalidObjectStateError(
              '"SavedViewUpdated" event has an invalid "startField" payload field',
            );
          }
          updates.startField = startField;
        }

        const endField = event.payload['endField'];
        if (endField !== undefined) {
          if (typeof endField !== 'string') {
            throw new InvalidObjectStateError(
              '"SavedViewUpdated" event has an invalid "endField" payload field',
            );
          }
          updates.endField = endField;
        }

        await dbTx.update(savedViews).set(updates).where(eq(savedViews.id, savedViewId));
        return;
      }
      case 'SavedViewDeleted': {
        const savedViewId = requireStringPayloadField(event, 'savedViewId');

        await dbTx
          .update(savedViews)
          .set({ lifecycle: 'deleted', updatedAt: event.occurredAt })
          .where(eq(savedViews.id, savedViewId));
        return;
      }
      default:
        return;
    }
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(savedViews);
  }
}
