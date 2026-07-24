import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';

import {
  applyDefaultFieldValues,
  archiveObject,
  canEditField,
  canViewField,
  computeAggregate,
  createObject,
  evaluateFormula,
  getAffectedFormulaKeysInOrder,
  newObjectId,
  parseFormula,
  renameObject,
  replayFieldValues,
  replayObject,
  restoreObject,
  setFieldValues as setFieldValuesCommand,
  softDeleteObject,
} from '@luminaos/core-objects';
import type {
  AggregateFn,
  FieldDefinition,
  FormulaFieldDependency,
  LuminaObject,
  ObjectEventDraft,
  ObjectType,
  Role,
} from '@luminaos/core-objects';
import { ForbiddenError, NotFoundError, ValidationError } from '@luminaos/shared';
import type { Actor, NewDomainEvent } from '@luminaos/shared';

import { ObjectsViewProjection } from './objects-view.projection.js';
import { DATABASE_CONNECTION } from '../db/db.module.js';
import { fieldDefinitions } from '../db/schema/field-definitions.js';
import { objectsView } from '../db/schema/objects-view.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

const STREAM_TYPE = 'lumina-object';

/** The always-and-only actor recorded for a formula field's own recomputed
 * `FieldValueChanged` events -- never the caller's own actor, since the
 * caller never directly wrote these values (F1-T4 plan). */
const FORMULA_ENGINE_ACTOR: Actor = { type: 'system', id: 'formula-engine' };

/**
 * The server-side, over-the-wire shape of a Lumina Object (F1-T2 PR-C): the
 * pure `LuminaObject` domain type plus a `fieldValues` map. This is
 * deliberately NOT added to `packages/core-objects`'s own `LuminaObject`
 * type (frozen, PR-A) — it's a server-layer read-model concern (role-based
 * filtering happens here, not in the domain).
 */
export type ObjectWithFieldValues = LuminaObject & { fieldValues: Record<string, unknown> };

export interface SetFieldValueEntry {
  fieldKey: string;
  value: unknown;
}

