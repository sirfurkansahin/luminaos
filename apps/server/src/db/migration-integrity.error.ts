import { AppError } from '@luminaos/shared';

/**
 * Signals a fatal inconsistency in the migration setup itself — a missing
 * hand-authored down script, or an applied migration with no matching
 * `_journal.json` entry — rather than a normal request-lifecycle failure.
 * Used in place of a bare `throw new Error(...)` (forbidden by CLAUDE.md)
 * in `migrate.ts`/`migrate-down.ts`, mirroring `session.service.ts`'s
 * `UnexpectedQueryResultError` pattern for this same kind of
 * internal-invariant failure.
 */
export class MigrationIntegrityError extends AppError {
  constructor(message: string) {
    super(message, 'MIGRATION_INTEGRITY_ERROR', 500);
  }
}
