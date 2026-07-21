import { AppError } from '@luminaos/shared';

/**
 * Thrown when `WorkspaceMembershipGuard` has already proven a membership row
 * exists for a workspace, yet the workspace record itself is missing (e.g. a
 * race with a concurrent delete). This should never happen given the
 * `memberships.workspace_id` foreign key, so it's surfaced as a 500 rather
 * than silently treated as a 404/undefined — per `CLAUDE.md`, every thrown
 * error in this codebase must be an `AppError` subclass, never a bare
 * `throw new Error(...)`.
 */
export class WorkspaceInconsistencyError extends AppError {
  constructor(message = 'Workspace membership exists but workspace record is missing.') {
    super(message, 'WORKSPACE_INCONSISTENCY', 500);
  }
}