@Injectable()
export class ObjectsService {
  /**
   * A single, stable `ObjectsViewProjection` instance for this service's
   * lifetime — `ProjectionRunner.catchUp` checkpoints by `projection.name`,
   * not by instance identity, but reusing one instance (rather than
   * constructing a fresh one per call) avoids any doubt about that and
   * matches the "stable instance" requirement.
   */
  private readonly projection = new ObjectsViewProjection();

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
  ) {}

  async create(
    workspaceId: string,
    actor: Actor,
    input: { objectType: ObjectType; title: string },
    callerRole: Role,
  ): Promise<ObjectWithFieldValues> {
    const objectId = newObjectId();
    const streamId = randomUUID();

    const createDrafts = createObject({
      objectId,
      workspaceId,
      objectType: input.objectType,
      title: input.title,
      actor,
    });

    // Active field definitions for this object type, gathered BEFORE the
    // append so their `defaultValue`s can ride in the SAME `append` call as
    // `ObjectCreated` (F1-T2 plan's central architecture decision:
    // create+defaults are atomic, one stream, one append).
    const definitions = await this.getActiveFieldDefinitionsForType(workspaceId, input.objectType);
    const defaultDrafts = applyDefaultFieldValues(objectId, definitions);

    // Default values just applied become the base for formula recompute:
    // a formula referencing a defaulted field must see that default on this
    // very first write, not only on a later `setFieldValues` call.
    const now = new Date();
    const fieldValuesAfterDefaults: Record<string, unknown> = {};
    const changedKeys: string[] = [];

    for (const draft of defaultDrafts) {
      const { fieldKey, value } = draft.payload as { fieldKey: string; value: unknown };
      fieldValuesAfterDefaults[fieldKey] = value;
      changedKeys.push(fieldKey);
    }

    const recomputeDrafts = this.recomputeFormulaFields(
      objectId,
      fieldValuesAfterDefaults,
      definitions,
      changedKeys,
      now,
    );

    // Two `wrapDrafts` calls -- the user's own actor for `create`+defaults,
    // the system actor for anything the formula engine itself computed --
    // concatenated into ONE `append` call (single atomic write, per this
    // task's constraint).
    const userEvents = this.wrapDrafts([...createDrafts, ...defaultDrafts], workspaceId, actor);
    const systemEvents = this.wrapDrafts(recomputeDrafts, workspaceId, FORMULA_ENGINE_ACTOR);
    const appended = await this.eventStore.append(streamId, 0, [...userEvents, ...systemEvents]);

    await this.projectionRunner.catchUp(this.projection);

    const object = replayObject(appended);
    const fieldValues = replayFieldValues(appended);

    return {
      ...object,
      fieldValues: this.filterFieldValuesForRole(fieldValues, definitions, callerRole),
    };
  }

  async rename(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    input: { title: string },
  ): Promise<LuminaObject> {
    return this.applyCommand(workspaceId, objectId, actor, (state) => renameObject(state, input));
  }

  async archive(workspaceId: string, objectId: string, actor: Actor): Promise<LuminaObject> {
    return this.applyCommand(workspaceId, objectId, actor, (state) => archiveObject(state));
  }

  async restore(workspaceId: string, objectId: string, actor: Actor): Promise<LuminaObject> {
    return this.applyCommand(workspaceId, objectId, actor, (state) => restoreObject(state));
  }

  async softDelete(workspaceId: string, objectId: string, actor: Actor): Promise<LuminaObject> {
    return this.applyCommand(workspaceId, objectId, actor, (state) => softDeleteObject(state));
  }

  async get(
    workspaceId: string,
    objectId: string,
    callerRole: Role,
  ): Promise<ObjectWithFieldValues> {
    const [row] = await this.db
      .select()
      .from(objectsView)
      .where(and(eq(objectsView.id, objectId), eq(objectsView.workspaceId, workspaceId)))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Lumina Object not found');
    }

    const definitions = await this.getActiveFieldDefinitionsForType(
      workspaceId,
      row.type as ObjectType,
    );

    return this.toObjectWithFieldValues(row, definitions, callerRole);
  }

  async list(
    workspaceId: string,
    callerRole: Role,
    aggregateSpecs?: { fieldKey: string; fn: AggregateFn }[],
  ): Promise<{ objects: ObjectWithFieldValues[]; aggregates?: Record<string, number | null> }> {
    const rows = await this.db
      .select()
      .from(objectsView)
      .where(and(eq(objectsView.workspaceId, workspaceId), ne(objectsView.lifecycle, 'deleted')));

    const definitionsByType = await this.getActiveFieldDefinitionsGroupedByType(workspaceId);

    const objects = rows
      .map((row) =>
        this.toObjectWithFieldValues(row, definitionsByType.get(row.type) ?? [], callerRole),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    if (!aggregateSpecs || aggregateSpecs.length === 0) {
      return { objects };
    }

    const aggregates: Record<string, number | null> = {};

    for (const { fieldKey, fn } of aggregateSpecs) {
      const values = objects.map((object) => object.fieldValues[fieldKey]);
      aggregates[`${fieldKey}:${fn}`] = computeAggregate(fn, values);
    }

    return { objects, aggregates };
  }

  /**
   * Batch, all-or-nothing custom-field write. For every submitted
   * `fieldKey`: looks up its ACTIVE field definition (workspace + this
   * object's own `objectType`, resolved via `objects_view`) — `NotFoundError`
   * if none matches; `ForbiddenError` if `callerRole` does not have `'edit'`
   * on it (`'view'`/`'hidden'` both count as "no edit"). Only once every
   * entry has passed both checks does the domain command
   * (`setFieldValuesCommand`) run — it re-validates each value against its
   * field's type/config and throws before returning any drafts if any entry
   * is invalid, so a single `append` call either writes every entry or
   * writes none.
   */
  async setFieldValues(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    callerRole: Role,
    entries: SetFieldValueEntry[],
  ): Promise<ObjectWithFieldValues> {
    const { streamId, objectType } = await this.lookupStreamIdAndType(workspaceId, objectId);

    const definitions = await this.getActiveFieldDefinitionsForType(workspaceId, objectType);
    const definitionsByKey = new Map(definitions.map((definition) => [definition.key, definition]));

    const resolvedEntries = entries.map((entry) => {
      const definition = definitionsByKey.get(entry.fieldKey);

      // A field the caller cannot even VIEW ("hidden") must be
      // indistinguishable from one that was never defined at all — a
      // distinguishable 403 here would let a caller enumerate hidden field
      // keys via brute-force PATCH attempts, something they cannot do via
      // GET/list (security review finding). Only a "view"-but-not-"edit"
      // field (whose existence the caller already legitimately knows,
      // having seen it via GET) gets 403.
      if (!definition || !canViewField(definition.permissions, callerRole)) {
        throw new NotFoundError(
          'No active field definition found for this key on this object type.',
        );
      }

      // A formula field's value is always computed by the formula engine,
      // never directly writable — regardless of role/permission level (the
      // field genuinely exists and its type is discoverable via `GET`, so
      // this is a structural-validation 400, not a `ForbiddenError` 403 or
      // the existence-oracle-avoiding 404 above).
      if (definition.fieldType === 'formula') {
        throw new ValidationError('cannot directly set a value for a computed formula field', {
          fieldKey: entry.fieldKey,
        });
      }

      if (!canEditField(definition.permissions, callerRole)) {
        throw new ForbiddenError();
      }

      return { fieldDefinition: definition, value: entry.value };
    });

    const drafts = setFieldValuesCommand(objectId, resolvedEntries);

    const priorEvents = await this.eventStore.readStream(streamId);

    // The current field-value map, with this write's own entries applied on
    // top — the base formula recompute reasons over (upstream dependency
    // changes must be visible to recompute even though they haven't been
    // appended yet).
    const workingFieldValues = replayFieldValues(priorEvents);
    const changedKeys: string[] = [];

    for (const draft of drafts) {
      const { fieldKey, value } = draft.payload as { fieldKey: string; value: unknown };
      workingFieldValues[fieldKey] = value;
      changedKeys.push(fieldKey);
    }

    const recomputeDrafts = this.recomputeFormulaFields(
      objectId,
      workingFieldValues,
      definitions,
      changedKeys,
      new Date(),
    );

    // Two `wrapDrafts` calls (real actor, then the system formula-engine
    // actor), concatenated into ONE `append` call -- same atomicity pattern
    // as `create`.
    const userEvents = this.wrapDrafts(drafts, workspaceId, actor);
    const systemEvents = this.wrapDrafts(recomputeDrafts, workspaceId, FORMULA_ENGINE_ACTOR);
    const newEvents = [...userEvents, ...systemEvents];
    const appended = await this.eventStore.append(streamId, priorEvents.length, newEvents);

    await this.projectionRunner.catchUp(this.projection);

    const object = replayObject([...priorEvents, ...appended]);
    const fieldValues = replayFieldValues([...priorEvents, ...appended]);

    return {
      ...object,
      fieldValues: this.filterFieldValuesForRole(fieldValues, definitions, callerRole),
    };
  }

  /**
   * Given the full ACTIVE field-definition set for an object type and the
   * keys that just changed (default values applied on `create`, or a
   * `setFieldValues` write), recomputes every `formula` field transitively
   * affected, IN DEPENDENCY ORDER, against `fieldValues` (a working copy;
   * this function mutates its own local copy as it goes so a later formula
   * in the order sees an earlier one's freshly recomputed value). Returns
   * one `FieldValueChanged` draft per formula field whose computed value
   * actually changed (empty array if none did).
   */
  private recomputeFormulaFields(
    objectId: string,
    fieldValues: Record<string, unknown>,
    definitions: FieldDefinition[],
    changedKeys: string[],
    now: Date,
  ): ObjectEventDraft[] {
    const formulaDefinitions = definitions.filter(
      (definition) => definition.fieldType === 'formula',
    );

    if (formulaDefinitions.length === 0) {
      return [];
    }

    const formulaFieldDependencies: FormulaFieldDependency[] = formulaDefinitions.map(
      (definition) => ({
        key: definition.key,
        dependsOn: parseFormula(this.formulaExpression(definition)).dependsOn,
      }),
    );

    const affectedKeys = getAffectedFormulaKeysInOrder(formulaFieldDependencies, changedKeys);

    if (affectedKeys.length === 0) {
      return [];
    }

    const definitionsByKey = new Map(
      formulaDefinitions.map((definition) => [definition.key, definition]),
    );
    const workingFieldValues = { ...fieldValues };
    const drafts: ObjectEventDraft[] = [];

    for (const key of affectedKeys) {
      const definition = definitionsByKey.get(key);

      if (!definition) {
        continue;
      }

      const { ast } = parseFormula(this.formulaExpression(definition));
      const computedValue = evaluateFormula(ast, { fieldValues: workingFieldValues, now });
      const previousValue = workingFieldValues[key];

      if (JSON.stringify(computedValue) !== JSON.stringify(previousValue)) {
        drafts.push({
          type: 'FieldValueChanged',
          payload: { objectId, fieldKey: key, value: computedValue },
        });
      }

      workingFieldValues[key] = computedValue;
    }

    return drafts;
  }

  /**
   * A `formula`-typed `FieldDefinition`'s `config` is `unknown` on the type
   * itself, but is guaranteed (by `defineField`/`updateField`'s own
   * validation, PR-A2) to always carry a valid `{ expression: string }` shape
   * by construction once it reaches here -- this is the single place that
   * assumption is documented and asserted.
   */
  private formulaExpression(definition: FieldDefinition): string {
    return (definition.config as { expression: string }).expression;
  }

  /**
   * The shared write path for every command except `create`: resolves
   * `objectId -> streamId` via `objects_view` (existence + workspace-scope
   * in one lookup, per ADR-0003), replays the authoritative state from the
   * real event stream (never from the projection), invokes the given domain
   * command, appends the resulting draft(s), synchronously catches the
   * `objects_view` projection up, and returns the freshly replayed state.
   */
  private async applyCommand(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    command: (state: LuminaObject) => ObjectEventDraft[],
  ): Promise<LuminaObject> {
    const streamId = await this.lookupStreamId(workspaceId, objectId);
    const priorEvents = await this.eventStore.readStream(streamId);
    const state = replayObject(priorEvents);

    const drafts = command(state);
    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    const appended = await this.eventStore.append(streamId, priorEvents.length, newEvents);

    await this.projectionRunner.catchUp(this.projection);

    return replayObject([...priorEvents, ...appended]);
  }

  private async lookupStreamId(workspaceId: string, objectId: string): Promise<string> {
    const [row] = await this.db
      .select({ streamId: objectsView.streamId })
      .from(objectsView)
      .where(and(eq(objectsView.id, objectId), eq(objectsView.workspaceId, workspaceId)))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Lumina Object not found');
    }

    return row.streamId;
  }

  private async lookupStreamIdAndType(
    workspaceId: string,
    objectId: string,
  ): Promise<{ streamId: string; objectType: ObjectType }> {
    const [row] = await this.db
      .select({ streamId: objectsView.streamId, type: objectsView.type })
      .from(objectsView)
      .where(and(eq(objectsView.id, objectId), eq(objectsView.workspaceId, workspaceId)))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Lumina Object not found');
    }

    return { streamId: row.streamId, objectType: row.type as ObjectType };
  }

  private wrapDrafts(
    drafts: ObjectEventDraft[],
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

  private toLuminaObject(row: typeof objectsView.$inferSelect): LuminaObject {
    return {
      id: row.id,
      type: row.type as ObjectType,
      workspaceId: row.workspaceId,
      title: row.title,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lifecycle: row.lifecycle as LuminaObject['lifecycle'],
    };
  }

  private toObjectWithFieldValues(
    row: typeof objectsView.$inferSelect,
    definitions: FieldDefinition[],
    callerRole: Role,
  ): ObjectWithFieldValues {
    const rawFieldValues = (row.fieldValues ?? {}) as Record<string, unknown>;

    return {
      ...this.toLuminaObject(row),
      fieldValues: this.filterFieldValuesForRole(rawFieldValues, definitions, callerRole),
    };
  }

  /**
   * Drops every key in `fieldValues` whose matching ACTIVE field definition
   * has `permissions[callerRole] === 'hidden'` — the key itself is removed
   * (not set to `null`), per this PR's pinned HTTP contract. A stored value
   * with no matching active definition (e.g. its definition was later
   * archived) is left as-is: only an explicit `hidden` permission filters a
   * value, absence of a definition does not.
   */
  private filterFieldValuesForRole(
    fieldValues: Record<string, unknown>,
    definitions: FieldDefinition[],
    callerRole: Role,
  ): Record<string, unknown> {
    const hiddenKeys = new Set(
      definitions
        .filter((definition) => !canViewField(definition.permissions, callerRole))
        .map((definition) => definition.key),
    );

    const filtered: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(fieldValues)) {
      if (hiddenKeys.has(key)) {
        continue;
      }
      filtered[key] = value;
    }

    return filtered;
  }

  /**
   * A direct, UNFILTERED (by role) read of active field definitions for a
   * single object type — deliberately bypasses
   * `FieldDefinitionsService.list`'s own `canViewField` filtering (PR-B),
   * because callers here need the FULL set for reasons that are not
   * "should this caller see this field": `create`'s defaults are
   * system-applied regardless of any role's permissions, and
   * `setFieldValues`'s edit-permission check needs to know a `hidden` field
   * DOES exist (to return 403, not a misleading 404) rather than have it
   * silently filtered out of the lookup set.
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

  /** Same as `getActiveFieldDefinitionsForType`, but for every object type in the workspace at once — used by `list`, which returns objects of mixed types in a single query. */
  private async getActiveFieldDefinitionsGroupedByType(
    workspaceId: string,
  ): Promise<Map<string, FieldDefinition[]>> {
    const rows = await this.db
      .select()
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.workspaceId, workspaceId),
          eq(fieldDefinitions.lifecycle, 'active'),
        ),
      );

    const grouped = new Map<string, FieldDefinition[]>();

    for (const row of rows) {
      const definition = this.toFieldDefinition(row);
      const existing = grouped.get(definition.objectType);

      if (existing) {
        existing.push(definition);
      } else {
        grouped.set(definition.objectType, [definition]);
      }
    }

    return grouped;
  }

  private toFieldDefinition(row: typeof fieldDefinitions.$inferSelect): FieldDefinition {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      objectType: row.objectType as ObjectType,
      key: row.key,
      label: row.label,
      fieldType: row.fieldType as FieldDefinition['fieldType'],
      config: row.config,
      defaultValue: row.defaultValue ?? undefined,
      permissions: row.permissions as FieldDefinition['permissions'],
      lifecycle: row.lifecycle as FieldDefinition['lifecycle'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
