import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';

import type { AIProvider, AITokenUsage } from '@luminaos/ai-gateway';
import {
  addChecklistItem as addChecklistItemCommand,
  applyDefaultFieldValues,
  archiveObject,
  assertGroupableField,
  assertSortableField,
  assertValidFilterCondition,
  canEditField,
  canViewField,
  clearRecurrenceRule as clearRecurrenceRuleCommand,
  computeAggregate,
  createObject,
  evaluateFormula,
  getAffectedFormulaKeysInOrder,
  isKnownObjectType,
  newObjectId,
  parseFormula,
  clearTimeBlockSchedule as clearTimeBlockScheduleCommand,
  removeChecklistItem as removeChecklistItemCommand,
  renameObject,
  reorderChecklistItem as reorderChecklistItemCommand,
  replayFieldValues,
  replayObject,
  restoreObject,
  scheduleTimeBlock as scheduleTimeBlockCommand,
  setFieldValues as setFieldValuesCommand,
  setRecurrenceRule as setRecurrenceRuleCommand,
  softDeleteObject,
  toggleChecklistItem as toggleChecklistItemCommand,
} from '@luminaos/core-objects';
import type {
  AggregateFn,
  FieldDefinition,
  FormulaFieldDependency,
  LuminaObject,
  ObjectEventDraft,
  ObjectType,
  RecurrenceRule,
  Role,
} from '@luminaos/core-objects';
import {
  ForbiddenError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
} from '@luminaos/shared';
import type { Actor, NewDomainEvent, QuerySpec } from '@luminaos/shared';

import {
  ObjectsViewProjection,
  parseChecklistColumn,
  parseRecurrenceRuleColumn,
} from './objects-view.projection.js';
import {
  assertOperatorValueShape,
  buildFilterPredicate,
  buildGroupNotNullPredicate,
  buildKeysetPredicate,
  buildOrderBy,
  buildSortColumns,
  decodeCursor,
  encodeCursor,
  extractCursorValues,
  extractGroupValue,
  FIXED_COLUMN_OPERATORS,
  isFixedColumnKey,
} from './query-builder.js';
import { detectStatusDoneTransition } from './status-done-transition.js';
import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { AIRefreshScheduler } from '../ai/ai-refresh-scheduler.service.js';
import { AIUsageProjection } from '../ai/ai-usage.projection.js';
import { resolveAIFieldValue } from '../ai/resolve-ai-field-value.js';
import { TimeBlockPushService } from '../calendar/timeblock-push.service.js';
import { env } from '../config/env.js';
import { DATABASE_CONNECTION } from '../db/db.module.js';
import { aiUsageRecords } from '../db/schema/ai-usage.js';
import { fieldDefinitions } from '../db/schema/field-definitions.js';
import { objectsView } from '../db/schema/objects-view.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';
import { TaskRecurrenceService } from '../recurrence/task-recurrence.service.js';

import type { Database } from '../db/client.js';
import type { SQL } from 'drizzle-orm';

const STREAM_TYPE = 'lumina-object';

/** The dedicated event-stream type for `AIUsageRecorded` events — one brand-new stream per usage record, never the object's own stream (F1-T5 PR-C). */
const AI_USAGE_STREAM_TYPE = 'ai-usage';

/** The always-and-only actor recorded for a formula field's own recomputed
 * `FieldValueChanged` events -- never the caller's own actor, since the
 * caller never directly wrote these values (F1-T4 plan). */
const FORMULA_ENGINE_ACTOR: Actor = { type: 'system', id: 'formula-engine' };

/**
 * The always-and-only actor recorded for an `ai` field's own system-computed
 * `FieldValueChanged` events (F1-T5 PR-C) -- deliberately `'agent'`, not
 * `'system'` like `FORMULA_ENGINE_ACTOR`: an AI-gateway completion is a real
 * (if automated) agent action, distinct from the purely deterministic
 * formula engine. Always this actor regardless of who/what triggered the
 * refresh (manual `POST .../refresh` or an `onSourceChange` cascade).
 */
const AI_GATEWAY_ACTOR: Actor = { type: 'agent', id: 'ai-gateway' };

/**
 * The shape `defineField`/`updateField`'s own `aiConfigSchema` guarantees an
 * `ai`-typed `FieldDefinition.config` always carries by construction once it
 * reaches here -- mirrors `formulaExpression`'s exact "single place this
 * assumption is documented and asserted" reasoning.
 */
