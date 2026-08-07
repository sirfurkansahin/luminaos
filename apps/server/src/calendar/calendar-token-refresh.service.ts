import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import type { CalendarAccount, CalendarConnector } from '@luminaos/integrations';
import { NotFoundError } from '@luminaos/shared';

import { CALENDAR_CONNECTOR } from './calendar-connector.token.js';
import { CalendarReconnectRequiredError } from './calendar-reconnect-required.error.js';
import { CalendarTokenEncryptionService } from './calendar-token-encryption.service.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { calendarAccounts } from '../db/schema/calendar-accounts.js';

import type { Database } from '../db/client.js';

/**
 * Proactive refresh buffer (F1-T12 PR5b): a token is refreshed once its
 * expiry is within this window, not only once it has already expired — this
 * avoids a caller ever handing out a token that dies mid-request.
 */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Ensures a calendar account's access token is fresh, transparently
 * refreshing it via the injected `CalendarConnector` when it is expired or
 * about to expire. See `calendar-token-refresh.integration.test.ts`'s header
 * comment for the pinned contract.
 */
@Injectable()
export class CalendarTokenRefreshService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly tokenEncryption: CalendarTokenEncryptionService,
    @Inject(CALENDAR_CONNECTOR) private readonly connector: CalendarConnector,
  ) {}

  /**
   * `workspaceId` is REQUIRED (not optional) so this method's signature
   * itself forces every future caller (e.g. the PR5c poller) to scope the
   * lookup to the workspace it already knows it's operating in -- defense-
   * in-depth against a future HTTP handler ever passing a client-supplied
   * `accountId` without an independent workspace check (security review,
   * F1-T12 PR5b). A mismatched `workspaceId` is indistinguishable from a
   * nonexistent account (both -> `NotFoundError`), mirroring
   * `CalendarAccountsService.disconnect`'s identical-404 convention.
   */
  async ensureFreshAccessToken(accountId: string, workspaceId: string): Promise<string> {
    const rows = await this.db
      .select()
      .from(calendarAccounts)
      .where(
        and(eq(calendarAccounts.id, accountId), eq(calendarAccounts.workspaceId, workspaceId)),
      );
    const row = rows[0];

    if (row === undefined) {
      throw new NotFoundError('Calendar account not found');
    }

    const accessToken = this.tokenEncryption.decrypt(row.encryptedAccessToken);

    if (row.expiresAt.getTime() > Date.now() + REFRESH_BUFFER_MS) {
      return accessToken;
    }

    const refreshToken = this.tokenEncryption.decrypt(row.encryptedRefreshToken);
    const account: CalendarAccount = {
      id: row.id,
      provider: row.provider as 'google' | 'outlook',
      accessToken,
      refreshToken,
      expiresAt: row.expiresAt.toISOString(),
    };

    const refreshed = await this.connector.refreshToken(account).catch(() => {
      throw new CalendarReconnectRequiredError(row.id, row.provider);
    });

    const newEncryptedAccessToken = this.tokenEncryption.encrypt(refreshed.accessToken);
    const newEncryptedRefreshToken =
      refreshed.refreshToken !== undefined
        ? this.tokenEncryption.encrypt(refreshed.refreshToken)
        : row.encryptedRefreshToken;

    await this.db
      .update(calendarAccounts)
      .set({
        encryptedAccessToken: newEncryptedAccessToken,
        encryptedRefreshToken: newEncryptedRefreshToken,
        expiresAt: new Date(refreshed.expiresAt),
        updatedAt: new Date(),
      })
      .where(eq(calendarAccounts.id, accountId));

    return refreshed.accessToken;
  }
}
