import { and, eq, sql } from 'drizzle-orm';

import { newObjectId } from '@luminaos/core-objects';
import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { contextGraphEdges } from '../db/schema/context-graph-edges.js';
import { contextGraphFieldTypes } from '../db/schema/context-graph-field-types.js';
import { contextGraphNodes } from '../db/schema/context-graph-nodes.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors every other concrete projection's own `asDbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * `ProjectionTx` is intentionally opaque at the `packages/shared` level
 * (framework-free per CLAUDE.md); this concrete projection lives in
 * `apps/server` and needs a real Drizzle transaction to run queries —
 * mirrors `RelationsViewProjection`/`FieldDefinitionsViewProjection`'s own
 * `asDbTransaction` pattern exactly.
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

/** UTC calendar-day bucket key (ADR-0017 Karar e), e.g. `"2026-03-18"`. */
function toUtcDayKey(date: Date): string {
  const iso = date.toISOString();
  return iso.slice(0, 10);
}

/**
 * Extracts the topic-candidate value(s) out of a `FieldValueChanged`'s raw
 * `value` payload, per the field's already-known `fieldType` (ADR-0017 Karar
 * b): a `select` field contributes at most one value, `multiSelect`
 * contributes one per array entry. Throws on a payload/fieldType mismatch
 * (defense-in-depth, same discipline `objects-view.projection.ts` applies to
 * every other payload field it folds).
 */
function requireTopicValues(event: DomainEvent, fieldType: 'select' | 'multiSelect'): string[] {
  const value = event.payload['value'];

  if (fieldType === 'select') {
    if (typeof value !== 'string') {
      throw new InvalidObjectStateError(
        '"FieldValueChanged" event has a non-string "value" for a select field',
      );
    }
    return [value];
  }

  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === 'string')
  ) {
    throw new InvalidObjectStateError(
      '"FieldValueChanged" event has a non-string-array "value" for a multiSelect field',
    );
  }

  return value;
}

/**
 * `ContextGraphProjection` — ADR-0017 ("Bağlam Grafiği"): derives a
 * workspace-isolated context graph (`entity`/`person`/`time`/`topic` nodes,
 * `entity-entity`/`entity-person`/`entity-time`/`entity-topic` edges) purely
 * from the event log. Per Karar (c), it NEVER reads `field_definitions` (or
 * any other projection's materialized table) — its own minimal
 * `(workspaceId, objectType, fieldKey) -> fieldType` awareness is folded
 * into its own internal `context_graph_field_types` table from
 * `FieldDefined` events. Per Karar (h), this PR does not wire live `catchUp`
 * calls into any service's write path — it's driven directly by
 * `ProjectionRunner.catchUp`/`rebuild`.
 */
export class ContextGraphProjection implements Projection {
  readonly name = 'context-graph';
  readonly handles: readonly string[] = [
    'ObjectCreated',
    'ObjectSoftDeleted',
    'ObjectRestored',
    'RelationCreated',
    'RelationRemoved',
    'FieldDefined',
    'FieldArchived',
    'FieldValueChanged',
  ];

  /**
   * Inserts a node if its `(workspaceId, nodeType, naturalKey)` doesn't
   * already exist (idempotent folding, mirrors `field_definitions`/
   * `relations_view`'s `onConflictDoNothing` convention), then returns its
   * `id` either way — the caller always needs the id to build an edge.
   */
  private async getOrCreateNode(
    dbTx: DbTransaction,
    workspaceId: string,
    nodeType: string,
    naturalKey: string,
    objectType: string | null,
    createdAt: Date,
  ): Promise<string> {
    const inserted = await dbTx
      .insert(contextGraphNodes)
      .values({ id: newObjectId(), workspaceId, nodeType, naturalKey, objectType, createdAt })
      .onConflictDoNothing({
        target: [
          contextGraphNodes.workspaceId,
          contextGraphNodes.nodeType,
          contextGraphNodes.naturalKey,
        ],
      })
      .returning({ id: contextGraphNodes.id });

    const insertedRow = inserted[0];
    if (insertedRow) {
      return insertedRow.id;
    }

    const [existing] = await dbTx
      .select({ id: contextGraphNodes.id })
      .from(contextGraphNodes)
      .where(
        and(
          eq(contextGraphNodes.workspaceId, workspaceId),
          eq(contextGraphNodes.nodeType, nodeType),
          eq(contextGraphNodes.naturalKey, naturalKey),
        ),
      );

    if (!existing) {
      throw new InvalidObjectStateError(
        `context_graph_nodes row not found for (${workspaceId}, ${nodeType}, ${naturalKey}) immediately after upsert`,
      );
    }

    return existing.id;
  }

  private async findEntityNode(
    dbTx: DbTransaction,
    workspaceId: string,
    objectId: string,
  ): Promise<{ id: string; objectType: string | null } | undefined> {
    const [row] = await dbTx
      .select({ id: contextGraphNodes.id, objectType: contextGraphNodes.objectType })
      .from(contextGraphNodes)
      .where(
        and(
          eq(contextGraphNodes.workspaceId, workspaceId),
          eq(contextGraphNodes.nodeType, 'entity'),
          eq(contextGraphNodes.naturalKey, objectId),
        ),
      );

    return row;
  }

  /**
   * Inserts an edge if it doesn't already exist, idempotently. Because
   * Postgres treats every `NULL` as distinct in a unique index, the
   * `onConflictDoNothing` target must switch between the two partial unique
   * indexes `context-graph-edges.ts` defines, depending on whether
   * `sourceFieldKey` is `NULL` (see that schema file's own doc comment for
   * the full rationale).
   */
  private async createEdgeIfAbsent(
    dbTx: DbTransaction,
    workspaceId: string,
    edgeType: string,
    fromNodeId: string,
    toNodeId: string,
    sourceFieldKey: string | null,
    sourceRelationId: string | null,
    createdAt: Date,
  ): Promise<void> {
    if (sourceFieldKey === null) {
      await dbTx
        .insert(contextGraphEdges)
        .values({
          id: newObjectId(),
          workspaceId,
          edgeType,
          fromNodeId,
          toNodeId,
          sourceFieldKey: null,
          sourceRelationId,
          createdAt,
        })
        .onConflictDoNothing({
          target: [
            contextGraphEdges.workspaceId,
            contextGraphEdges.edgeType,
            contextGraphEdges.fromNodeId,
            contextGraphEdges.toNodeId,
          ],
          where: sql`source_field_key IS NULL`,
        });
      return;
    }

    await dbTx
      .insert(contextGraphEdges)
      .values({
        id: newObjectId(),
        workspaceId,
        edgeType,
        fromNodeId,
        toNodeId,
        sourceFieldKey,
        sourceRelationId,
        createdAt,
      })
      .onConflictDoNothing({
        target: [
          contextGraphEdges.workspaceId,
          contextGraphEdges.edgeType,
          contextGraphEdges.fromNodeId,
          contextGraphEdges.toNodeId,
          contextGraphEdges.sourceFieldKey,
        ],
        where: sql`source_field_key IS NOT NULL`,
      });
  }

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    switch (event.type) {
      case 'ObjectCreated': {
        const objectId = requireStringPayloadField(event, 'objectId');
        const objectType = requireStringPayloadField(event, 'objectType');

        const entityNodeId = await this.getOrCreateNode(
          dbTx,
          event.workspaceId,
          'entity',
          objectId,
          objectType,
          event.occurredAt,
        );

        // ADR-0017 Karar (g): `entity-person` is only created for human
        // actors; `entity`/`entity-time` are created for EVERY actor type.
        if (event.actor.type === 'user') {
          const personNodeId = await this.getOrCreateNode(
            dbTx,
            event.workspaceId,
            'person',
            event.actor.id,
            null,
            event.occurredAt,
          );
          await this.createEdgeIfAbsent(
            dbTx,
            event.workspaceId,
            'entity-person',
            entityNodeId,
            personNodeId,
            null,
            null,
            event.occurredAt,
          );
        }

        const timeNodeId = await this.getOrCreateNode(
          dbTx,
          event.workspaceId,
          'time',
          toUtcDayKey(event.occurredAt),
          null,
          event.occurredAt,
        );
        await this.createEdgeIfAbsent(
          dbTx,
          event.workspaceId,
          'entity-time',
          entityNodeId,
          timeNodeId,
          null,
          null,
          event.occurredAt,
        );

        // Type-based topic (ADR-0017 Karar b): `naturalKey = objectType`.
        const topicNodeId = await this.getOrCreateNode(
          dbTx,
          event.workspaceId,
          'topic',
          objectType,
          null,
          event.occurredAt,
        );
        await this.createEdgeIfAbsent(
          dbTx,
          event.workspaceId,
          'entity-topic',
          entityNodeId,
          topicNodeId,
          null,
          null,
          event.occurredAt,
        );
        return;
      }
      case 'ObjectSoftDeleted': {
        const objectId = requireStringPayloadField(event, 'objectId');

        // Hard-delete the entity node — every edge touching it (as either
        // `fromNodeId` or `toNodeId`) cascades away via the FK's
        // `onDelete: 'cascade'` (`context-graph-edges.ts`), mirroring
        // `RelationsViewProjection`'s hard-delete-on-remove philosophy.
        await dbTx
          .delete(contextGraphNodes)
          .where(
            and(
              eq(contextGraphNodes.workspaceId, event.workspaceId),
              eq(contextGraphNodes.nodeType, 'entity'),
              eq(contextGraphNodes.naturalKey, objectId),
            ),
          );
        return;
      }
      case 'ObjectRestored': {
        const objectId = requireStringPayloadField(event, 'objectId');

        // `ObjectRestored`'s payload carries only `objectId` (no
        // `objectType`) -- minimal guarantee only, per ADR-0017's accepted
        // restore limitation: re-create the entity node, make no claim
        // about `objectType` or edge reconstruction.
        await this.getOrCreateNode(
          dbTx,
          event.workspaceId,
          'entity',
          objectId,
          null,
          event.occurredAt,
        );
        return;
      }
      case 'RelationCreated': {
        const relationId = requireStringPayloadField(event, 'relationId');
        const fromId = requireStringPayloadField(event, 'fromId');
        const toId = requireStringPayloadField(event, 'toId');

        const fromEntity = await this.findEntityNode(dbTx, event.workspaceId, fromId);
        const toEntity = await this.findEntityNode(dbTx, event.workspaceId, toId);

        // Defensive: the entity nodes should already exist (their
        // `ObjectCreated` events necessarily precede a `RelationCreated`
        // referencing them). If either is missing (e.g. a partially-caught-
        // up projection), skip rather than throw.
        if (!fromEntity || !toEntity) {
          return;
        }

        await this.createEdgeIfAbsent(
          dbTx,
          event.workspaceId,
          'entity-entity',
          fromEntity.id,
          toEntity.id,
          null,
          relationId,
          event.occurredAt,
        );
        return;
      }
      case 'RelationRemoved': {
        const relationId = requireStringPayloadField(event, 'relationId');

        // `RelationRemoved`'s payload is `{ relationId }` only -- resolves
        // the corresponding `entity-entity` edge via this projection's own
        // `sourceRelationId` bookkeeping column (see `context-graph-edges.ts`'s
        // doc comment), never by cross-reading `relations_view`.
        await dbTx
          .delete(contextGraphEdges)
          .where(
            and(
              eq(contextGraphEdges.workspaceId, event.workspaceId),
              eq(contextGraphEdges.edgeType, 'entity-entity'),
              eq(contextGraphEdges.sourceRelationId, relationId),
            ),
          );
        return;
      }
      case 'FieldDefined': {
        const fieldDefinitionId = requireStringPayloadField(event, 'fieldDefinitionId');
        const objectType = requireStringPayloadField(event, 'objectType');
        const key = requireStringPayloadField(event, 'key');
        const fieldType = requireStringPayloadField(event, 'fieldType');

        await dbTx
          .insert(contextGraphFieldTypes)
          .values({
            id: newObjectId(),
            workspaceId: event.workspaceId,
            objectType,
            fieldKey: key,
            fieldType,
            fieldDefinitionId,
          })
          .onConflictDoNothing({
            target: [
              contextGraphFieldTypes.workspaceId,
              contextGraphFieldTypes.objectType,
              contextGraphFieldTypes.fieldKey,
            ],
          });
        return;
      }
      case 'FieldArchived': {
        // ADR-0017's accepted limitation: no stale `entity-topic` cleanup.
        // `FieldArchived`'s payload carries only `fieldDefinitionId` (no
        // `objectType`/`key`), so this internal field-type table cannot be
        // targeted-cleaned here either. Explicit no-op case (rather than
        // falling through to `default`) so `handles` and `apply` stay in
        // sync for readers.
        return;
      }
      case 'FieldValueChanged': {
        const objectId = requireStringPayloadField(event, 'objectId');
        const fieldKey = requireStringPayloadField(event, 'fieldKey');

        const entityNode = await this.findEntityNode(dbTx, event.workspaceId, objectId);
        if (!entityNode || entityNode.objectType === null) {
          return;
        }

        const [fieldTypeRow] = await dbTx
          .select({ fieldType: contextGraphFieldTypes.fieldType })
          .from(contextGraphFieldTypes)
          .where(
            and(
              eq(contextGraphFieldTypes.workspaceId, event.workspaceId),
              eq(contextGraphFieldTypes.objectType, entityNode.objectType),
              eq(contextGraphFieldTypes.fieldKey, fieldKey),
            ),
          );

        if (
          !fieldTypeRow ||
          (fieldTypeRow.fieldType !== 'select' && fieldTypeRow.fieldType !== 'multiSelect')
        ) {
          return;
        }

        // ADR-0017 Karar (d): full-refresh -- delete every existing
        // `entity-topic` edge scoped to THIS `(entity, fieldKey)` pair
        // before adding fresh ones for the new value(s). Scoped by
        // `sourceFieldKey` so a different field's edges are untouched.
        await dbTx
          .delete(contextGraphEdges)
          .where(
            and(
              eq(contextGraphEdges.workspaceId, event.workspaceId),
              eq(contextGraphEdges.edgeType, 'entity-topic'),
              eq(contextGraphEdges.fromNodeId, entityNode.id),
              eq(contextGraphEdges.sourceFieldKey, fieldKey),
            ),
          );

        const values = requireTopicValues(event, fieldTypeRow.fieldType);

        for (const value of values) {
          const topicNodeId = await this.getOrCreateNode(
            dbTx,
            event.workspaceId,
            'topic',
            value,
            null,
            event.occurredAt,
          );
          await this.createEdgeIfAbsent(
            dbTx,
            event.workspaceId,
            'entity-topic',
            entityNode.id,
            topicNodeId,
            fieldKey,
            null,
            event.occurredAt,
          );
        }
        return;
      }
      default:
        return;
    }
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    // FK order: edges reference nodes, so delete edges first.
    await dbTx.delete(contextGraphEdges);
    await dbTx.delete(contextGraphNodes);
    await dbTx.delete(contextGraphFieldTypes);
  }
}