interface AIFieldConfig {
  promptTemplate: string;
  sourceFields: string[];
  outputType: 'text' | 'select';
  refreshMode: 'manual' | 'onSourceChange';
  options?: string[];
}

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

/**
 * `ObjectsService.query`'s (F1-T6 PR-C) return shape: flat, paginated
 * `{ objects, nextCursor? }` when `QuerySpec.group` is absent, or
 * `{ groups }` (no pagination at all) when it's present -- see
 * `object-query.integration.test.ts`'s header comment for the full
 * flat-vs-group contract this pins.
 */
export type QueryResult =
  | { objects: ObjectWithFieldValues[]; nextCursor?: string }
  | { groups: { groupValue: string; count: number; items: ObjectWithFieldValues[] }[] };

/** `QuerySpec.limit`'s default when the caller doesn't specify one (F1-T6 PR-C, flat mode only). */
const DEFAULT_QUERY_LIMIT = 50;

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

  /** Same "single, stable instance" reasoning as `projection` above, for the `ai_usage_records` read model (F1-T5 PR-C). */
  private readonly aiUsageProjection = new AIUsageProjection();

  private readonly logger = new Logger(ObjectsService.name);

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
    private readonly aiRefreshScheduler: AIRefreshScheduler,
    @Inject(AI_PROVIDER) private readonly aiProvider: AIProvider,
    private readonly taskRecurrenceService: TaskRecurrenceService,
    private readonly timeBlockPush: TimeBlockPushService,
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

  /**
   * F1-T10 PR6b: server-generates `itemId` via `newObjectId()` -- the SAME
   * mechanism `create()` uses for `objectId` itself -- so the caller only
   * ever supplies `text`, never an id of their own choosing.
   */
  async addChecklistItem(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    callerRole: Role,
    input: { text: string },
  ): Promise<ObjectWithFieldValues> {
    const itemId = newObjectId();

    return this.applyCommandWithFieldValues(workspaceId, objectId, actor, callerRole, (state) =>
      addChecklistItemCommand(state, { itemId, text: input.text }),
    );
  }

  async toggleChecklistItem(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    callerRole: Role,
    itemId: string,
  ): Promise<ObjectWithFieldValues> {
    return this.applyCommandWithFieldValues(workspaceId, objectId, actor, callerRole, (state) =>
      toggleChecklistItemCommand(state, itemId),
    );
  }

  async removeChecklistItem(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    callerRole: Role,
    itemId: string,
  ): Promise<ObjectWithFieldValues> {
    return this.applyCommandWithFieldValues(workspaceId, objectId, actor, callerRole, (state) =>
      removeChecklistItemCommand(state, itemId),
    );
  }

  async reorderChecklistItem(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    callerRole: Role,
    orderedItemIds: string[],
  ): Promise<ObjectWithFieldValues> {
    return this.applyCommandWithFieldValues(workspaceId, objectId, actor, callerRole, (state) =>
      reorderChecklistItemCommand(state, orderedItemIds),
    );
  }

  async setRecurrenceRule(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    callerRole: Role,
    input: RecurrenceRule,
  ): Promise<ObjectWithFieldValues> {
    return this.applyCommandWithFieldValues(workspaceId, objectId, actor, callerRole, (state) =>
      setRecurrenceRuleCommand(state, input),
    );
  }

  async clearRecurrenceRule(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    callerRole: Role,
  ): Promise<ObjectWithFieldValues> {
    return this.applyCommandWithFieldValues(workspaceId, objectId, actor, callerRole, (state) =>
      clearRecurrenceRuleCommand(state),
    );
  }

  /**
   * F1-T12 PR5d: schedules the timeblock via the shared
   * `applyCommandWithFieldValues` write path, then best-effort pushes the
   * new schedule to every calendar account the timeblock's CREATOR has
   * connected. The push is wrapped in try/catch -- the command itself has
   * already succeeded and been durably persisted by the time the push is
   * attempted, so a push failure must never fail this method's own result.
   */
  async scheduleTimeBlock(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    callerRole: Role,
    input: { start: string; end: string },
  ): Promise<ObjectWithFieldValues> {
    const object = await this.applyCommandWithFieldValues(
      workspaceId,
      objectId,
      actor,
      callerRole,
      (state) => scheduleTimeBlockCommand(state, input),
    );

    try {
      await this.timeBlockPush.pushScheduled(
        objectId,
        workspaceId,
        object.createdBy,
        object.title,
        input,
      );
    } catch (error) {
      this.logger.error(
        `Timeblock schedule push failed for object ${objectId} (workspace ${workspaceId}); the schedule write itself already succeeded.`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return object;
  }

  /** Same "best-effort, never fails the request" reasoning as `scheduleTimeBlock` above, for the clear side. */
  async clearTimeBlockSchedule(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    callerRole: Role,
  ): Promise<ObjectWithFieldValues> {
    const object = await this.applyCommandWithFieldValues(
      workspaceId,
      objectId,
      actor,
      callerRole,
      (state) => clearTimeBlockScheduleCommand(state),
    );

    try {
      await this.timeBlockPush.pushCleared(objectId);
    } catch (error) {
      this.logger.error(
        `Timeblock schedule clear push failed for object ${objectId} (workspace ${workspaceId}); the clear write itself already succeeded.`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return object;
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
   * F1-T6 PR-C: the server-side query/filter/sort/group engine. Validation
   * precedence (exact order, per `object-query.integration.test.ts`'s
   * header comment): (1) unknown `objectType` -> `ValidationError`; (2)
   * every field key referenced by `filters`/`sort`/`group` that is not one
   * of the three fixed columns (`title`/`createdAt`/`updatedAt`) must
   * resolve to an active, caller-VISIBLE field definition, or `NotFoundError`
   * -- same "hidden must be indistinguishable from undefined" reasoning as
   * `setFieldValues`'s own lookup; (3) each filter's operator must be valid
   * for its field's type (`assertValidFilterCondition` for custom fields, a
   * local fixed-column operator table otherwise); (4) each sort field must
   * be sortable; (5) a `group` field must be groupable; (6) each filter's
   * `value` must match its operator's arity, independent of field type.
   * Only once every one of these passes does this compile and run the
   * actual SQL query (`query-builder.ts`).
   */
  async query(workspaceId: string, callerRole: Role, querySpec: QuerySpec): Promise<QueryResult> {
    if (!isKnownObjectType(querySpec.objectType)) {
      throw new ValidationError('unknown object type', { objectType: querySpec.objectType });
    }

    const objectType: ObjectType = querySpec.objectType;
    const definitions = await this.getActiveFieldDefinitionsForType(workspaceId, objectType);
    const definitionsByKey = new Map(definitions.map((definition) => [definition.key, definition]));

    const resolveField = (field: string) => {
      if (isFixedColumnKey(field)) {
        return { kind: 'fixed' as const, key: field };
      }

      const definition = definitionsByKey.get(field);

      // Same "hidden must be indistinguishable from undefined" reasoning as
      // `setFieldValues`'s own lookup (security review precedent) -- a
      // distinguishable 403/other-shaped error here would let a caller
      // enumerate hidden field keys via a query request.
      if (!definition || !canViewField(definition.permissions, callerRole)) {
        throw new NotFoundError(
          'No active field definition found for this key on this object type.',
        );
      }

      return { kind: 'custom' as const, key: field, fieldType: definition.fieldType };
    };

    // Step 2: resolve every referenced field key across filters/sort/group
    // BEFORE any operator/value validation -- a hidden or undefined field
    // key must 404 regardless of what else is wrong with the request.
    const resolvedFilters = querySpec.filters.map((condition) => ({
      condition,
      field: resolveField(condition.field),
    }));

    const sortSpecs = querySpec.sort ?? [];
    const resolvedSort = sortSpecs.map((sortEntry) => resolveField(sortEntry.field));

    const resolvedGroup = querySpec.group !== undefined ? resolveField(querySpec.group) : undefined;

    // Step 3: operator validity per filter.
    for (const { condition, field } of resolvedFilters) {
      if (field.kind === 'fixed') {
        const allowedOperators = FIXED_COLUMN_OPERATORS[field.key];

        if (!allowedOperators.includes(condition.operator)) {
          throw new ValidationError('operator is not valid for this fixed column', {
            field: field.key,
            operator: condition.operator,
          });
        }
      } else {
        const definition = definitionsByKey.get(field.key);

        if (definition) {
          assertValidFilterCondition(definition, condition);
        }
      }
    }

    // Step 4: sortability.
    for (const field of resolvedSort) {
      if (field.kind === 'custom') {
        const definition = definitionsByKey.get(field.key);

        if (definition) {
          assertSortableField(definition);
        }
      }
    }

    // Step 5: groupability -- fixed columns are never `select`-typed, so
    // they can never be groupable.
    if (resolvedGroup) {
      if (resolvedGroup.kind === 'fixed') {
        throw new ValidationError('fixed columns are not groupable', {
          field: resolvedGroup.key,
        });
      }

      const definition = definitionsByKey.get(resolvedGroup.key);

      if (definition) {
        assertGroupableField(definition);
      }
    }

    // Step 6: operator-driven `value` shape rules, independent of field type.
    for (const { condition } of resolvedFilters) {
      assertOperatorValueShape(condition.operator, condition.value);
    }

    const filterPredicates = resolvedFilters.map(({ condition, field }) =>
      buildFilterPredicate(field, condition),
    );

    const baseWhere = and(
      eq(objectsView.workspaceId, workspaceId),
      eq(objectsView.type, objectType),
      ne(objectsView.lifecycle, 'deleted'),
      ...filterPredicates,
    );

    if (!baseWhere) {
      // Unreachable: the three scope predicates above are always present.
      throw new ValidationError('failed to build query predicate');
    }

    if (querySpec.group !== undefined) {
      return this.queryGrouped(baseWhere, querySpec.group, definitions, callerRole);
    }

    return this.queryFlat(baseWhere, querySpec, definitions, callerRole, definitionsByKey);
  }

  /** Flat (non-grouped) mode of `query`: real ORDER BY + keyset cursor pagination. See `query-builder.ts` for the SQL compilation this delegates to. */
  private async queryFlat(
    where: SQL,
    querySpec: QuerySpec,
    definitions: FieldDefinition[],
    callerRole: Role,
    definitionsByKey: Map<string, FieldDefinition>,
  ): Promise<{ objects: ObjectWithFieldValues[]; nextCursor?: string }> {
    const sortColumns = buildSortColumns(
      querySpec.sort,
      (field) => definitionsByKey.get(field)?.fieldType,
    );

    let effectiveWhere = where;

    if (querySpec.cursor !== undefined) {
      const cursorValues = decodeCursor(querySpec.cursor);
      const keysetPredicate = buildKeysetPredicate(sortColumns, cursorValues);
      const combined = and(effectiveWhere, keysetPredicate);

      if (!combined) {
        throw new ValidationError('failed to build query predicate');
      }

      effectiveWhere = combined;
    }

    const limit = querySpec.limit ?? DEFAULT_QUERY_LIMIT;

    const rows = await this.db
      .select()
      .from(objectsView)
      .where(effectiveWhere)
      .orderBy(...buildOrderBy(sortColumns))
      .limit(limit + 1);

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const objects = pageRows.map((row) =>
      this.toObjectWithFieldValues(row, definitions, callerRole),
    );
    const lastRow = pageRows[pageRows.length - 1];

    if (hasNextPage && lastRow) {
      return { objects, nextCursor: encodeCursor(extractCursorValues(lastRow, sortColumns)) };
    }

    return { objects };
  }

  /**
   * Group mode of `query`: fetches EVERY matching row (still scoped by
   * `where`, which already includes `filters`), excluding any row whose
   * group field has no value at all, then groups them in application code.
   * `sort`/`cursor`/`limit` are never consulted here -- group mode has no
   * pagination at all (per this PR's pinned contract).
   */
  private async queryGrouped(
    where: SQL,
    groupField: string,
    definitions: FieldDefinition[],
    callerRole: Role,
  ): Promise<{ groups: { groupValue: string; count: number; items: ObjectWithFieldValues[] }[] }> {
    const combined = and(where, buildGroupNotNullPredicate(groupField));

    if (!combined) {
      throw new ValidationError('failed to build query predicate');
    }

    const rows = await this.db.select().from(objectsView).where(combined);

    const rowsByGroupValue = new Map<string, (typeof objectsView.$inferSelect)[]>();

    for (const row of rows) {
      const groupValue = String(extractGroupValue(row, groupField));
      const existing = rowsByGroupValue.get(groupValue);

      if (existing) {
        existing.push(row);
      } else {
        rowsByGroupValue.set(groupValue, [row]);
      }
    }

    const groups = Array.from(rowsByGroupValue.entries()).map(([groupValue, groupRows]) => ({
      groupValue,
      count: groupRows.length,
      items: groupRows.map((row) => this.toObjectWithFieldValues(row, definitions, callerRole)),
    }));

    return { groups };
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

      // Same reasoning as the `formula` guard above -- an `ai` field's value
      // is always computed by the ai-gateway, never directly writable
      // (F1-T5 PR-C).
      if (definition.fieldType === 'ai') {
        throw new ValidationError('cannot directly set a value for a computed ai field', {
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

    // Captured BEFORE the loop below mutates `workingFieldValues` -- the
    // `status` value as it stood immediately before THIS write, per
    // ADR-0010 §(f)'s false->true transition detection (`undefined` if
    // `status` was never set, which `detectStatusDoneTransition` treats as
    // `isDone: false`).
    const priorStatusValue = workingFieldValues.status;
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

    // ADR-0010 §"(d) Orkestrasyon yeri"/"(f) Tetikleyici tespiti": ONLY
    // reachable after this method's own `append` above has resolved
    // successfully (a write that never durably lands must never trigger
    // recurrence generation). For every entry THIS caller submitted for
    // `fieldKey === 'status'` (never a formula-recompute entry -- those never
    // touch `status`), detects a genuine `isDone` false->true transition
    // against the PRIOR `status` value and, on a genuine transition, calls
    // `TaskRecurrenceService` with the causation event's OWN id (the
    // `status` `FieldValueChanged` event THIS entry produced, never any
    // other event in the same append batch).
    //
    // Wrapped in try/catch (security-review finding, F1-T10 PR4): per
    // ADR-0010 §(e), this side effect may fail without rolling back the main
    // write -- but by the time we're here, this method's own `append` has
    // ALREADY durably committed the `status` change. Letting an exception
    // from here propagate would turn an already-successful write into a
    // misleading failed HTTP response to the caller (and to any retry
    // logic). Log-and-continue is the correct isolation, mirroring why
    // `scheduleOnSourceChangeAIRefreshes` below is fire-and-forget for the
    // exact same reason.
    try {
      await this.triggerTaskRecurrenceOnStatusDoneTransitions(
        workspaceId,
        objectId,
        actor,
        entries,
        userEvents,
        definitions,
        priorStatusValue,
        object.title,
        fieldValues,
      );
    } catch (error) {
      this.logger.error(
        `Task recurrence generation failed for object ${objectId} (workspace ${workspaceId}); the field write itself already succeeded.`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    // `onSourceChange` AI-refresh scheduling -- ONLY reachable from this
    // USER-triggered write path, never from `refreshAIField`'s own internal
    // `FieldValueChanged` write. This is what structurally prevents
    // AI-to-AI cascading ("AI kaynaklı değişiklik yeni AI yenilemesi
    // tetiklemez", F1-T5 plan): an `ai` field's own system-computed write
    // never runs through `setFieldValues` at all, so it can never reach this
    // scheduling call. Fires for every key genuinely written by THIS
    // operation -- the caller's own entries plus whatever the formula engine
    // recomputed as a result, since both are real value changes this
    // request produced.
    const recomputedKeys = recomputeDrafts.map(
      (draft) => (draft.payload as { fieldKey: string }).fieldKey,
    );
    this.scheduleOnSourceChangeAIRefreshes(workspaceId, objectId, definitions, [
      ...changedKeys,
      ...recomputedKeys,
    ]);

    return {
      ...object,
      fieldValues: this.filterFieldValuesForRole(fieldValues, definitions, callerRole),
    };
  }

  /**
   * `setFieldValues`'s own ADR-0010 §(d)/(f) wiring, extracted only to keep
   * `setFieldValues` itself readable. `entries[index]` and `userEvents[index]`
   * are guaranteed 1:1 (`setFieldValuesCommand`/`wrapDrafts` both preserve
   * input order, one draft per entry), which is what lets this read
   * `userEvents[index].id` as the exact `FieldValueChanged` event THIS entry
   * produced -- never a formula-recompute event appended in the same batch
   * (those live in `systemEvents`, never `userEvents`).
   */
  private async triggerTaskRecurrenceOnStatusDoneTransitions(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    entries: SetFieldValueEntry[],
    userEvents: NewDomainEvent[],
    definitions: FieldDefinition[],
    priorStatusValue: unknown,
    title: string,
    fieldValues: Record<string, unknown>,
  ): Promise<void> {
    for (const [index, entry] of entries.entries()) {
      if (entry.fieldKey !== 'status') {
        continue;
      }

      const isGenuineTransition = detectStatusDoneTransition({
        fieldKey: entry.fieldKey,
        definitions,
        previousValue: priorStatusValue,
        newValue: entry.value,
      });

      if (!isGenuineTransition) {
        continue;
      }

      const causationEvent = userEvents[index];

      if (!causationEvent) {
        // Unreachable given the 1:1 `entries`/`userEvents` invariant this
        // method's own doc comment documents -- defensive only.
        continue;
      }

      await this.taskRecurrenceService.generateNextOccurrence({
        workspaceId,
        actor,
        sourceObjectId: objectId,
        causationEventId: causationEvent.id,
        nextOccurrence: {
          title,
          fieldValues: this.buildNextOccurrenceFieldValues(fieldValues, definitions),
        },
      });
    }
  }

  /**
   * The generated next occurrence's own `fieldValues`, per ADR-0010 §(g):
   * every OTHER custom field value is copied as-is from this write's
   * resulting `fieldValues`, but `status` is reset to the first option in
   * the active `status` field definition's `config.options` that does NOT
   * carry `isDone: true` -- a fresh, non-done starting point for the new
   * occurrence's own lifecycle.
   */
  private buildNextOccurrenceFieldValues(
    fieldValues: Record<string, unknown>,
    definitions: FieldDefinition[],
  ): Record<string, unknown> {
    const statusDefinition = definitions.find(
      (definition) =>
        definition.key === 'status' &&
        definition.fieldType === 'select' &&
        definition.lifecycle === 'active',
    );

    if (!statusDefinition) {
      // Unreachable in practice -- `detectStatusDoneTransition` already
      // requires an active `status` select definition to ever return `true`
      // in the first place. Defensive fallback only.
      return { ...fieldValues };
    }

    const { options } = statusDefinition.config as {
      options: { value: string; isDone?: boolean }[];
    };
    const firstNonDoneOption = options.find((option) => option.isDone !== true);

    return {
      ...fieldValues,
      ...(firstNonDoneOption ? { status: firstNonDoneOption.value } : {}),
    };
  }

  /**
   * Resolves `objectId -> streamId, objectType` (same lookup
   * `lookupStreamIdAndType` already performs), finds `fieldKey`'s active
   * `ai` field definition, enforces its own quota + role-visibility rules,
   * renders its prompt against the object's current field values, calls the
   * injected `AIProvider` (retrying once for an `outputType: 'select'`
   * response that isn't a valid option), and appends the resolved value as a
   * `FieldValueChanged` event authored by `AI_GATEWAY_ACTOR` -- own, single
   * atomic `append` call, entirely separate from whatever triggered this
   * refresh (a manual `POST .../refresh` or a scheduled `onSourceChange`
   * cascade).
   */
  async refreshAIField(
    workspaceId: string,
    objectId: string,
    fieldKey: string,
    actor: Actor,
    callerRole: Role,
  ): Promise<ObjectWithFieldValues> {
    void actor;

    const { streamId, objectType } = await this.lookupStreamIdAndType(workspaceId, objectId);
    const definitions = await this.getActiveFieldDefinitionsForType(workspaceId, objectType);
    const definition = definitions.find((candidate) => candidate.key === fieldKey);

    // Same "hidden field must be indistinguishable from undefined" reasoning
    // as `setFieldValues`'s own lookup -- a non-`ai` field key is ALSO
    // treated as not-found here (this route only makes sense for `ai`
    // fields; leaking "it exists, but as a different type" via a different
    // error would itself be an information leak).
    if (
      !definition ||
      !canViewField(definition.permissions, callerRole) ||
      definition.fieldType !== 'ai'
    ) {
      throw new NotFoundError(
        'No active ai field definition found for this key on this object type.',
      );
    }

    return this.withWorkspaceAILock(workspaceId, () =>
      this.performAIFieldRefresh(
        workspaceId,
        streamId,
        objectId,
        fieldKey,
        definition,
        definitions,
        callerRole,
      ),
    );
  }

  /**
   * The actual quota-check-through-write body of `refreshAIField`, run
   * inside `withWorkspaceAILock` so two concurrent refresh operations for
   * the same workspace can never both read the same pre-call cumulative
   * usage and both proceed (security review finding, F1-T5 PR-C) -- see
   * `withWorkspaceAILock`'s own doc comment.
   */
  private async performAIFieldRefresh(
    workspaceId: string,
    streamId: string,
    objectId: string,
    fieldKey: string,
    definition: FieldDefinition,
    definitions: FieldDefinition[],
    callerRole: Role,
  ): Promise<ObjectWithFieldValues> {
    // Quota is checked EXACTLY ONCE per refresh operation, before the FIRST
    // provider call -- never re-checked between the first attempt and its
    // retry (F1-T5 PR-C design decision, see `object-ai-refresh.integration.test.ts`).
    await this.assertAITokenQuotaNotExceeded(workspaceId);

    const priorEvents = await this.eventStore.readStream(streamId);
    const fieldValues = replayFieldValues(priorEvents);

    const config = this.aiFieldConfig(definition);

    const resolvedValue = await resolveAIFieldValue({
      provider: this.aiProvider,
      promptTemplate: config.promptTemplate,
      sourceFieldValues: fieldValues,
      outputType: config.outputType,
      ...(config.options !== undefined ? { options: config.options } : {}),
      recordUsage: (usage) => this.recordAIUsage(workspaceId, definition.id, objectId, usage),
    });

    const draft: ObjectEventDraft = {
      type: 'FieldValueChanged',
      payload: { objectId, fieldKey, value: resolvedValue },
    };

    const newEvents = this.wrapDrafts([draft], workspaceId, AI_GATEWAY_ACTOR);
    const appended = await this.eventStore.append(streamId, priorEvents.length, newEvents);

    await this.projectionRunner.catchUp(this.projection);

    const allEvents = [...priorEvents, ...appended];
    const object = replayObject(allEvents);
    const updatedFieldValues = replayFieldValues(allEvents);

    return {
      ...object,
      fieldValues: this.filterFieldValuesForRole(updatedFieldValues, definitions, callerRole),
    };
  }

  /**
   * Serializes every `refreshAIField` critical section (quota check through
   * the final field-value write) per WORKSPACE, via a Postgres session-level
   * advisory lock (`pg_advisory_lock`/`pg_advisory_unlock`) taken on a
   * dedicated connection checked out from the pool -- closes a TOCTOU race
   * where two concurrent refreshes could both read the same pre-call
   * cumulative usage total and both proceed, letting a workspace's actual
   * spend silently exceed `env.aiTokenQuotaPerWorkspace` (security review
   * finding, F1-T5 PR-C; see
   * `object-ai-refresh.integration.test.ts`'s "two CONCURRENT refresh
   * operations" test). `hashtext(workspaceId)` scopes the lock per
   * workspace, so concurrent refreshes in DIFFERENT workspaces never contend
   * with each other. The lock is held across the real `AIProvider.complete()`
   * call(s) -- an accepted v0 tradeoff (refreshes are not a hot path: manual
   * or debounced) in exchange for a simple, well-understood correctness
   * guarantee, instead of holding a DB transaction open across an external
   * HTTP call.
   */
  private async withWorkspaceAILock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.db.$client.connect();

    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [workspaceId]);

      try {
        return await fn();
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [workspaceId]);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Schedules a debounced `refreshAIField` call (via `aiRefreshScheduler`)
   * for every ACTIVE, `ai`-typed, `refreshMode: 'onSourceChange'` field
   * definition whose `config.sourceFields` intersects `changedKeys`. Called
   * ONLY from `setFieldValues` (the user-triggered write path) -- see that
   * method's own doc comment for why this structurally prevents AI-to-AI
   * cascading. Uses the permissive `'owner'` role for the scheduled
   * refresh's own visibility check -- there is no real external caller to
   * protect via filtering for a system-scheduled background action.
   */
  private scheduleOnSourceChangeAIRefreshes(
    workspaceId: string,
    objectId: string,
    definitions: FieldDefinition[],
    changedKeys: string[],
  ): void {
    const changedKeySet = new Set(changedKeys);

    for (const definition of definitions) {
      if (definition.fieldType !== 'ai') {
        continue;
      }

      const config = this.aiFieldConfig(definition);

      if (config.refreshMode !== 'onSourceChange') {
        continue;
      }

      if (!config.sourceFields.some((sourceFieldKey) => changedKeySet.has(sourceFieldKey))) {
        continue;
      }

      this.aiRefreshScheduler.schedule(objectId, definition.key, async () => {
        await this.refreshAIField(workspaceId, objectId, definition.key, AI_GATEWAY_ACTOR, 'owner');
      });
    }
  }

  /** See `AIFieldConfig`'s own doc comment for the assumption this asserts. */
  private aiFieldConfig(definition: FieldDefinition): AIFieldConfig {
    return definition.config as AIFieldConfig;
  }

  /**
   * Throws `QuotaExceededError` if this workspace's cumulative
   * `ai_usage_records` usage (`SUM(inputTokens + outputTokens)`) already
   * meets or exceeds `env.aiTokenQuotaPerWorkspace` -- checked BEFORE any
   * provider call, per `refreshAIField`'s own "once per operation" design
   * decision.
   */
  private async assertAITokenQuotaNotExceeded(workspaceId: string): Promise<void> {
    const [row] = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(${aiUsageRecords.inputTokens} + ${aiUsageRecords.outputTokens}), 0)`,
      })
      .from(aiUsageRecords)
      .where(eq(aiUsageRecords.workspaceId, workspaceId));

    const totalTokensUsed = Number(row?.total ?? 0);

    if (totalTokensUsed >= env.aiTokenQuotaPerWorkspace) {
      throw new QuotaExceededError('AI token quota exceeded for this workspace.', { workspaceId });
    }
  }

  /**
   * Records `usage` as an `AIUsageRecorded` event on its OWN dedicated
   * stream (own atomic `append`, separate from the object's own stream --
   * see `AI_USAGE_STREAM_TYPE`'s doc comment). Passed to
   * `resolveAIFieldValue` as its `recordUsage` callback.
   */
  private async recordAIUsage(
    workspaceId: string,
    fieldDefinitionId: string,
    objectId: string,
    usage: AITokenUsage,
  ): Promise<void> {
    const usageStreamId = randomUUID();
    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: AI_USAGE_STREAM_TYPE,
      workspaceId,
      type: 'AIUsageRecorded',
      payload: {
        workspaceId,
        fieldDefinitionId,
        objectId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
      actor: AI_GATEWAY_ACTOR,
      occurredAt: new Date(),
    };

    await this.eventStore.append(usageStreamId, 0, [event]);
    await this.projectionRunner.catchUp(this.aiUsageProjection);
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

  /**
   * F1-T10 PR6b: the checklist/recurrenceRule write path -- mirrors
   * `applyCommand` exactly (`lookupStreamIdAndType` -> `eventStore.readStream`
   * -> `replayObject` -> run the pure command -> `wrapDrafts` ->
   * `eventStore.append` -> `projectionRunner.catchUp` -> `replayObject` again)
   * but ALSO replays/attaches+role-filters `fieldValues`, the same way
   * `setFieldValues` does -- so a checklist/recurrenceRule mutation's response
   * always carries the object's CURRENT `fieldValues` untouched, rather than
   * silently dropping them. No formula-recompute step: checklist/
   * recurrenceRule are embedded object state, never a formula input.
   */
  private async applyCommandWithFieldValues(
    workspaceId: string,
    objectId: string,
    actor: Actor,
    callerRole: Role,
    command: (state: LuminaObject) => ObjectEventDraft[],
  ): Promise<ObjectWithFieldValues> {
    const { streamId, objectType } = await this.lookupStreamIdAndType(workspaceId, objectId);
    const definitions = await this.getActiveFieldDefinitionsForType(workspaceId, objectType);

    const priorEvents = await this.eventStore.readStream(streamId);
    const state = replayObject(priorEvents);

    const drafts = command(state);
    const newEvents = this.wrapDrafts(drafts, workspaceId, actor);
    const appended = await this.eventStore.append(streamId, priorEvents.length, newEvents);

    await this.projectionRunner.catchUp(this.projection);

    const allEvents = [...priorEvents, ...appended];
    const object = replayObject(allEvents);
    const fieldValues = replayFieldValues(allEvents);

    return {
      ...object,
      fieldValues: this.filterFieldValuesForRole(fieldValues, definitions, callerRole),
    };
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

  /**
   * F1-T10 PR6a: `checklist`/`recurrenceRule` now read the REAL folded state
   * `objects_view.checklist`/`.recurrence_rule` carry (see
   * `ObjectsViewProjection`) instead of the previous hardcoded `checklist: []`
   * placeholder. `recurrenceRule` treats a Postgres `NULL` (or `undefined`,
   * for callers who never had the column at all) as "no rule set" -- mirrors
   * `LuminaObject.recurrenceRule?`'s own optional-field convention.
   */
  private toLuminaObject(row: typeof objectsView.$inferSelect): LuminaObject {
    const checklist = parseChecklistColumn(row.checklist ?? []);
    const recurrenceRule = parseRecurrenceRuleColumn(row.recurrenceRule);
    // F1-T12 PR3: `timeBlock` is present only when BOTH columns are set
    // (mirrors `recurrenceRule`'s optional-spread convention above) --
    // either column being NULL means "no schedule set", never a
    // half-populated `timeBlock`.
    const timeBlock =
      row.timeBlockStart !== null && row.timeBlockEnd !== null
        ? { start: row.timeBlockStart.toISOString(), end: row.timeBlockEnd.toISOString() }
        : undefined;

    return {
      id: row.id,
      type: row.type as ObjectType,
      workspaceId: row.workspaceId,
      title: row.title,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lifecycle: row.lifecycle as LuminaObject['lifecycle'],
      checklist,
      ...(recurrenceRule !== undefined ? { recurrenceRule } : {}),
      ...(timeBlock !== undefined ? { timeBlock } : {}),
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
