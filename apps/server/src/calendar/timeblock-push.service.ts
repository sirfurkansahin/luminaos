import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import type { CalendarConnector } from '@luminaos/integrations';

import { CALENDAR_CONNECTOR } from './calendar-connector.token.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { calendarAccounts } from '../db/schema/calendar-accounts.js';
import { timeblockExternalPushes } from '../db/schema/timeblock-external-pushes.js';

import type { Database } from '../db/client.js';

/**
 * F1-T12 PR5d: the one-way push of a `timeblock` object's schedule to every
 * calendar account its CREATOR has connected. Triggered directly by
 * `ObjectsService.scheduleTimeBlock`/`.clearTimeBlockSchedule` immediately
 * after their own `applyCommandWithFieldValues` call resolves -- never via
 * a `Projection`, since a projection rebuild must be safely re-runnable and
 * a re-push on every rebuild would be wrong for a side effect that must fire
 * once per actual state change.
 *
 * Every per-account push is independently try/catch'd: one account's
 * connector failure must never abort another account's push, and must never
 * propagate to the caller (the caller -- `ObjectsService` -- ALSO wraps its
 * own call to this service in try/catch, but this service fails closed on
 * its own per-account loop as defense in depth).
 */
@Injectable()
export class TimeBlockPushService {
  private readonly logger = new Logger(TimeBlockPushService.name);

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    @Inject(CALENDAR_CONNECTOR) private readonly connector: CalendarConnector,
  ) {}

  async pushScheduled(
    objectId: string,
    workspaceId: string,
    createdBy: string,
    title: string,
    schedule: { start: string; end: string },
  ): Promise<void> {
    const accounts = await this.db
      .select({ id: calendarAccounts.id })
      .from(calendarAccounts)
      .where(
        and(eq(calendarAccounts.workspaceId, workspaceId), eq(calendarAccounts.userId, createdBy)),
      );

    for (const account of accounts) {
      try {
        const [existing] = await this.db
          .select()
          .from(timeblockExternalPushes)
          .where(
            and(
              eq(timeblockExternalPushes.objectId, objectId),
              eq(timeblockExternalPushes.calendarAccountId, account.id),
            ),
          )
          .limit(1);

        if (!existing) {
          const { externalId } = await this.connector.createEvent({
            title,
            start: schedule.start,
            end: schedule.end,
          });

          await this.db.insert(timeblockExternalPushes).values({
            objectId,
            calendarAccountId: account.id,
            externalId,
          });
        } else {
          await this.connector.updateEvent(existing.externalId, {
            title,
            start: schedule.start,
            end: schedule.end,
          });

          await this.db
            .update(timeblockExternalPushes)
            .set({ updatedAt: new Date() })
            .where(eq(timeblockExternalPushes.id, existing.id));
        }
      } catch (error) {
        this.logger.error(
          `Failed to push timeblock ${objectId} schedule to calendar account ${account.id}; the timeblock's own schedule write already succeeded.`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  async pushCleared(objectId: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(timeblockExternalPushes)
      .where(eq(timeblockExternalPushes.objectId, objectId));

    for (const row of rows) {
      try {
        await this.connector.deleteEvent(row.externalId);

        await this.db.delete(timeblockExternalPushes).where(eq(timeblockExternalPushes.id, row.id));
      } catch (error) {
        this.logger.error(
          `Failed to delete external calendar event ${row.externalId} for timeblock ${objectId}; leaving the mapping row in place.`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }
}
