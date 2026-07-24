import { eq } from 'drizzle-orm';

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

        await dbTx.insert(relationsView).values({
          id: relationId,
          streamId: event.streamId,
          workspaceId,
          fromId,
          toId,
          kind,
          createdAt: event.occurredAt,
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
