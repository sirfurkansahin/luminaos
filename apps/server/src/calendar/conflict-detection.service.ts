import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNotNull, lt, ne } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { calendarAccounts } from '../db/schema/calendar-accounts.js';
import { calendarEventsCache } from '../db/schema/calendar-events-cache.js';
import { objectsView } from '../db/schema/objects-view.js';

import type { Database } from '../db/client.js';

export interface ConflictInterval {
  kind: 'timeblock' | 'external';
  id: string;
  title: string;
  start: string;
  end: string;
}

export interface ConflictPair {
  a: ConflictInterval;
  b: ConflictInterval;
}

/**
 * F1-T12 PR7 / ADR-0012 §g: derived, READ-TIME ONLY, warning-only conflict
 * detection between a user's own `timeblock` objects and their own cached
 * external calendar events. NEVER event-sourced, NEVER persisted, NEVER
 * blocks a write -- purely a read-model computation over two already-stored
 * projections (`objects_view`, `calendar_events_cache`).
 *
 * Conflicts are scoped to overlaps WITHIN the SAME user's own intervals --
 * never across two different workspace members (spec-pinned, see this
 * class's test file's header).
 */
@Injectable()
export class ConflictDetectionService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async findConflicts(
    workspaceId: string,
    userId: string,
    range: { start: string; end: string },
  ): Promise<ConflictPair[]> {
    const rangeStart = new Date(range.start);
    const rangeEnd = new Date(range.end);

    const timeblockRows = await this.db
      .select({
        id: objectsView.id,
        title: objectsView.title,
        timeBlockStart: objectsView.timeBlockStart,
        timeBlockEnd: objectsView.timeBlockEnd,
      })
      .from(objectsView)
      .where(
        and(
          eq(objectsView.workspaceId, workspaceId),
          eq(objectsView.type, 'timeblock'),
          eq(objectsView.createdBy, userId),
          ne(objectsView.lifecycle, 'deleted'),
          isNotNull(objectsView.timeBlockStart),
          lt(objectsView.timeBlockStart, rangeEnd),
          gt(objectsView.timeBlockEnd, rangeStart),
        ),
      );

    // `isNotNull(objectsView.timeBlockStart)` in the query above guarantees
    // `timeBlockStart` is non-null at runtime; this filter also narrows
    // `timeBlockEnd` (always set alongside `timeBlockStart` by the
    // `POST .../timeblock` route) so the `.toISOString()` calls below never
    // need a non-null assertion.
    const timeblockIntervals: ConflictInterval[] = timeblockRows
      .filter(
        (row): row is typeof row & { timeBlockStart: Date; timeBlockEnd: Date } =>
          row.timeBlockStart !== null && row.timeBlockEnd !== null,
      )
      .map((row) => ({
        kind: 'timeblock',
        id: row.id,
        title: row.title,
        start: row.timeBlockStart.toISOString(),
        end: row.timeBlockEnd.toISOString(),
      }));

    const externalRows = await this.db
      .select({
        externalId: calendarEventsCache.externalId,
        title: calendarEventsCache.title,
        eventStart: calendarEventsCache.eventStart,
        eventEnd: calendarEventsCache.eventEnd,
      })
      .from(calendarEventsCache)
      .innerJoin(calendarAccounts, eq(calendarEventsCache.calendarAccountId, calendarAccounts.id))
      .where(
        and(
          eq(calendarAccounts.userId, userId),
          eq(calendarEventsCache.workspaceId, workspaceId),
          lt(calendarEventsCache.eventStart, rangeEnd),
          gt(calendarEventsCache.eventEnd, rangeStart),
        ),
      );

    const externalIntervals: ConflictInterval[] = externalRows.map((row) => ({
      kind: 'external',
      id: row.externalId,
      title: row.title,
      start: row.eventStart.toISOString(),
      end: row.eventEnd.toISOString(),
    }));

    const intervals = [...timeblockIntervals, ...externalIntervals];

    const pairs: ConflictPair[] = [];
    for (const [i, first] of intervals.entries()) {
      for (const second of intervals.slice(i + 1)) {
        if (
          new Date(first.start) < new Date(second.end) &&
          new Date(first.end) > new Date(second.start)
        ) {
          pairs.push({ a: first, b: second });
        }
      }
    }

    return pairs;
  }
}
