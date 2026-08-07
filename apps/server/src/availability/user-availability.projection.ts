import { InvalidObjectStateError } from '@luminaos/shared';
import type { DomainEvent, Projection, ProjectionTx } from '@luminaos/shared';

import { userAvailability } from '../db/schema/user-availability.js';

import type { Database } from '../db/client.js';

/** The transaction handle `Database['transaction']`'s callback receives (mirrors `AIUsageProjection`'s own `asDbTransaction`). */
type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function asDbTransaction(tx: ProjectionTx): DbTransaction {
  return tx as unknown as DbTransaction;
}

const VALID_STATUSES = new Set(['available', 'focus', 'ooo']);

/**
 * `user_availability` read-model projection (F1-T12 PR6): unlike
 * `AIUsageProjection`'s append-only semantics, this is a LAST-WRITE-WINS
 * upsert keyed on `userId` — each `UserAvailabilityChanged` event replaces
 * the user's prior recorded status entirely (including clearing `until` when
 * the new event omits it).
 */
export class UserAvailabilityProjection implements Projection {
  readonly name = 'user-availability';
  readonly handles: readonly string[] = ['UserAvailabilityChanged'];

  async apply(event: DomainEvent, tx: ProjectionTx): Promise<void> {
    if (event.type !== 'UserAvailabilityChanged') {
      return;
    }

    const dbTx = asDbTransaction(tx);

    const userId = event.payload['userId'];
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new InvalidObjectStateError(
        `"${event.type}" event is missing a valid "userId" payload field`,
      );
    }

    const status = event.payload['status'];
    if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
      throw new InvalidObjectStateError(
        `"${event.type}" event has an invalid "status" payload field: ${JSON.stringify(status)}`,
      );
    }

    const untilRaw = event.payload['until'];
    if (untilRaw !== undefined && typeof untilRaw !== 'string') {
      throw new InvalidObjectStateError(
        `"${event.type}" event has an invalid "until" payload field`,
      );
    }

    const until = untilRaw !== undefined ? new Date(untilRaw) : null;

    await dbTx
      .insert(userAvailability)
      .values({ userId, status, until, updatedAt: event.occurredAt })
      .onConflictDoUpdate({
        target: userAvailability.userId,
        set: { status, until, updatedAt: event.occurredAt },
      });
  }

  async reset(tx: ProjectionTx): Promise<void> {
    const dbTx = asDbTransaction(tx);

    await dbTx.delete(userAvailability);
  }
}
