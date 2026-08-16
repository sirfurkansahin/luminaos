import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';

import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { memberships } from '../db/schema/memberships.js';
import { workspaces } from '../db/schema/workspaces.js';

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

  /**
   * Bulk membership check: throws `ForbiddenError` unless every entry in
   * `userIds` is a member of `workspaceId`. Used to validate, e.g., every
   * person a command proposes assigning is actually a member of the
   * workspace before writing a `people`-typed field value.
   */
  async assertAllMembers(workspaceId: string, userIds: string[]): Promise<void> {
    // Same "malformed value can never match a real workspace" guard as
    // `assertMembership` — see this class's top-of-file comment.
    if (typeof workspaceId !== 'string' || !UUID_PATTERN.test(workspaceId)) {
      throw new ForbiddenError();
    }

    const uniqueUserIds = new Set(userIds);
    if (uniqueUserIds.size === 0) {
      return;
    }

    const rows = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          inArray(memberships.userId, [...uniqueUserIds]),
        ),
      );

    const foundUserIds = new Set(rows.map((row) => row.userId));
    for (const userId of uniqueUserIds) {
      if (!foundUserIds.has(userId)) {
        throw new ForbiddenError();
      }
    }
  }

  /**
   * Lists every workspace `userId` is a member of (possibly empty), as a
   * bare `{id, name}` summary — used by `GET /me` (F2-T3b) so `apps/desktop`
   * can auto-select a workspace for a single-workspace user or show a
   * picker for a multi-workspace one, without a separate `GET /workspaces`
   * endpoint (Open Question 1, Option B in
   * `docs/specs/F2-E1/F2-T3b-desktop-login-session.md`).
   */
  async listWorkspacesForUser(userId: string): Promise<{ id: string; name: string }[]> {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedError();
    }

    return this.db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(memberships)
      .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
      .where(eq(memberships.userId, userId));
  }
}
