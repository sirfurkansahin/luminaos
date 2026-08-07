import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { AppError, deriveDeterministicUuid } from '@luminaos/shared';
import type { NewDomainEvent } from '@luminaos/shared';

import { UserAvailabilityProjection } from './user-availability.projection.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { userAvailability } from '../db/schema/user-availability.js';
import { EventStoreService } from '../event-store/event-store.service.js';
import { ProjectionRunner } from '../event-store/projections/projection-runner.service.js';

import type { Database } from '../db/client.js';

const USER_AVAILABILITY_STREAM_TYPE = 'user-availability';

/**
 * Fixed, arbitrary namespace UUID for deriving per-user availability
 * streamIds. MUST NEVER CHANGE once real data exists -- changing it silently
 * opens a new stream per user, losing continuity with any prior history.
 */
const USER_AVAILABILITY_UUID_NAMESPACE = '9c858b3e-6c1d-4c9a-9f0a-9a6c8b0c9e3a';

export type UserAvailabilityStatus = 'available' | 'focus' | 'ooo';

export interface UserAvailabilitySnapshot {
  status: UserAvailabilityStatus;
  until?: string;
  updatedAt: string;
}

/**
 * Signals a database invariant violation (an insert/upsert that should have
 * produced a readable row not actually being readable back) rather than a
 * normal request-lifecycle failure. Mirrors `session.service.ts`'s
 * `UnexpectedQueryResultError` pattern for "should never happen" cases.
 */
class UnexpectedQueryResultError extends AppError {
  constructor(message: string) {
    super(message, 'UNEXPECTED_QUERY_RESULT', 500);
  }
}

/**
 * F1-T12 PR6: `UserAvailability`, a NON-LuminaObject, event-sourced,
 * GLOBAL-PER-USER aggregate for Odak/OOO (Focus/Out-of-office) status, per
 * ADR-0012 §f. Its `streamId` is a DETERMINISTIC function of `userId` (RFC
 * 4122 UUIDv5, via `deriveDeterministicUuid`) rather than a per-call random
 * UUID (`recordAIUsage`'s pattern) — the same user's stream must be re-opened
 * (replay + append) every time they change status.
 */
@Injectable()
export class UserAvailabilityService {
  private readonly projection = new UserAvailabilityProjection();

  constructor(
    private readonly eventStore: EventStoreService,
    private readonly projectionRunner: ProjectionRunner,
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
  ) {}

  async setStatus(
    userId: string,
    workspaceId: string,
    status: UserAvailabilityStatus,
    until?: string,
  ): Promise<UserAvailabilitySnapshot> {
    const streamId = this.streamIdFor(userId);
    const priorEvents = await this.eventStore.readStream(streamId);

    const event: NewDomainEvent = {
      id: randomUUID(),
      streamType: USER_AVAILABILITY_STREAM_TYPE,
      workspaceId,
      type: 'UserAvailabilityChanged',
      payload: {
        userId,
        status,
        ...(until !== undefined ? { until } : {}),
      },
      actor: { type: 'user', id: userId },
      occurredAt: new Date(),
    };

    await this.eventStore.append(streamId, priorEvents.length, [event]);
    await this.projectionRunner.catchUp(this.projection);

    const current = await this.get(userId);

    if (!current) {
      throw new UnexpectedQueryResultError(
        'Failed to read back user availability immediately after writing it.',
      );
    }

    return current;
  }

  async get(userId: string): Promise<UserAvailabilitySnapshot | null> {
    const [row] = await this.db
      .select({
        status: userAvailability.status,
        until: userAvailability.until,
        updatedAt: userAvailability.updatedAt,
      })
      .from(userAvailability)
      .where(eq(userAvailability.userId, userId))
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      status: row.status as UserAvailabilityStatus,
      ...(row.until ? { until: row.until.toISOString() } : {}),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private streamIdFor(userId: string): string {
    return deriveDeterministicUuid(USER_AVAILABILITY_UUID_NAMESPACE, userId);
  }
}
