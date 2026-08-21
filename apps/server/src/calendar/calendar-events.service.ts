import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, lt } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { calendarEventsCache } from '../db/schema/calendar-events-cache.js';

import type { Database } from '../db/client.js';

export interface CachedCalendarEvent {
  externalId: string;
  title: string;
  start: string;
  end: string;
  meetingUrl?: string;
}

/**
 * Reads previously-polled external calendar events back out of the
 * read-only `calendar_events_cache` table (ADR-0012 §a). NEVER selects or
 * joins any `calendar_accounts` token column -- same no-token-leakage
 * discipline as `calendar-accounts.service.ts`.
 */
@Injectable()
export class CalendarEventsService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async listCachedEvents(
    workspaceId: string,
    range: { start: string; end: string },
  ): Promise<CachedCalendarEvent[]> {
    const rows = await this.db
      .select({
        externalId: calendarEventsCache.externalId,
        title: calendarEventsCache.title,
        eventStart: calendarEventsCache.eventStart,
        eventEnd: calendarEventsCache.eventEnd,
        meetingUrl: calendarEventsCache.meetingUrl,
      })
      .from(calendarEventsCache)
      .where(
        and(
          eq(calendarEventsCache.workspaceId, workspaceId),
          lt(calendarEventsCache.eventStart, new Date(range.end)),
          gt(calendarEventsCache.eventEnd, new Date(range.start)),
        ),
      );

    return rows.map((row) => ({
      externalId: row.externalId,
      title: row.title,
      start: row.eventStart.toISOString(),
      end: row.eventEnd.toISOString(),
      ...(row.meetingUrl !== null ? { meetingUrl: row.meetingUrl } : {}),
    }));
  }
}
