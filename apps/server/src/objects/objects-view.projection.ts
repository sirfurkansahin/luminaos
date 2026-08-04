import { eq, sql } from 'drizzle-orm';

import type { ChecklistItem, RecurrenceRule } from '@luminaos/core-objects';
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

function requireNumberPayloadField(event: DomainEvent, field: string): number {
  const value = event.payload[field];

  if (typeof value !== 'number') {
    throw new InvalidObjectStateError(
      `"${event.type}" event is missing a valid "${field}" payload field`,
    );
  }

  return value;
}

function requireBooleanPayloadField(event: DomainEvent, field: string): boolean {
  const value = event.payload[field];

  if (typeof value !== 'boolean') {
    throw new InvalidObjectStateError(
      `"${event.type}" event is missing a valid "${field}" payload field`,
    );
  }

  return value;
}

function requireStringArrayPayloadField(event: DomainEvent, field: string): string[] {
  const value = event.payload[field];

  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === 'string')
  ) {
    throw new InvalidObjectStateError(
      `"${event.type}" event is missing a valid "${field}" payload field`,
    );
  }

  return value;
}

/**
 * The same `frequency`/`interval`/`byWeekday`/`endDate` validation
 * `packages/core-objects/src/replay.ts`'s own `RecurrenceRuleSet` fold case
 * uses -- mirrored exactly here so the projection and the pure domain replay
 * never diverge (see this file's class-level doc comment).
 */
function parseRecurrenceRulePayload(event: DomainEvent): RecurrenceRule {
  const { frequency, interval, byWeekday, endDate } = event.payload;

  if (frequency !== 'daily' && frequency !== 'weekly' && frequency !== 'monthly') {
    throw new InvalidObjectStateError(
      '"RecurrenceRuleSet" event has an invalid or unknown "frequency" payload field',
    );
  }

  if (typeof interval !== 'number' || !Number.isInteger(interval)) {
    throw new InvalidObjectStateError(
      '"RecurrenceRuleSet" event is missing a valid "interval" payload field',
    );
  }

  if (
    byWeekday !== undefined &&
    (!Array.isArray(byWeekday) || !byWeekday.every((day): day is number => typeof day === 'number'))
  ) {
    throw new InvalidObjectStateError(
      '"RecurrenceRuleSet" event has an invalid "byWeekday" payload field',
    );
  }

  if (endDate !== undefined && typeof endDate !== 'string') {
    throw new InvalidObjectStateError(
      '"RecurrenceRuleSet" event has an invalid "endDate" payload field',
    );
  }

  return {
    frequency,
    interval,
    ...(byWeekday !== undefined ? { byWeekday } : {}),
    ...(endDate !== undefined ? { endDate } : {}),
  };
}

/**
 * Runtime shape-check for a single row's already-JSON-parsed `checklist`
 * column value -- deliberately permissive about EXTRA keys (forward
 * compatibility) but strict about the four keys this projection itself both
 * reads and writes, mirroring `ChecklistItem`'s own shape.
 */
function isChecklistItem(value: unknown): value is ChecklistItem {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate['id'] === 'string' &&
    typeof candidate['text'] === 'string' &&
    typeof candidate['done'] === 'boolean' &&
    typeof candidate['order'] === 'number'
  );
}

export function parseChecklistColumn(value: unknown): ChecklistItem[] {
  if (!Array.isArray(value) || !value.every(isChecklistItem)) {
    throw new InvalidObjectStateError(
      'objects_view.checklist column contains a malformed checklist array',
    );
  }

  return value;
}

/**
 * Runtime shape-check for the already-JSON-parsed `recurrence_rule` column
 * value -- `NULL`/`undefined` (no rule set) passes through as `undefined`;
 * anything else must match `RecurrenceRule`'s shape exactly (same rules
 * `parseRecurrenceRulePayload` enforces on the write side), so a corrupted
 * column value fails loudly here rather than silently reaching an HTTP
 * response with a wrong/partial shape (security-reviewer finding, F1-T10
 * PR6a).
 */
