import { eq, sql } from 'drizzle-orm';

import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { relationsView } from '../db/schema/relations-view.js';

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
 * `relations_view` read-model projection: maps a relation's `id` (ULID) to
 * its event stream's `streamId` (UUID) and mirrors its current, derived
 * state for cheap reads — the same role `FieldDefinitionsViewProjection`
 * plays for `field_definitions`.
 *
 * Unlike that projection, `RelationRemoved` does not flip a lifecycle
 * column — it hard-deletes the row (per this PR's design note: there is no
 * "removed but visible" state at the read-model level, only in the pure
 * domain's own replayed `Relation.status`).
 */
export class RelationsViewProjection implements Projection {
  readonly name = 'relations-view';
  readonly handles: readonly string[] = ['RelationCreated', 'RelationRemoved'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    switch (event.type) {
      case 'RelationCreated': {
        const relationId = requireStringPayloadField(event, 'relationId');
        const workspaceId = requireStringPayloadField(event, 'workspaceId');
        const fromId = requireStringPayloadField(event, 'fromId');
        const toId = requireStringPayloadField(event, 'toId');
        const kind = requireStringPayloadField(event, 'kind');

        // `onConflictDoNothing` targeting the partial unique index
        // (`relations_view_active_parent_key`, `WHERE kind = 'parentChild'`):
        // two concurrent `create()` calls for two DIFFERENT parentChild
        // relations pointing at the identical (workspaceId, toId) can both
        // legitimately append their own `RelationCreated` event (the event
        // store has no knowledge of this business rule — only this table's
        // partial index does). Without this, the "losing" insert would throw
        // a raw Postgres unique-violation INSIDE this catchUp transaction,
        // aborting the whole batch (checkpoint never advances) and
        // permanently blocking this projection for EVERY workspace from that
        // point on — the exact class of bug ADR-0005 (F1-T2) describes and
        // fixes for `field-definitions.projection.ts`. Silently skipping the
        // losing insert keeps the projection healthy; the "losing" caller is
        // told about the conflict separately, by `RelationsService.create`'s
        // post-catchUp existence check. The `where` clause here must match
        // the index's own partial predicate exactly for Postgres to resolve
        // it as the conflict target.
        await dbTx
          .insert(relationsView)
          .values({
            id: relationId,
            streamId: event.streamId,
            workspaceId,
            fromId,
            toId,
            kind,
            createdAt: event.occurredAt,
          })
          .onConflictDoNothing({
            target: [relationsView.workspaceId, relationsView.toId],
            where: sql`kind = 'parentChild'`,
          });
        return;
      }
      case 'RelationRemoved': {
        const relationId = requireStringPayloadField(event, 'relationId');

        await dbTx.delete(relationsView).where(eq(relationsView.id, relationId));
        return;
      }
      default:
        return;
    }
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(relationsView);
  }
}
