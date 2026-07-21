import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';

import { AppError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/db.module.js';
import { sessions } from '../db/schema/sessions.js';
import { users } from '../db/schema/users.js';

import type { Database } from '../db/client.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Signals a database invariant violation (e.g. an `INSERT ... RETURNING`
 * that unexpectedly produced no row) rather than a normal request-lifecycle
 * failure. Not exported — this should never actually be observable from the
 * outside; it exists purely so we never need a bare `throw new Error(...)`
 * (forbidden by CLAUDE.md) to satisfy TypeScript's `noUncheckedIndexedAccess`
 * narrowing.
 */
class UnexpectedQueryResultError extends AppError {
  constructor(message: string) {
    super(message, 'UNEXPECTED_QUERY_RESULT', 500);
  }
}

export interface ActiveSession {
  userId: string;
}

export interface SessionUser {
  id: string;
  email: string;
  createdAt: Date;
}

/**
 * Wraps session CRUD against the `sessions` table. Sessions are rotated
 * (not slid): a new session row is created on login/register/refresh and
 * revoked (soft-deleted via `revokedAt`) on logout/refresh-of-the-old-one,
 * rather than pushing `expiresAt` forward on every request.
 */
@Injectable()
export class SessionService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    const [row] = await this.db
      .insert(sessions)
      .values({ userId, expiresAt })
      .returning({ id: sessions.id, expiresAt: sessions.expiresAt });

    if (!row) {
      throw new UnexpectedQueryResultError('Failed to create session: insert returned no row.');
    }

    return row;
  }

  async getActiveSession(sessionId: string): Promise<ActiveSession | null> {
    const [row] = await this.db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, sessionId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  /**
   * Small user lookup used by `SessionAuthGuard`/`GET /me` to resolve the
   * full user record (id/email/createdAt) once a session has already been
   * validated as active.
   */
  async findUserById(userId: string): Promise<SessionUser | null> {
    const [row] = await this.db
      .select({ id: users.id, email: users.email, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return row ?? null;
  }
}
