import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import {
  archiveField,
  canViewField,
  defineField,
  newObjectId,
  replayFieldDefinition,
  updateField,
} from '@luminaos/core-objects';
import type {
  FieldDefinition,
  FieldEventDraft,
  FieldPermissions,
  FieldType,
  ObjectType,
  Role,
} from '@luminaos/core-objects';
import { ConflictError, NotFoundError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { FieldDefinitionsViewProjection } from './field-definitions.projection.js';
import { DATABASE_CONNECTION } from '../db/db.module.js';
import { fieldDefinitions } from '../db/schema/field-definitions.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

const STREAM_TYPE = 'field-definition';

export interface DefineFieldDefinitionInput {
  key: string;
  label: string;
  fieldType: FieldType;
  config: unknown;
  defaultValue?: unknown;
  permissions: FieldPermissions;
}

export interface UpdateFieldDefinitionInput {
  label?: string;
  config?: unknown;
  defaultValue?: unknown;
  permissions?: FieldPermissions;
}

/**
 * The server-side event-sourced integration for field DEFINITIONS
 * (`FieldDefined`/`FieldUpdated`/`FieldArchived`) — mirrors `ObjectsService`'s
 * exact internal pattern (own `applyCommand`/`wrapDrafts`/`lookupStreamId`
 * private helpers, own `STREAM_TYPE`, a stable projection instance,
 * synchronous `ProjectionRunner.catchUp` after every write for
 * read-your-writes). Field VALUES are PR-C's job and are not handled here.
 */
@Injectable()
export class FieldDefinitionsService {
  /**
   * A single, stable `FieldDefinitionsViewProjection` instance for this
   * service's lifetime — see `ObjectsService.projection`'s doc comment for
   * why (checkpointing is by `projection.name`, not instance identity, but
   * reusing one instance avoids any doubt).
   */
  private readonly projection = new FieldDefinitionsViewProjection();

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
  ) {}

  async define(
    workspaceId: string,
    objectType: ObjectType,
    actor: Actor,
    input: DefineFieldDefinitionInput,
  ): Promise<FieldDefinition> {
    await this.assertKeyIsUnique(workspaceId, objectType, input.key);

    const fieldDefinitionId = newObjectId();
    const streamId = randomUUID();

    const existingFieldDefinitions = await this.getActiveFieldDefinitionsForType(
      workspaceId,
      objectType,
    );

    const drafts = defineField(
      {
        fieldDefinitionId,
        workspaceId,
        objectType,
        key: input.key,
        label: input.label,
        fieldType: input.fieldType,
        config: input.config,
        defaultValue: input.defaultValue,
        permissions: input.permissions,
      },
      existingFieldDefinitions,
    );

    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    const appended = await this.eventStore.append(streamId, 0, newEvents);

    await this.projectionRunner.catchUp(this.projection);

    // The projection's `FieldDefined` handler uses `onConflictDoNothing` on
    // the business-uniqueness index, so a concurrent `define()` for the
    // identical key never crashes the projection — but it means THIS call's
    // insert may have silently lost that race. Verify our own row actually
    // landed before reporting success; if not, this caller genuinely lost a
    // uniqueness race and must see a conflict, not a false 201.
    const [ownRow] = await this.db
      .select({ id: fieldDefinitions.id })
      .from(fieldDefinitions)
      .where(eq(fieldDefinitions.id, fieldDefinitionId))
      .limit(1);

    if (!ownRow) {
      throw new ConflictError(
        'A field definition with this key already exists for this object type.',
      );
    }

    return replayFieldDefinition(appended);
  }

  async update(
    workspaceId: string,
    objectType: ObjectType,
    fieldDefinitionId: string,
    actor: Actor,
    input: UpdateFieldDefinitionInput,
  ): Promise<FieldDefinition> {
    const existingFieldDefinitions = await this.getActiveFieldDefinitionsForType(
      workspaceId,
      objectType,
    );

    return this.applyCommand(workspaceId, objectType, fieldDefinitionId, actor, (state) =>
      updateField(state, input, existingFieldDefinitions),
    );
  }

  async archive(
    workspaceId: string,
    objectType: ObjectType,
    fieldDefinitionId: string,
    actor: Actor,
  ): Promise<FieldDefinition> {
    return this.applyCommand(workspaceId, objectType, fieldDefinitionId, actor, (state) =>
      archiveField(state),
    );
  }

  /**
   * Reads active field definitions for `workspaceId`+`objectType`, then
   * filters out any whose `permissions[callerRole] === 'hidden'` (security
   * review finding: this filtering was previously missing entirely, despite
   * the plan and this class's own callers assuming it happened here).
   */
  async list(
    workspaceId: string,
    objectType: ObjectType,
    callerRole: Role,
  ): Promise<FieldDefinition[]> {
    const rows = await this.db
      .select()
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.workspaceId, workspaceId),
          eq(fieldDefinitions.objectType, objectType),
          eq(fieldDefinitions.lifecycle, 'active'),
        ),
      );

    return rows
      .map((row) => this.toFieldDefinition(row))
      .filter((definition) => canViewField(definition.permissions, callerRole));
  }

  /**
   * Same query shape as `list()`, minus its `canViewField` role filter —
   * formula schema/cycle validation (`assertFormulaFieldRules`) is not
   * role-scoped, it needs the FULL set of this workspace+objectType's active
   * field definitions regardless of who is calling.
   */
  private async getActiveFieldDefinitionsForType(
    workspaceId: string,
    objectType: ObjectType,
  ): Promise<FieldDefinition[]> {
    const rows = await this.db
      .select()
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.workspaceId, workspaceId),
          eq(fieldDefinitions.objectType, objectType),
          eq(fieldDefinitions.lifecycle, 'active'),
        ),
      );

    return rows.map((row) => this.toFieldDefinition(row));
  }

  /**
   * The shared write path for every command except `define`: resolves
   * `fieldDefinitionId -> streamId` via `field_definitions` (existence +
   * workspace-scope in one lookup, mirroring `ObjectsService.applyCommand`'s
   * `objects_view` lookup per ADR-0003), replays the authoritative state
   * from the real event stream, invokes the given domain command, appends
   * the resulting draft(s), synchronously catches the projection up, and
   * returns the freshly replayed state.
   */
  private async applyCommand(
    workspaceId: string,
    objectType: ObjectType,
    fieldDefinitionId: string,
    actor: Actor,
    command: (state: FieldDefinition) => FieldEventDraft[],
  ): Promise<FieldDefinition> {
    const streamId = await this.lookupStreamId(workspaceId, objectType, fieldDefinitionId);
    const priorEvents = await this.eventStore.readStream(streamId);
    const state = replayFieldDefinition(priorEvents);

    const drafts = command(state);
    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    const appended = await this.eventStore.append(streamId, priorEvents.length, newEvents);

    await this.projectionRunner.catchUp(this.projection);

    return replayFieldDefinition([...priorEvents, ...appended]);
  }

  /**
   * Scoped by `id` + `workspaceId` + `objectType` (security review finding:
   * previously only `id`+`workspaceId` were checked, so an admin could
   * mutate a field definition via a `:objectType` URL segment that didn't
   * match the field's actual object type).
   */
  private async lookupStreamId(
    workspaceId: string,
    objectType: ObjectType,
    fieldDefinitionId: string,
  ): Promise<string> {
    const [row] = await this.db
      .select({ streamId: fieldDefinitions.streamId })
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.id, fieldDefinitionId),
          eq(fieldDefinitions.workspaceId, workspaceId),
          eq(fieldDefinitions.objectType, objectType),
        ),
      )
      .limit(1);

    if (!row) {
      throw new NotFoundError('Field definition not found');
    }

    return row.streamId;
  }

  /**
   * A fast-path pre-check select against `field_definitions` for an existing
   * `(workspaceId, objectType, key)` match (any lifecycle — the unique
   * constraint is permanent, an archived field's key is not freed for
   * reuse, per the plan's documented scope note) — avoids a wasted event
   * append in the common (non-racing) case. This still has a check-then-act
   * race window with a concurrent `define` call for the exact same key; that
   * race is now closed correctly (not just tolerated) by `define()`'s
   * post-`catchUp` existence check, combined with the projection's
   * `onConflictDoNothing` — see both for the full picture (security review
   * finding: the race used to crash the whole projection, not just this
   * request).
   */
  private async assertKeyIsUnique(
    workspaceId: string,
    objectType: ObjectType,
    key: string,
  ): Promise<void> {
    const [row] = await this.db
      .select({ id: fieldDefinitions.id })
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.workspaceId, workspaceId),
          eq(fieldDefinitions.objectType, objectType),
          eq(fieldDefinitions.key, key),
        ),
      )
      .limit(1);

    if (row) {
      throw new ConflictError(
        'A field definition with this key already exists for this object type.',
      );
    }
  }

  private wrapDrafts(
    drafts: FieldEventDraft[],
    workspaceId: string,
    actor: Actor,
  ): NewDomainEvent[] {
    const occurredAt = new Date();

    return drafts.map((draft) => ({
      id: randomUUID(),
      streamType: STREAM_TYPE,
      workspaceId,
      type: draft.type,
      payload: draft.payload,
      actor,
      occurredAt,
    }));
  }

  private toFieldDefinition(row: typeof fieldDefinitions.$inferSelect): FieldDefinition {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      objectType: row.objectType as ObjectType,
      key: row.key,
      label: row.label,
      fieldType: row.fieldType as FieldType,
      config: row.config,
      defaultValue: row.defaultValue ?? undefined,
      permissions: row.permissions as FieldPermissions,
      lifecycle: row.lifecycle as FieldDefinition['lifecycle'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
