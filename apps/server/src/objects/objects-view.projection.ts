import { eq, sql } from 'drizzle-orm';

import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { objectsView } from '../db/schema/objects-view.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `EventStoreService`'s own `DbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * `ProjectionTx` is intentionally opaque at the `packages/shared` level
 * (framework-free per CLAUDE.md); this concrete projection lives in
 * `apps/server` and needs a real Drizzle transaction to run queries, so it
 * casts the opaque handle back — mirroring `WorkspaceEventCounterProjection`'s
 * own `asDbTransaction` pattern.
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
 * `objects_view` read-model projection (ADR-0003 "Okuma modeli ve
 * projeksiyon tazeliği"): maps a Lumina Object's `id` (ULID) to its event
 * stream's `streamId` (UUID) and mirrors its current, derived state
 * (`title`/`lifecycle`/timestamps) for cheap reads.
 */
export class ObjectsViewProjection implements Projection {
  readonly name = 'objects-view';
  readonly handles: readonly string[] = [
    'ObjectCreated',
    'ObjectRenamed',
    'ObjectArchived',
    'ObjectRestored',
    'ObjectSoftDeleted',
    'FieldValueChanged',
  ];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    switch (event.type) {
      case 'ObjectCreated': {
        const objectId = requireStringPayloadField(event, 'objectId');
        const objectType = requireStringPayloadField(event, 'objectType');
        const title = event.payload['title'];

        if (typeof title !== 'string') {
          throw new InvalidObjectStateError(
            '"ObjectCreated" event is missing a valid "title" payload field',
          );
        }

        // `onConflictDoNothing` on the primary key: an idempotent replay of
        // an `ObjectCreated` event whose row is already present (e.g. a test
        // seeding a fully-consistent `events` + `objects_view` pair directly,
        // ahead of this projection's own checkpoint) is a no-op rather than a
        // raw Postgres unique-violation that would abort the whole catch-up
        // batch and permanently wedge this projection — mirrors
        // `FieldDefinitionsViewProjection`'s own `FieldDefined` handling.
        await dbTx
          .insert(objectsView)
          .values({
            id: objectId,
            streamId: event.streamId,
            type: objectType,
            workspaceId: event.workspaceId,
            title,
            createdBy: event.actor.id,
            createdAt: event.occurredAt,
            updatedAt: event.occurredAt,
            lifecycle: 'active',
          })
          .onConflictDoNothing({ target: objectsView.id });
        return;
      }
      case 'ObjectRenamed': {
        const objectId = requireStringPayloadField(event, 'objectId');
        const title = event.payload['title'];

        if (typeof title !== 'string') {
          throw new InvalidObjectStateError(
            '"ObjectRenamed" event is missing a valid "title" payload field',
          );
        }

        await dbTx
          .update(objectsView)
          .set({ title, updatedAt: event.occurredAt })
          .where(eq(objectsView.id, objectId));
        return;
      }
      case 'ObjectArchived': {
        const objectId = requireStringPayloadField(event, 'objectId');

        await dbTx
          .update(objectsView)
          .set({ lifecycle: 'archived', updatedAt: event.occurredAt })
          .where(eq(objectsView.id, objectId));
        return;
      }
      case 'ObjectRestored': {
        const objectId = requireStringPayloadField(event, 'objectId');

        await dbTx
          .update(objectsView)
          .set({ lifecycle: 'active', updatedAt: event.occurredAt })
          .where(eq(objectsView.id, objectId));
        return;
      }
      case 'ObjectSoftDeleted': {
        const objectId = requireStringPayloadField(event, 'objectId');

        await dbTx
          .update(objectsView)
          .set({ lifecycle: 'deleted', updatedAt: event.occurredAt })
          .where(eq(objectsView.id, objectId));
        return;
      }
      case 'FieldValueChanged': {
        const objectId = requireStringPayloadField(event, 'objectId');
        const fieldKey = requireStringPayloadField(event, 'fieldKey');
        const value = event.payload['value'];

        // SECURITY: `fieldKey`/`value` are untrusted event payload content —
        // both are passed as BOUND `sql` template parameters (drizzle-orm
        // parameterizes every `${...}` interpolation into this tagged
        // template as a real query parameter), never string-concatenated
        // into the SQL text itself. `jsonb_set`'s path argument requires a
        // `text[]`, hence the explicit `ARRAY[...]::text[]` cast around the
        // bound `fieldKey`; `value` is bound as a JSON-serialized string and
        // cast to `jsonb` server-side, so it always lands as valid JSON
        // rather than a raw string when `value` is itself a string.
        await dbTx
          .update(objectsView)
          .set({
            fieldValues: sql`jsonb_set(${objectsView.fieldValues}, ARRAY[${fieldKey}]::text[], ${JSON.stringify(value)}::jsonb, true)`,
            updatedAt: event.occurredAt,
          })
          .where(eq(objectsView.id, objectId));
        return;
      }
      default:
        return;
    }
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(objectsView);
  }
}
