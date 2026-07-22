import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';

import { ValidationError, VersionConflictError, newDomainEventSchema } from '@luminaos/shared';
import type { Actor, DomainEvent, NewDomainEvent } from '@luminaos/shared';

import { EventStoreConsistencyError } from './event-store-consistency.error.js';
import { hasPostgresConstraintViolation } from '../common/postgres-error.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { events } from '../db/schema/events.js';

import type { Database } from '../db/client.js';

/** The Postgres constraint name enforcing the event store's optimistic-concurrency invariant. */
const STREAM_VERSION_CONSTRAINT = 'events_stream_id_version_key';

type EventRow = typeof events.$inferSelect;

/** The transaction handle `Database['transaction']`'s callback receives. */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * A stored, persisted event: the portable `DomainEvent` envelope plus
 * `globalPosition`, the cross-stream total ordering assigned by the `events`
 * table's identity column. `globalPosition` deliberately does **not** live on
 * `DomainEvent` itself (`packages/shared`) — it's event-store storage
 * metadata, not part of the portable envelope a stream's consumers reason
 * about.
 */
export type StoredEvent = DomainEvent & { globalPosition: number };

function toStoredEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    streamId: row.streamId,
    streamType: row.streamType,
    workspaceId: row.workspaceId,
    type: row.type,
    version: row.version,
    payload: row.payload as Record<string, unknown>,
    actor: row.actor as Actor,
    occurredAt: row.occurredAt,
    globalPosition: row.globalPosition,
  };
}

/**
 * The append-only event log's read/write surface. See F0-T6's plan
 * (`giggly-brewing-moore.md`) for the full design rationale behind the
 * `append` algorithm below.
 */
