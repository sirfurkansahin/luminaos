import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';

import type { MemoryRecord } from '@luminaos/memory';
import { AppError, NotFoundError } from '@luminaos/shared';
import type { NewDomainEvent } from '@luminaos/shared';

import { MemoryRecordProjection } from './memory-record.projection.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { memoryRecords } from '../db/schema/memory-records.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

const MEMORY_RECORD_STREAM_TYPE = 'memory-record';

/**
 * Signals a database invariant violation (a write that should have produced
 * a readable row not actually being readable back) rather than a normal
 * request-lifecycle failure. Mirrors `DesktopSignalConsentsService`'s
 * `UnexpectedQueryResultError` pattern — MUST NOT be a `NotFoundError`
 * (404), since the record was just written and its absence is a server bug,
 * not a missing resource.
 */
class UnexpectedQueryResultError extends AppError {
  constructor(message: string) {
    super(message, 'UNEXPECTED_QUERY_RESULT', 500);
  }
}

type MemoryRecordRow = typeof memoryRecords.$inferSelect;

function toMemoryRecord(row: MemoryRecordRow): MemoryRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    content: row.content,
    kaynakOlayId: row.kaynakOlayId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * F2-T5 PR2 (ADR-0022 Karar c/f): `MemoryRecordsService`, an event-sourced,
 * self-service CRUD surface over per-record Memory Passport streams.
 *
 * `streamId` is a per-record `randomUUID()`, NOT a deterministic derivation
 * (Karar c, a deliberate divergence from `DesktopSignalConsentsService`'s
 * triple-keyed `deriveDeterministicUuid` — there is no natural-key
 * uniqueness constraint on a memory record). Every read (`list`, and the
 * existence/ownership check inside `edit`/`delete`) is scoped by BOTH
 * `workspaceId` AND `userId` (Karar f) AND filters `deletedAt IS NULL`
 * (Karar d) — a record belonging to a different user/workspace, or already
 * tombstoned, is treated as NOT FOUND, never a permission error.
 */
@Injectable()
export class MemoryRecordsService {
  private readonly projection = new MemoryRecordProjection();

  constructor(
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
  ) {}

  async list(workspaceId: string, userId: string): Promise<MemoryRecord[]> {
    const rows = await this.db
      .select()
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.workspaceId, workspaceId),
          eq(memoryRecords.userId, userId),
          isNull(memoryRecords.deletedAt),
        ),
      )
      .orderBy(asc(memoryRecords.createdAt));

    return rows.map(toMemoryRecord);
  }

  async create(workspaceId: string, userId: string, content: string): Promise<MemoryRecord> {
    const streamId = randomUUID();

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: MEMORY_RECORD_STREAM_TYPE,
      workspaceId,
      type: 'MemoryRecordAdded',
      payload: { content },
      actor: { type: 'user', id: userId },
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, 0, [event]);
    await this.projectionRunner.catchUp(this.projection);

    const record = await this.findByStreamId(streamId);

    if (!record) {
      throw new UnexpectedQueryResultError(
        'Failed to read back memory record immediately after creating it.',
      );
    }

    return record;
  }

  async edit(
    workspaceId: string,
    userId: string,
    recordId: string,
    content: string,
  ): Promise<MemoryRecord> {
    const existing = await this.findOwnedRow(workspaceId, userId, recordId);

    if (!existing) {
      throw new NotFoundError('Memory record not found.');
    }

    const priorEvents = await this.eventStore.readStream(existing.streamId);

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: MEMORY_RECORD_STREAM_TYPE,
      workspaceId,
      type: 'MemoryRecordEdited',
      payload: { content },
      actor: { type: 'user', id: userId },
      occurredAt: new Date(),
    };

    await this.eventStore.append(existing.streamId, priorEvents.length, [event]);
    await this.projectionRunner.catchUp(this.projection);

    const record = await this.findByStreamId(existing.streamId);

    if (!record) {
      throw new UnexpectedQueryResultError(
        'Failed to read back memory record immediately after editing it.',
      );
    }

    return record;
  }

  async delete(workspaceId: string, userId: string, recordId: string): Promise<void> {
    const existing = await this.findOwnedRow(workspaceId, userId, recordId);

    if (!existing) {
      throw new NotFoundError('Memory record not found.');
    }

    const priorEvents = await this.eventStore.readStream(existing.streamId);

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: MEMORY_RECORD_STREAM_TYPE,
      workspaceId,
      type: 'MemoryRecordDeleted',
      payload: {},
      actor: { type: 'user', id: userId },
      occurredAt: new Date(),
    };

    await this.eventStore.append(existing.streamId, priorEvents.length, [event]);
    await this.projectionRunner.catchUp(this.projection);
  }

  private async findOwnedRow(
    workspaceId: string,
    userId: string,
    recordId: string,
  ): Promise<MemoryRecordRow | null> {
    const [row] = await this.db
      .select()
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.workspaceId, workspaceId),
          eq(memoryRecords.userId, userId),
          eq(memoryRecords.id, recordId),
          isNull(memoryRecords.deletedAt),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  private async findByStreamId(streamId: string): Promise<MemoryRecord | null> {
    const [row] = await this.db
      .select()
      .from(memoryRecords)
      .where(eq(memoryRecords.streamId, streamId))
      .limit(1);

    return row ? toMemoryRecord(row) : null;
  }
}
