import { eq } from 'drizzle-orm';
import { uuidToULID } from 'ulid';

import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { memoryRecords } from '../db/schema/memory-records.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `DesktopSignalConsentProjection`'s own `asDbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

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
 * `memory_records` read-model projection (F2-T5 PR2, ADR-0022 Karar b/d/e):
 *
 * - `MemoryRecordAdded` derives the row-level `id` (ULID) DETERMINISTICALLY
 *   from the event's own (immutable, already-stored) `id` via `uuidToULID`
 *   — the event payload is `.strict()` `{content}` only, there is no room to
 *   smuggle an app-minted id back through it, and a randomly-minted id
 *   (`newObjectId()`, `DesktopSignalConsentProjection`'s own precedent)
 *   would NOT be reproducible on `projectionRunner.rebuild` (F0-T6 AC4
 *   requires a rebuild to reproduce the exact same state, including `id`,
 *   from the same event log — a fresh random id on every replay breaks
 *   that). `kaynakOlayId` is the event's OWN `id` too (self-reference, Karar
 *   b) — `id` and `kaynakOlayId` are therefore always a deterministic,
 *   1:1-derived pair in v1, never independently random. `deletedAt` starts
 *   `null`.
 * - `MemoryRecordEdited` fully replaces `content` (no merge/patch, Karar e)
 *   and bumps `updatedAt`, matching the row via `event.streamId` (the only
 *   stable identifier shared across a record's lifecycle events, per
 *   `objects_view.stream_id`'s exact precedent).
 * - `MemoryRecordDeleted` sets `deletedAt = event.occurredAt` on the matching
 *   row — the row is NEVER physically `DELETE`d (Karar d, the tombstone
 *   contract every read query relies on via a `deletedAt IS NULL` filter).
 */
export class MemoryRecordProjection implements Projection {
  readonly name = 'memory-record';
  readonly handles: readonly string[] = [
    'MemoryRecordAdded',
    'MemoryRecordEdited',
    'MemoryRecordDeleted',
  ];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    switch (event.type) {
      case 'MemoryRecordAdded': {
        const content = requireStringPayloadField(event, 'content');

        await dbTx.insert(memoryRecords).values({
          id: uuidToULID(event.id),
          streamId: event.streamId,
          workspaceId: event.workspaceId,
          userId: event.actor.id,
          content,
          kaynakOlayId: event.id,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
          deletedAt: null,
        });
        return;
      }
      case 'MemoryRecordEdited': {
        const content = requireStringPayloadField(event, 'content');

        await dbTx
          .update(memoryRecords)
          .set({ content, updatedAt: event.occurredAt })
          .where(eq(memoryRecords.streamId, event.streamId));
        return;
      }
      case 'MemoryRecordDeleted': {
        await dbTx
          .update(memoryRecords)
          .set({ deletedAt: event.occurredAt })
          .where(eq(memoryRecords.streamId, event.streamId));
        return;
      }
      default:
        return;
    }
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(memoryRecords);
  }
}