export function parseRecurrenceRuleColumn(value: unknown): RecurrenceRule | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== 'object') {
    throw new InvalidObjectStateError(
      'objects_view.recurrence_rule column contains a malformed value',
    );
  }

  const candidate = value as Record<string, unknown>;
  const { frequency, interval, byWeekday, endDate } = candidate;

  if (frequency !== 'daily' && frequency !== 'weekly' && frequency !== 'monthly') {
    throw new InvalidObjectStateError(
      'objects_view.recurrence_rule column has an invalid or unknown "frequency"',
    );
  }

  if (typeof interval !== 'number' || !Number.isInteger(interval)) {
    throw new InvalidObjectStateError(
      'objects_view.recurrence_rule column has an invalid "interval"',
    );
  }

  if (
    byWeekday !== undefined &&
    (!Array.isArray(byWeekday) || !byWeekday.every((day): day is number => typeof day === 'number'))
  ) {
    throw new InvalidObjectStateError(
      'objects_view.recurrence_rule column has an invalid "byWeekday"',
    );
  }

  if (endDate !== undefined && typeof endDate !== 'string') {
    throw new InvalidObjectStateError(
      'objects_view.recurrence_rule column has an invalid "endDate"',
    );
  }

  return {
    frequency,
    interval,
    ...(byWeekday !== undefined ? { byWeekday } : {}),
    ...(endDate !== undefined ? { endDate } : {}),
  };
}

