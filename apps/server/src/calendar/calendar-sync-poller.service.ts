import { Inject, Injectable } from '@nestjs/common';

import type { CalendarConnector } from '@luminaos/integrations';

import { CALENDAR_CONNECTOR } from './calendar-connector.token.js';
import { CalendarTokenRefreshService } from './calendar-token-refresh.service.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { calendarAccounts } from '../db/schema/calendar-accounts.js';
import { calendarEventsCache } from '../db/schema/calendar-events-cache.js';

import type { Database } from '../db/client.js';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/** How far into the future each poll cycle asks the connector for events. */
const SYNC_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** How often `pollOnce()` is invoked via the background interval. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Periodically polls each connected calendar account's external calendar via
 * the injected `CalendarConnector`, caching returned events into the
 * read-only `calendar_events_cache` table (ADR-0012 §a). See
 * `calendar-sync-poller.integration.test.ts`'s header comment for the pinned
 * contract.
 */
@Injectable()
export class CalendarSyncPollerService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly tokenRefresh: CalendarTokenRefreshService,
    @Inject(CALENDAR_CONNECTOR) private readonly connector: CalendarConnector,
  ) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      void this.pollOnce();
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
    }
  }

  async pollOnce(): Promise<void> {
    const accounts = await this.db
      .select({
        id: calendarAccounts.id,
        workspaceId: calendarAccounts.workspaceId,
      })
      .from(calendarAccounts);

    for (const account of accounts) {
      try {
        await this.tokenRefresh.ensureFreshAccessToken(account.id, account.workspaceId);

        const now = new Date();
        const events = await this.connector.listEvents({
          start: now.toISOString(),
          end: new Date(now.getTime() + SYNC_WINDOW_MS).toISOString(),
        });

        for (const event of events) {
          await this.db
            .insert(calendarEventsCache)
            .values({
              calendarAccountId: account.id,
              workspaceId: account.workspaceId,
              externalId: event.externalId,
              title: event.title,
              eventStart: new Date(event.start),
              eventEnd: new Date(event.end),
              meetingUrl: event.meetingUrl ?? null,
            })
            .onConflictDoUpdate({
              target: [calendarEventsCache.calendarAccountId, calendarEventsCache.externalId],
              set: {
                title: event.title,
                eventStart: new Date(event.start),
                eventEnd: new Date(event.end),
                meetingUrl: event.meetingUrl ?? null,
                updatedAt: new Date(),
              },
            });
        }
      } catch {
        // Skip this account for this cycle -- one account's failure (e.g. a
        // reconnect-required token, or a connector-side error) must never
        // abort another account's poll. No token/account content is logged.
      }
    }
  }
}
