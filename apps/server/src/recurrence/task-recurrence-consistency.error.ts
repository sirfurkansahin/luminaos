import { AppError } from '@luminaos/shared';

/**
 * Signals a fatal, "this must never happen" invariant violation inside
 * `TaskRecurrenceService.generateNextOccurrence`: `EventStoreService.append`
 * is expected to always return at least one stored event for the batch it
 * was given (either the freshly-inserted rows, or the previously-stored rows
 * on an idempotent replay -- see `EventStoreService.append`'s own doc
 * comment). An empty result would mean that guarantee itself broke, which
 * this service has no recovery path for. Mirrors
 * `../event-store/event-store-consistency.error.ts`'s own "internal
 * invariant guard, 500 not 4xx" pattern.
 */
export class TaskRecurrenceConsistencyError extends AppError {
  constructor(message: string) {
    super(message, 'TASK_RECURRENCE_CONSISTENCY', 500);
  }
}
