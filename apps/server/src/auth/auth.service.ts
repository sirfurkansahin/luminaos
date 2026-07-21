import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { ConflictError, UnauthorizedError } from '@luminaos/shared';

import { hashPassword, verifyPassword } from './password.js';
import { SessionService } from './session.service.js';
import { hasPostgresErrorCode } from '../common/postgres-error.js';
import { DATABASE_CONNECTION } from '../db/db.module.js';
import { users } from '../db/schema/users.js';

import type { Database } from '../db/client.js';

/** Postgres error code for a unique-constraint violation. */
const POSTGRES_UNIQUE_VIOLATION = '23505';

export interface AuthResultUser {
  id: string;
  email: string;
}

export interface AuthResult {
  user: AuthResultUser;
  sessionId: string;
}

// A fixed, valid-looking argon2id hash of an arbitrary, never-used plaintext.
// It never matches any real user's password. `login` verifies against this
// dummy hash when no user row is found, so the "unknown email" branch pays
// the same argon2 cost as the "wrong password" branch — closing a timing
// side-channel that would otherwise let an attacker enumerate registered
// emails via response latency (a fast "no such row" vs. a slow "verify
// failed" reply).
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$2Y3ntsyOOMe6HGqRcvSSfw$m0/CzTPjs2SFhhKtWv7uAmWtIhpnr56TeLtDDBOu6vc';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly sessionService: SessionService,
  ) {}

  async register(email: string, password: string): Promise<AuthResult> {
    const passwordHash = await hashPassword(password);

    let inserted: { id: string; email: string };
    try {
      const [row] = await this.db
        .insert(users)
        .values({ email, passwordHash })
        .returning({ id: users.id, email: users.email });

      if (!row) {
        throw new ConflictError('Failed to register: insert returned no row.');
      }

      inserted = row;
    } catch (error) {
      if (hasPostgresErrorCode(error, POSTGRES_UNIQUE_VIOLATION)) {
        throw new ConflictError('An account with this email already exists.');
      }
      throw error;
    }

    const session = await this.sessionService.createSession(inserted.id);

    return { user: inserted, sessionId: session.id };
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const [row] = await this.db
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Deliberately the same error, whether the email is unknown or the
    // password is wrong — no user-enumeration signal via status/message
    // *or* timing: when there's no row, we still run `verifyPassword`
    // against a fixed dummy hash so both branches pay the same argon2 cost
    // before either one throws.
    if (!row) {
      await verifyPassword(DUMMY_PASSWORD_HASH, password);
      throw new UnauthorizedError('Invalid email or password.');
    }

    const passwordMatches = await verifyPassword(row.passwordHash, password);

    if (!passwordMatches) {
      throw new UnauthorizedError('Invalid email or password.');
    }

    const session = await this.sessionService.createSession(row.id);

    return { user: { id: row.id, email: row.email }, sessionId: session.id };
  }

  async logout(sessionId: string): Promise<void> {
    // Idempotent: revoking an already-revoked/nonexistent session is a
    // no-op, not an error — callers never need to check "was there even a
    // session" before calling this.
    await this.sessionService.revokeSession(sessionId);
  }

  async refresh(sessionId: string): Promise<AuthResult> {
    const activeSession = await this.sessionService.getActiveSession(sessionId);

    if (!activeSession) {
      throw new UnauthorizedError();
    }

    const user = await this.sessionService.findUserById(activeSession.userId);

    if (!user) {
      throw new UnauthorizedError();
    }

    // Rotation, not sliding expiration: the old session is revoked and a
    // brand new one is issued.
    await this.sessionService.revokeSession(sessionId);
    const newSession = await this.sessionService.createSession(user.id);

    return { user: { id: user.id, email: user.email }, sessionId: newSession.id };
  }
}
