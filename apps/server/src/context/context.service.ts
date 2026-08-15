import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, or } from 'drizzle-orm';

import type { FieldPermissions, Role } from '@luminaos/core-objects';
import { canViewField, isValidFieldPermissions } from '@luminaos/core-objects';
import { NotFoundError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { contextGraphEdges } from '../db/schema/context-graph-edges.js';
import { contextGraphNodes } from '../db/schema/context-graph-nodes.js';
import { fieldDefinitions } from '../db/schema/field-definitions.js';
import { objectsView } from '../db/schema/objects-view.js';
import { projectionCheckpoints } from '../db/schema/projection-checkpoints.js';
import { ObjectsService } from '../objects/objects.service.js';

import type { Database } from '../db/client.js';

export interface ContextNodeSummary {
  nodeType: string;
  naturalKey: string;
  entityId?: string;
  objectType?: string;
  title?: string;
}

export interface ContextEdgeSummary {
  edgeType: string;
  direction: 'outgoing' | 'incoming';
  node: ContextNodeSummary;
  sourceFieldKey: string | null;
  sourceRelationId: string | null;
}

export interface ContextResponse {
  asOf: string;
  entity: {
    entityId: string;
    objectType: string;
    title: string;
    fieldValues: Record<string, unknown>;
  };
  edges: ContextEdgeSummary[];
}

type ContextGraphNodeRow = typeof contextGraphNodes.$inferSelect;

/** A lightweight neighbor-entity object summary -- never `fieldValues` (ADR-0018 Karar b). */
interface NeighborObjectSummary {
  type: string;
  title: string;
}

/**
 * `ContextService` -- ADR-0018 Karar (b)/(c)/(d): resolves the "everything
 * related to this object" 1-hop graph query. Reuses `ObjectsService.get`
 * for the root entity's own `title`/`fieldValues` (already role-filtered via
 * `filterFieldValuesForRole`) rather than re-implementing that logic, per
 * this task's own instruction not to reinvent it.
 */
@Injectable()
export class ContextService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly objectsService: ObjectsService,
  ) {}

  async getContext(
    workspaceId: string,
    objectId: string,
    callerRole: Role,
  ): Promise<ContextResponse> {
    const entityNode = await this.findEntityNode(workspaceId, objectId);

    if (!entityNode) {
      throw new NotFoundError('Lumina Object not found');
    }

    const rootObject = await this.objectsService.get(workspaceId, objectId, callerRole);

    const edgeRows = await this.db
      .select()
      .from(contextGraphEdges)
      .where(
        and(
          eq(contextGraphEdges.workspaceId, workspaceId),
          or(
            eq(contextGraphEdges.fromNodeId, entityNode.id),
            eq(contextGraphEdges.toNodeId, entityNode.id),
          ),
        ),
      );

    const neighborNodeIds = Array.from(
      new Set(
        edgeRows.map((edge) =>
          edge.fromNodeId === entityNode.id ? edge.toNodeId : edge.fromNodeId,
        ),
      ),
    );

    const neighborNodeById = await this.loadNeighborNodes(workspaceId, neighborNodeIds);
    const neighborObjectById = await this.loadNeighborObjectSummaries(
      workspaceId,
      neighborNodeById,
    );
    const fieldPermissionsByKey = await this.getFieldPermissionsByKey(
      workspaceId,
      entityNode.objectType,
    );

    const edges: ContextEdgeSummary[] = [];

    for (const edge of edgeRows) {
      // ADR-0018 Karar (c) -- CRITICAL: the root entity's OWN `entity-topic`
      // edges must ALSO be filtered by the source field's hidden-ness, or a
      // hidden field's raw value leaks via `edges` even though `fieldValues`
      // itself is filtered.
      if (edge.edgeType === 'entity-topic' && edge.sourceFieldKey !== null) {
        const permissions = fieldPermissionsByKey.get(edge.sourceFieldKey);
        if (permissions !== undefined && !canViewField(permissions, callerRole)) {
          continue;
        }
      }

      const neighborNodeId = edge.fromNodeId === entityNode.id ? edge.toNodeId : edge.fromNodeId;
      const neighborNode = neighborNodeById.get(neighborNodeId);

      if (!neighborNode) {
        continue;
      }

      edges.push({
        edgeType: edge.edgeType,
        direction: edge.fromNodeId === entityNode.id ? 'outgoing' : 'incoming',
        node: this.toNodeSummary(neighborNode, neighborObjectById),
        sourceFieldKey: edge.sourceFieldKey,
        sourceRelationId: edge.sourceRelationId,
      });
    }

    const asOf = await this.readAsOf();

    return {
      asOf,
      entity: {
        entityId: rootObject.id,
        objectType: rootObject.type,
        title: rootObject.title,
        fieldValues: rootObject.fieldValues,
      },
      edges,
    };
  }

  private async findEntityNode(
    workspaceId: string,
    objectId: string,
  ): Promise<ContextGraphNodeRow | undefined> {
    const [row] = await this.db
      .select()
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

  private async loadNeighborNodes(
    workspaceId: string,
    neighborNodeIds: string[],
  ): Promise<Map<string, ContextGraphNodeRow>> {
    if (neighborNodeIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select()
      .from(contextGraphNodes)
      .where(
        and(
          eq(contextGraphNodes.workspaceId, workspaceId),
          inArray(contextGraphNodes.id, neighborNodeIds),
        ),
      );

    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * Batch-resolves `title`/`objectType` for every NEIGHBOR `entity` node's
   * `naturalKey` (= `objectId`), scoped to `workspaceId` -- ADR-0018 Karar
   * (b): a lightweight summary only, never the neighbor's `fieldValues`.
   */
  private async loadNeighborObjectSummaries(
    workspaceId: string,
    neighborNodeById: Map<string, ContextGraphNodeRow>,
  ): Promise<Map<string, NeighborObjectSummary>> {
    const entityObjectIds = Array.from(neighborNodeById.values())
      .filter((node) => node.nodeType === 'entity')
      .map((node) => node.naturalKey);

    if (entityObjectIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select({ id: objectsView.id, type: objectsView.type, title: objectsView.title })
      .from(objectsView)
      .where(
        and(eq(objectsView.workspaceId, workspaceId), inArray(objectsView.id, entityObjectIds)),
      );

    return new Map(rows.map((row) => [row.id, { type: row.type, title: row.title }]));
  }

  private toNodeSummary(
    node: ContextGraphNodeRow,
    neighborObjectById: Map<string, NeighborObjectSummary>,
  ): ContextNodeSummary {
    if (node.nodeType !== 'entity') {
      return { nodeType: node.nodeType, naturalKey: node.naturalKey };
    }

    const objectSummary = neighborObjectById.get(node.naturalKey);

    return {
      nodeType: node.nodeType,
      naturalKey: node.naturalKey,
      entityId: node.naturalKey,
      ...(objectSummary ? { objectType: objectSummary.type, title: objectSummary.title } : {}),
    };
  }

  /**
   * Builds a `fieldKey -> FieldPermissions` map for the root entity's OWN
   * object type, used only to filter its own `entity-topic` edges (Karar c).
   * Mirrors `ObjectsService.getActiveFieldDefinitionsForType`'s "active
   * definitions only" scope: a field with no active definition (e.g.
   * archived) is left unfiltered, same "hidden must be explicit" reasoning
   * as `filterFieldValuesForRole`.
   */
  private async getFieldPermissionsByKey(
    workspaceId: string,
    objectType: string | null,
  ): Promise<Map<string, FieldPermissions>> {
    if (objectType === null) {
      return new Map();
    }

    const rows = await this.db
      .select({ key: fieldDefinitions.key, permissions: fieldDefinitions.permissions })
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.workspaceId, workspaceId),
          eq(fieldDefinitions.objectType, objectType),
          eq(fieldDefinitions.lifecycle, 'active'),
        ),
      );

    const map = new Map<string, FieldPermissions>();

    for (const row of rows) {
      if (isValidFieldPermissions(row.permissions)) {
        map.set(row.key, row.permissions);
      }
    }

    return map;
  }

  /**
   * `asOf` (ADR-0018 Karar a): `projection_checkpoints.updatedAt` for
   * `projectionName='context-graph'`. By the time this method can be
   * reached at all, `ContextGraphSyncWorker.syncOnce()` must have already
   * run at least once with a non-empty batch (otherwise `findEntityNode`
   * above would have 404'd first) -- `ProjectionRunner.writeCheckpoint`
   * therefore already wrote this row, so the `new Date(0)` fallback below is
   * unreachable in practice, kept only for type-safety.
   */
  private async readAsOf(): Promise<string> {
    const [row] = await this.db
      .select({ updatedAt: projectionCheckpoints.updatedAt })
      .from(projectionCheckpoints)
      .where(eq(projectionCheckpoints.projectionName, 'context-graph'));

    return (row?.updatedAt ?? new Date(0)).toISOString();
  }
}