@Injectable()
export class EventStoreService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Appends a batch of new events to `streamId`, assigning them sequential
   * versions starting at `expectedVersion + 1`.
   *
   * Optimistic concurrency: `expectedVersion` must match the stream's actual
   * current version (the highest `version` already recorded, or `0` for an
   * empty stream). If it doesn't, this is either:
   * - an idempotent replay (the exact same batch, by event id, was already
   *   recorded at the versions it would have gotten) — a no-op that returns
   *   the previously stored events, or
   * - a genuine conflict — throws `VersionConflictError`.
   *
   * The insert itself uses `INSERT ... ON CONFLICT (id) DO NOTHING`, so a
   * duplicate `id` within the same expected-version window is also a no-op
   * rather than an error. A `23505` on `events_stream_id_version_key` can
   * still escape the transaction (the concurrent-writer race) and is
   * translated into `VersionConflictError` here.
   */
  async append(
    streamId: string,
    expectedVersion: number,
    newEvents: NewDomainEvent[],
  ): Promise<StoredEvent[]> {
    const parsedEvents = newEvents.map((newEvent) => {
      const result = newDomainEventSchema.safeParse(newEvent);
      if (!result.success) {
        throw new ValidationError('Invalid new event.', result.error.issues);
      }
      return result.data;
    });

    try {
      return await this.db.transaction(async (tx) => {
        const [headRow] = await tx
          .select({ head: sql<number>`COALESCE(MAX(${events.version}), 0)` })
          .from(events)
          .where(eq(events.streamId, streamId));

        const currentVersion = headRow?.head ?? 0;

        if (currentVersion !== expectedVersion) {
          const replay = await this.tryLoadIdempotentReplay(
            tx,
            streamId,
            expectedVersion,
            parsedEvents,
          );

          if (replay) {
            return replay;
          }

          throw new VersionConflictError(streamId, expectedVersion, currentVersion);
        }

        const rowsToInsert = parsedEvents.map((newEvent, index) => ({
          id: newEvent.id,
          streamId,
          streamType: newEvent.streamType,
          workspaceId: newEvent.workspaceId,
          type: newEvent.type,
          version: expectedVersion + index + 1,
          payload: newEvent.payload,
          actor: newEvent.actor,
          occurredAt: newEvent.occurredAt,
        }));

        const inserted = await tx
          .insert(events)
          .values(rowsToInsert)
          .onConflictDoNothing({ target: events.id })
          .returning();

        if (inserted.length === 0) {
          // The whole batch's ids conflicted, so nothing was inserted. This
          // is only a safe no-op if every event in the batch genuinely
          // already exists in THIS stream at the exact version it would
          // have been assigned (a legitimate idempotent retry). `events.id`
          // is a GLOBAL primary key, not scoped to `streamId`, so a bare
          // reload-by-id here would miss ids that collided with a row under
          // a *different* stream and silently resolve as if the write had
          // succeeded. Reuse the same id+version alignment check
          // `tryLoadIdempotentReplay` uses for the racing-version path.
          const replay = await this.tryLoadIdempotentReplay(
            tx,
            streamId,
            expectedVersion,
            parsedEvents,
          );

          if (replay) {
            return replay;
          }

          throw new EventStoreConsistencyError(
            `Id collision appending to stream "${streamId}": one or more event ids already exist and do not match a valid replay of this stream at expected version ${String(expectedVersion)}. Colliding id(s): ${parsedEvents.map((newEvent) => newEvent.id).join(', ')}.`,
          );
        }

        if (inserted.length !== rowsToInsert.length) {
          // Some, but not all, of this batch's ids already existed — a
          // partial-batch id collision within a single `append` call. The
          // optimistic-concurrency + idempotency design assumes this never
          // happens; surfacing it as a normal conflict would hide a bug.
          throw new EventStoreConsistencyError(
            `Partial id collision appending to stream "${streamId}": expected to insert ${String(rowsToInsert.length)} event(s), but only ${String(inserted.length)} row(s) were inserted.`,
          );
        }

        return inserted.map(toStoredEvent).sort((a, b) => a.version - b.version);
      });
    } catch (error) {
      if (hasPostgresConstraintViolation(error, STREAM_VERSION_CONSTRAINT)) {
        throw new VersionConflictError(streamId, expectedVersion);
      }
      throw error;
    }
  }

  async readStream(streamId: string): Promise<StoredEvent[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(eq(events.streamId, streamId))
      .orderBy(asc(events.version));

    return rows.map(toStoredEvent);
  }

  async readByWorkspace(workspaceId: string, fromPosition: number): Promise<StoredEvent[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, workspaceId), gt(events.globalPosition, fromPosition)))
      .orderBy(asc(events.globalPosition));

    return rows.map(toStoredEvent);
  }

  /**
   * Cross-workspace, `globalPosition`-ordered read, with an exclusive cursor
   * like `readByWorkspace`. Internal helper for `ProjectionRunner`'s catch-up
   * loop: a projection whose `handles` includes `'*'` (e.g. the example
   * `workspace-event-counter` projection) is deliberately workspace-agnostic
   * and must replay the *entire* log, not one workspace's slice of it. Not
   * part of the three public read/write methods the F0-T6 plan names for the
   * store itself (`append`/`readStream`/`readByWorkspace`) — this exists
   * purely to support the projection runner.
   */
  async readAllFrom(fromPosition: number, limit?: number): Promise<StoredEvent[]> {
    const query = this.db
      .select()
      .from(events)
      .where(gt(events.globalPosition, fromPosition))
      .orderBy(asc(events.globalPosition));

    const rows = limit === undefined ? await query : await query.limit(limit);

    return rows.map(toStoredEvent);
  }

  private async loadByIds(tx: DbTransaction, streamId: string, ids: string[]): Promise<EventRow[]> {
    return tx
      .select()
      .from(events)
      .where(and(eq(events.streamId, streamId), inArray(events.id, ids)))
      .orderBy(asc(events.version));
  }

  /**
   * Checks whether `parsedEvents` (as a batch appended at `expectedVersion`)
   * was already recorded, position-for-position: the event at index `i`
   * must already exist in the store with the same `id`, at exactly the
   * version it would have been assigned (`expectedVersion + i + 1`). If
   * every event in the batch matches this way, the append is a safe no-op
   * replay. Any mismatch (missing event, different id at that version, etc.)
   * means this is a genuine conflict, not a replay.
   */
  private async tryLoadIdempotentReplay(
    tx: DbTransaction,
    streamId: string,
    expectedVersion: number,
    parsedEvents: NewDomainEvent[],
  ): Promise<StoredEvent[] | null> {
    const existing = await this.loadByIds(
      tx,
      streamId,
      parsedEvents.map((newEvent) => newEvent.id),
    );

    const existingById = new Map(existing.map((row) => [row.id, row]));

    const matchedRows: EventRow[] = [];

    for (const [index, newEvent] of parsedEvents.entries()) {
      const expectedVersionForRow = expectedVersion + index + 1;
      const existingRow = existingById.get(newEvent.id);

      if (!existingRow || existingRow.version !== expectedVersionForRow) {
        return null;
      }

      matchedRows.push(existingRow);
    }

    return matchedRows.map(toStoredEvent);
  }
}
