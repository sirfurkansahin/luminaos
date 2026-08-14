import { Injectable } from '@nestjs/common';

import type { FieldDefinition, Relation, Role } from '@luminaos/core-objects';
import { NotFoundError, ValidationError } from '@luminaos/shared';

import { DocumentReconstructionService } from '../docs/document-reconstruction.service.js';
import { extractMarkdownFromYjsUpdate } from '../docs/yjs-to-markdown.js';
import { FieldDefinitionsService } from '../fields/field-definitions.service.js';
import { ObjectsService } from '../objects/objects.service.js';
import { RelationsService } from '../relations/relations.service.js';

import type { ObjectWithFieldValues } from '../objects/objects.service.js';

/**
 * A single exported object, optionally enriched with its Markdown doc body
 * (F1-T18 PR2, ADR-0016 §d). `content` is present ONLY for `type === 'doc'`
 * objects -- omitted entirely (not `content: undefined`) for every other
 * object type, so the JSON payload doesn't carry a spurious key for objects
 * that structurally can't have doc content.
 */
export type ExportedObject = ObjectWithFieldValues & {
  content?: { format: 'markdown'; text: string };
};

export interface WorkspaceJsonExport {
  workspaceId: string;
  exportedAt: string;
  objects: ExportedObject[];
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
    private readonly documentReconstructionService: DocumentReconstructionService,
  ) {}

  /**
   * Fetches `objectId`'s latest Yjs snapshot (if any) and renders it to
   * Markdown, or `''` when no snapshot exists yet (an unedited doc is a
   * valid empty document, not an error). Shared by `exportMarkdown` (PR2's
   * standalone `format=markdown` endpoint) and `exportJson`'s per-doc
   * `content` enrichment below -- both read the SAME snapshot the SAME way.
   */
  private async renderDocMarkdown(workspaceId: string, objectId: string): Promise<string> {
    const snapshotRow = await this.documentReconstructionService.getLatestSnapshot(
      objectId,
      workspaceId,
    );
    return snapshotRow ? extractMarkdownFromYjsUpdate(snapshotRow.snapshot) : '';
  }

  /**
   * Returns a single doc-type object's content as Markdown (F1-T18 PR2,
   * ADR-0016 §d). `objectsService.get` throws `NotFoundError` for a missing
   * or cross-workspace `objectId` (the same 404 behavior `exportJson`
   * relies on for its own `objectId` lookups). Non-`doc` objects are
   * rejected with a `ValidationError` (400) -- Markdown export only makes
   * sense for a doc's actual body.
   */
  async exportMarkdown(workspaceId: string, objectId: string, callerRole: Role): Promise<string> {
    const object = await this.objectsService.get(workspaceId, objectId, callerRole);

    if (object.type !== 'doc') {
      throw new ValidationError('format=markdown is only supported for doc-type objects');
    }

    return this.renderDocMarkdown(workspaceId, objectId);
  }

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

    // Doc-type objects are enriched with their Markdown body (F1-T18 PR2,
    // ADR-0016 §d). Batched via `Promise.all` over just the `doc`-type
    // subset -- mirrors the `fieldDefinitionEntries` batching above -- rather
    // than fetching snapshots one at a time in a loop.
    const docContentEntries = await Promise.all(
      objects
        .filter((object) => object.type === 'doc')
        .map(async (object) => {
          const text = await this.renderDocMarkdown(workspaceId, object.id);
          return [object.id, text] as const;
        }),
    );
    const docContentByObjectId = new Map(docContentEntries);

    const enrichedObjects: ExportedObject[] = objects.map((object) => {
      const text = docContentByObjectId.get(object.id);
      return text === undefined ? object : { ...object, content: { format: 'markdown', text } };
    });

    return {
      workspaceId,
      exportedAt: new Date().toISOString(),
      objects: enrichedObjects,
      fieldDefinitions,
      relations,
    };
  }
}
