import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { ConflictError, NotFoundError } from '@luminaos/shared';

import { CalendarTokenEncryptionService } from './calendar-token-encryption.service.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { calendarAccounts } from '../db/schema/calendar-accounts.js';

import type { Database } from '../db/client.js';

/** How long a mock-OAuth-issued calendar account's access token is valid
 * for before it would need refreshing (out of this PR's scope — PR5b/PR5c). */
const MOCK_TOKEN_TTL_MS = 3_600_000;

export type CalendarProvider = 'google' | 'outlook';

export interface CalendarAccountSummary {
  id: string;
  provider: string;
  expiresAt: Date;
}

/**
 * F1-T12 PR5a: connect/list/disconnect calendar accounts via a mock OAuth
 * handshake, with tokens encrypted at rest. Never returns a token field
 * (encrypted or not) from any public method — see ADR-0012 §c.
 */
@Injectable()
export class CalendarAccountsService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly tokenEncryption: CalendarTokenEncryptionService,
  ) {}

  async connect(
    workspaceId: string,
    userId: string,
    provider: CalendarProvider,
  ): Promise<CalendarAccountSummary> {
    const accessToken = `mock-access-token-${randomUUID()}`;
    const refreshToken = `mock-refresh-token-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + MOCK_TOKEN_TTL_MS);

    const encryptedAccessToken = this.tokenEncryption.encrypt(accessToken);
    const encryptedRefreshToken = this.tokenEncryption.encrypt(refreshToken);

    const [inserted] = await this.db
      .insert(calendarAccounts)
      .values({
        workspaceId,
        userId,
        provider,
        encryptedAccessToken,
        encryptedRefreshToken,
        expiresAt,
      })
      .returning({
        id: calendarAccounts.id,
        provider: calendarAccounts.provider,
        expiresAt: calendarAccounts.expiresAt,
      });

    if (!inserted) {
      throw new ConflictError('Failed to connect calendar account: insert returned no row.');
    }

    return inserted;
  }

  async list(workspaceId: string): Promise<CalendarAccountSummary[]> {
    return this.db
      .select({
        id: calendarAccounts.id,
        provider: calendarAccounts.provider,
        expiresAt: calendarAccounts.expiresAt,
      })
      .from(calendarAccounts)
      .where(eq(calendarAccounts.workspaceId, workspaceId));
  }

  async disconnect(workspaceId: string, accountId: string): Promise<void> {
    const deleted = await this.db
      .delete(calendarAccounts)
      .where(and(eq(calendarAccounts.id, accountId), eq(calendarAccounts.workspaceId, workspaceId)))
      .returning({ id: calendarAccounts.id });

    if (deleted.length === 0) {
      throw new NotFoundError('Calendar account not found');
    }
  }
}
