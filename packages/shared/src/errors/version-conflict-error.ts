import { AppError } from './app-error.js';

/**
 * Thrown by `EventStoreService.append()` (see F0-T6's plan,
 * `giggly-brewing-moore.md` §2) when a caller's `expectedVersion` no longer
 * matches a stream's actual current version — the optimistic-concurrency
 * conflict at the heart of the event store's `append` algorithm. A 409, not
 * a 5xx: this is an expected, recoverable outcome of a race between two
 * writers, not an internal invariant violation.
 */
export class VersionConflictError extends AppError {
  public readonly streamId: string;
  public readonly expectedVersion: number;
  public readonly actualVersion: number | undefined;

  constructor(streamId: string, expectedVersion: number, actualVersion?: number) {
    const actualVersionSuffix =
      actualVersion === undefined
        ? ''
        : `, but the stream is actually at version ${String(actualVersion)}`;
    const message = `Version conflict on stream "${streamId}": expected version ${String(expectedVersion)}${actualVersionSuffix}.`;

    super(message, 'VERSION_CONFLICT', 409);

    this.streamId = streamId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}
