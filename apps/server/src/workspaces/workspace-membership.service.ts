import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { memberships } from '../db/schema/memberships.js';

import type { Database } from '../db/client.js';

// Matches the shape Drizzle's own `uuid()` column type / Postgres's `uuid`
// type expect (any of the RFC 4122 versions, case-insensitive). Guards run
// *before* Nest's parameter pipes (so a `ParseUUIDPipe` on the controller
// param runs too late to protect this guard's own query), so this same
// check is duplicated here as the first line of defense: a malformed
// `workspaceId` must never reach the database query below, where `pg`
// would reject it with a raw driver exception instead of a clean `AppError`.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * HTTP-context-free membership check, extracted from
 * `WorkspaceMembershipGuard` so it can be reused outside an Express request
 * cycle (e.g. WebSocket connection authorization).
 *
 * Resolves `workspaceId` + `userId` against the `(workspaceId, userId)`
 * composite unique index on `memberships`. No matching row means the caller
 * is authenticated but not a member of this workspace, which is a 403 (not a
 * 401 — "who you are" and "what you can access" are different failure modes,
 * per `session-auth.guard.ts`'s own comment on the same distinction).
 */
@Injectable()
export class WorkspaceMembershipService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async assertMembership(
    userId: string,
    workspaceId: string,
  ): Promise<{ workspaceId: string; role: string }> {
    // No `req.user` means `SessionAuthGuard` didn't run (misconfiguration)
    // or somehow let an unauthenticated request through — fail closed as
    // "unauthenticated" rather than silently treating it as "not a member".
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedError();
    }

    // A malformed value (not a well-formed UUID) can never match a real
    // workspace, so it's treated identically to "not a member" (403) rather
    // than let it reach the query below, where `pg` would raise a raw
    // driver exception instead of a clean `AppError`.
    if (typeof workspaceId !== 'string' || !UUID_PATTERN.test(workspaceId)) {
      throw new ForbiddenError();
    }

    const [membership] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
      .limit(1);

    if (!membership) {
      throw new ForbiddenError();
    }

    return { workspaceId, role: membership.role };
  }
}
