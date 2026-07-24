import { eq } from 'drizzle-orm';

import { isValidFieldPermissions } from '@luminaos/core-objects';
import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { fieldDefinitions } from '../db/schema/field-definitions.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `ObjectsViewProjection`'s own `asDbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * `ProjectionTx` is intentionally opaque at the `packages/shared` level
 * (framework-free per CLAUDE.md); this concrete projection lives in
 * `apps/server` and needs a real Drizzle transaction to run queries —
 * mirrors `ObjectsViewProjection`'s own `asDbTransaction` pattern exactly.
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
 * `field_definitions` read-model projection: maps a field definition's `id`
 * (ULID) to its event stream's `streamId` (UUID) and mirrors its current,
 * derived state for cheap reads — the same role `ObjectsViewProjection`
 * plays for `objects_view`.
 */
export class FieldDefinitionsViewProjection implements Projection {
  readonly name = 'field-definitions';
  readonly handles: readonly string[] = ['FieldDefined', 'FieldUpdated', 'FieldArchived'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    switch (event.type) {
      case 'FieldDefined': {
        const fieldDefinitionId = requireStringPayloadField(event, 'fieldDefinitionId');
        const workspaceId = requireStringPayloadField(event, 'workspaceId');
        const objectType = requireStringPayloadField(event, 'objectType');
        const key = requireStringPayloadField(event, 'key');
        const fieldType = requireStringPayloadField(event, 'fieldType');
        const label = event.payload['label'];
        const permissions = event.payload['permissions'];

        if (typeof label !== 'string') {
          throw new InvalidObjectStateError(
            '"FieldDefined" event is missing a valid "label" payload field',
          );
        }

        if (!isValidFieldPermissions(permissions)) {
          throw new InvalidObjectStateError(
            '"FieldDefined" event is missing valid "permissions" payload field',
          );
        }

        // `onConflictDoNothing` on the business-uniqueness index: two
        // concurrent `define()` calls for the identical
        // (workspaceId, objectType, key) can both legitimately append their
        // own `FieldDefined` event (the event store has no knowledge of this
        // business rule — only this table's unique index does). Without this,
        // the "losing" insert would throw a raw Postgres unique-violation
        // INSIDE this catchUp transaction, aborting the whole batch (checkpoint
        // never advances) and permanently blocking this projection for EVERY
        // workspace from that point on (security review finding). Silently
        // skipping the losing insert keeps the projection healthy; the
        // "losing" caller is told about the conflict separately, by
        // `FieldDefinitionsService.define`'s post-catchUp existence check.
        await dbTx
          .insert(fieldDefinitions)
          .values({
            id: fieldDefinitionId,
            streamId: event.streamId,
            workspaceId,
            objectType,
            key,
            label,
            fieldType,
            config: event.payload['config'],
            defaultValue: event.payload['defaultValue'],
            permissions,
            lifecycle: 'active',
            createdAt: event.occurredAt,
            updatedAt: event.occurredAt,
          })
          .onConflictDoNothing({
            target: [
              fieldDefinitions.workspaceId,
              fieldDefinitions.objectType,
              fieldDefinitions.key,
            ],
          });
        return;
      }
      case 'FieldUpdated': {
        const fieldDefinitionId = requireStringPayloadField(event, 'fieldDefinitionId');

        const updates: Partial<typeof fieldDefinitions.$inferInsert> = {
          updatedAt: event.occurredAt,
        };

        const label = event.payload['label'];
        if (label !== undefined) {
          if (typeof label !== 'string') {
            throw new InvalidObjectStateError(
              '"FieldUpdated" event has an invalid "label" payload field',
            );
          }
          updates.label = label;
        }

        if (event.payload['config'] !== undefined) {
          updates.config = event.payload['config'];
        }

        if (event.payload['defaultValue'] !== undefined) {
          updates.defaultValue = event.payload['defaultValue'];
        }

        const permissions = event.payload['permissions'];
        if (permissions !== undefined) {
          if (!isValidFieldPermissions(permissions)) {
            throw new InvalidObjectStateError(
              '"FieldUpdated" event has invalid "permissions" payload field',
            );
          }
          updates.permissions = permissions;
        }

        await dbTx
          .update(fieldDefinitions)
          .set(updates)
          .where(eq(fieldDefinitions.id, fieldDefinitionId));
        return;
      }
      case 'FieldArchived': {
        const fieldDefinitionId = requireStringPayloadField(event, 'fieldDefinitionId');

        await dbTx
          .update(fieldDefinitions)
          .set({ lifecycle: 'archived', updatedAt: event.occurredAt })
          .where(eq(fieldDefinitions.id, fieldDefinitionId));
        return;
      }
      default:
        return;
    }
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(fieldDefinitions);
  }
}
