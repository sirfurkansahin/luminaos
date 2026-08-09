import { Injectable } from '@nestjs/common';

import type { FieldDefinition, Relation, Role } from '@luminaos/core-objects';
import { NotFoundError } from '@luminaos/shared';

import { FieldDefinitionsService } from '../fields/field-definitions.service.js';
import { ObjectsService } from '../objects/objects.service.js';
import { RelationsService } from '../relations/relations.service.js';

import type { ObjectWithFieldValues } from '../objects/objects.service.js';

export interface WorkspaceJsonExport {
  workspaceId: string;
  exportedAt: string;
  objects: ObjectWithFieldValues[];
  fieldDefinitions: Record<string, FieldDefinition[]>;
  relations: Relation[];
}

/**
 * F1-T18 PR1: the JSON data-export service, per ADR-0016 §(b) — this
 * deliberately composes the three EXISTING, already-role-filtered read
 * services (`ObjectsService.list`, `FieldDefinitionsService.list`,
 * `RelationsService.getAllForWorkspace`) rather than querying
 * `objects_view`/`field_definitions`/`relations_view` directly. That
 * composition is the whole point: this class inherits the
 * `lifecycle != 'deleted'` base predicate and the role-based
 * `fieldValues`/field-definition filtering those services already
 * implement correctly, instead of re-implementing (and risking
 * re-diverging from) that logic here.
 */
@Injectable()
export class ExportService {
  constructor(
    private readonly objectsService: ObjectsService,
    private readonly relationsService: RelationsService,
    private readonly fieldDefinitionsService: FieldDefinitionsService,
  ) {}

  /**
   * Builds a full (or, with `objectId`, single-object-narrowed) JSON export
   * of a workspace's current-state projection. `callerRole` is threaded
   * through to `objectsService.list`/`fieldDefinitionsService.list` so this
   * export never leaks a shape or value the caller couldn't already see via
   * the normal read endpoints (ADR-0016 §a).
   */
  async exportJson(
    workspaceId: string,
    callerRole: Role,
    objectId?: string,
  ): Promise<WorkspaceJsonExport> {
    const { objects: allObjects } = await this.objectsService.list(workspaceId, callerRole);
    const allObjectIds = new Set(allObjects.map((object) => object.id));

    const objects = objectId ? allObjects.filter((object) => object.id === objectId) : allObjects;

    if (objectId && objects.length === 0) {
      throw new NotFoundError('Lumina Object not found');
    }

    const objectTypes = [...new Set(objects.map((object) => object.type))];

    const fieldDefinitionEntries = await Promise.all(
      objectTypes.map(async (objectType) => {
        const definitions = await this.fieldDefinitionsService.list(
          workspaceId,
          objectType,
          callerRole,
        );
        return [objectType, definitions] as const;
      }),
    );
    const fieldDefinitions = Object.fromEntries(fieldDefinitionEntries);

    // Both endpoints must be valid (non-deleted, in-workspace) objects --
    // checked against the FULL `allObjectIds` set, not the (possibly
    // single-element) narrowed `objects` set: a same-narrowed-set check on
    // both ends would always be empty when `objectId` narrows to one object,
    // since `createRelation` rejects `fromId === toId` (no self-relations
    // exist to satisfy it). When narrowing, a second filter keeps only
    // relations that actually TOUCH `objectId` (its counterpart may be any
    // other valid object in the workspace, not just itself).
    const allRelations = await this.relationsService.getAllForWorkspace(workspaceId);
    const validRelations = allRelations.filter(
      (relation) => allObjectIds.has(relation.fromId) && allObjectIds.has(relation.toId),
    );
    const relations = objectId
      ? validRelations.filter(
          (relation) => relation.fromId === objectId || relation.toId === objectId,
        )
      : validRelations;

    return {
      workspaceId,
      exportedAt: new Date().toISOString(),
      objects,
      fieldDefinitions,
      relations,
    };
  }
}