/**
 * `objects_view` read-model projection (ADR-0003 "Okuma modeli ve
 * projeksiyon tazeliği"): maps a Lumina Object's `id` (ULID) to its event
 * stream's `streamId` (UUID) and mirrors its current, derived state
 * (`title`/`lifecycle`/timestamps) for cheap reads.
 *
 * F1-T10 PR6a: `checklist`/`recurrenceRule` are also mirrored here, folded
 * from `ChecklistItemAdded/Toggled/Removed/Reordered` and
 * `RecurrenceRuleSet/Cleared` events using the EXACT SAME fold semantics
 * `packages/core-objects/src/replay.ts`'s own `applyEvent` switch already
 * implements for these six event types -- mirrored deliberately so the
 * projection (used by every read path) and the pure domain replay (used by
 * every write path's own command decisions) never diverge. Unlike
 * `FieldValueChanged`'s single-key `jsonb_set`, the four checklist events
 * need a read-modify-write: a single-key `jsonb_set` cannot insert/remove/
 * resequence array items in one SQL expression.
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
    'ChecklistItemAdded',
    'ChecklistItemToggled',
    'ChecklistItemRemoved',
    'ChecklistItemReordered',
    'RecurrenceRuleSet',
    'RecurrenceRuleCleared',
  ];

  /**
   * Reads and parses this object's CURRENT `checklist` column value, inside
   * the SAME transaction (`dbTx`) the caller's own subsequent `UPDATE` runs
   * in -- extracted only to avoid duplicating this select+parse across the
   * four checklist event cases.
   */
  private async loadChecklist(dbTx: DbTransaction, objectId: string): Promise<ChecklistItem[]> {
    const [row] = await dbTx
      .select({ checklist: objectsView.checklist })
      .from(objectsView)
      .where(eq(objectsView.id, objectId))
      .limit(1);

    if (!row) {
      throw new InvalidObjectStateError(
        `objects_view row not found for object "${objectId}" while folding a checklist event`,
      );
    }

    return parseChecklistColumn(row.checklist);
  }

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

        await dbTx.insert(objectsView).values({
          id: objectId,
          streamId: event.streamId,
          type: objectType,
          workspaceId: event.workspaceId,
          title,
          createdBy: event.actor.id,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
          lifecycle: 'active',
        });
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
      case 'ChecklistItemAdded': {
        const objectId = requireStringPayloadField(event, 'objectId');
        const itemId = requireStringPayloadField(event, 'itemId');
        const text = requireStringPayloadField(event, 'text');
        const order = requireNumberPayloadField(event, 'order');

        const current = await this.loadChecklist(dbTx, objectId);

        // Idempotency guard (security-reviewer finding, F1-T10 PR6a): unlike
        // `ChecklistItemToggled`/`Removed`/`Reordered` below -- each of which
        // folds an ABSOLUTE end state from the event payload, so reapplying
        // the SAME event twice is naturally a no-op -- a naive append here
        // would push a duplicate entry if this event is ever folded twice
        // (e.g. two overlapping `ProjectionRunner.catchUp` runs racing on the
        // same object). Skipping when `itemId` already exists makes this
        // case idempotent too, matching every other case's reapply-safety.
        const next: ChecklistItem[] = current.some((item) => item.id === itemId)
          ? current
          : [...current, { id: itemId, text, done: false, order }];

        // SECURITY: the entire folded array is passed as ONE bound `sql`
        // parameter (JSON-serialized, cast to `jsonb` server-side) -- never
        // string-concatenated into the SQL text itself, same discipline as
        // `FieldValueChanged`'s own case above.
        await dbTx
          .update(objectsView)
          .set({
            checklist: sql`${JSON.stringify(next)}::jsonb`,
            updatedAt: event.occurredAt,
          })
          .where(eq(objectsView.id, objectId));
        return;
      }
      case 'ChecklistItemToggled': {
        const objectId = requireStringPayloadField(event, 'objectId');
        const itemId = requireStringPayloadField(event, 'itemId');
        const done = requireBooleanPayloadField(event, 'done');

        const current = await this.loadChecklist(dbTx, objectId);
        const next: ChecklistItem[] = current.map((item) =>
          item.id === itemId ? { ...item, done } : item,
        );

        await dbTx
          .update(objectsView)
          .set({
            checklist: sql`${JSON.stringify(next)}::jsonb`,
            updatedAt: event.occurredAt,
          })
          .where(eq(objectsView.id, objectId));
        return;
      }
      case 'ChecklistItemRemoved': {
        const objectId = requireStringPayloadField(event, 'objectId');
        const itemId = requireStringPayloadField(event, 'itemId');

        const current = await this.loadChecklist(dbTx, objectId);
        const next: ChecklistItem[] = current.filter((item) => item.id !== itemId);

        await dbTx
          .update(objectsView)
          .set({
            checklist: sql`${JSON.stringify(next)}::jsonb`,
            updatedAt: event.occurredAt,
          })
          .where(eq(objectsView.id, objectId));
        return;
      }
      case 'ChecklistItemReordered': {
        const objectId = requireStringPayloadField(event, 'objectId');
        const orderedItemIds = requireStringArrayPayloadField(event, 'orderedItemIds');

        const current = await this.loadChecklist(dbTx, objectId);
        const itemsById = new Map(current.map((item) => [item.id, item]));

        const next: ChecklistItem[] = orderedItemIds.map((itemId, index) => {
          const item = itemsById.get(itemId);

          if (!item) {
            throw new InvalidObjectStateError(
              '"ChecklistItemReordered" event references an unknown itemId',
            );
          }

          return { ...item, order: index };
        });

        await dbTx
          .update(objectsView)
          .set({
            checklist: sql`${JSON.stringify(next)}::jsonb`,
            updatedAt: event.occurredAt,
          })
          .where(eq(objectsView.id, objectId));
        return;
      }
      case 'RecurrenceRuleSet': {
        const objectId = requireStringPayloadField(event, 'objectId');
        const recurrenceRule = parseRecurrenceRulePayload(event);

        // SECURITY: same bound-parameter discipline as the checklist cases
        // above -- the parsed, validated rule is JSON-serialized and passed
        // as ONE bound `sql` parameter, never string-concatenated.
        await dbTx
          .update(objectsView)
          .set({
            recurrenceRule: sql`${JSON.stringify(recurrenceRule)}::jsonb`,
            updatedAt: event.occurredAt,
          })
          .where(eq(objectsView.id, objectId));
        return;
      }
      case 'RecurrenceRuleCleared': {
        const objectId = requireStringPayloadField(event, 'objectId');

        await dbTx
          .update(objectsView)
          .set({ recurrenceRule: null, updatedAt: event.occurredAt })
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
