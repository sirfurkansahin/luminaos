import { AppError } from '@luminaos/shared';

/**
 * Signals a fatal, "this must never happen" invariant violation inside
 * `EventStoreService.append`'s insert step — e.g. a batch of N new events
 * where the `INSERT ... ON CONFLICT (id) DO NOTHING` returns a row count
 * strictly between 0 and N. Zero rows means the whole batch was already
 * persisted (a legitimate idempotent-replay no-op, handled separately); N
 * rows means every event in the batch was newly inserted (the normal case).
 * Anything in between means only *some* of the batch's ids collided with
 * pre-existing rows — a partial-batch id collision within a single `append`
 * call that the optimistic-concurrency + idempotency design assumes can
 * never occur. A 500, not a 4xx, mirroring `MigrationIntegrityError`'s and
 * `WorkspaceInconsistencyError`'s "internal invariant guard" pattern: this
 * is not a normal request-lifecycle failure a caller can recover from by
 * retrying with different input.
 */
export class EventStoreConsistencyError extends AppError {
  constructor(message: string) {
    super(message, 'EVENT_STORE_CONSISTENCY', 500);
  }
}
