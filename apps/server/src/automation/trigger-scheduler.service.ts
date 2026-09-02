import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import type { ScheduleSpec } from '@luminaos/automation';

import { CommandsService } from '../commands/commands.service.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { automationTriggers } from '../db/schema/automation-triggers.js';

import type { ProposedAction } from '../ai/parse-command.js';
import type { Database } from '../db/client.js';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/**
 * How often `runOnce()` is invoked via the background interval. `60_000`
 * (60 seconds) is fine enough granularity relative to `intervalMinutes`
 * (validated elsewhere as a positive integer number of minutes, ADR-0032) --
 * the shortest possible configured interval is 1 minute, so a 60-second tick
 * never misses a due trigger by more than that tick's own resolution.
 */
const SCHEDULER_INTERVAL_MS = 60_000;

interface ScheduledTriggerRow {
  id: string;
  workspaceId: string;
  spec: unknown;
  lastFiredAt: Date | null;
}

/**
 * `TriggerSchedulerService` (F2-T15 PR4, ADR-0032 Karar (a)/(c)): the
 * background service that fires `kind: 'scheduled'` triggers (condition/
 * regex triggers are PR5, out of scope here). Mirrors
 * `MeetingRetentionSweeperService`'s exact shape (`OnModuleInit`/
 * `OnModuleDestroy` with `setInterval`/`clearInterval`, a public `runOnce()`
 * directly callable by tests, per-row `try/catch` so one row's failure never
 * aborts the rest of the scan and never marks that row as fired -- it is
 * retried on the next tick instead).
 */
@Injectable()
export class TriggerSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TriggerSchedulerService.name);
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly commandsService: CommandsService,
  ) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      void this.runOnce();
    }, SCHEDULER_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
    }
  }

  async runOnce(): Promise<void> {
    const rows: ScheduledTriggerRow[] = await this.db
      .select({
        id: automationTriggers.id,
        workspaceId: automationTriggers.workspaceId,
        spec: automationTriggers.spec,
        lastFiredAt: automationTriggers.lastFiredAt,
      })
      .from(automationTriggers)
      .where(
        and(eq(automationTriggers.kind, 'scheduled'), eq(automationTriggers.lifecycle, 'active')),
      );

    for (const row of rows) {
      try {
        const spec = row.spec as ScheduleSpec;
        const isDue =
          row.lastFiredAt === null ||
          Date.now() - row.lastFiredAt.getTime() >= spec.intervalMinutes * 60_000;

        if (!isDue) {
          continue;
        }

        const action: ProposedAction = {
          actionId: randomUUID(),
          type: 'createTaskFromTrigger',
          intent: 'Create a task from a fired scheduled trigger',
          rationale: 'The scheduled trigger reached its configured interval',
          resources: [],
          rollbackNote: 'Delete the created task',
          params: { title: spec.actionTemplate.title },
        };

        await this.commandsService.proposeFromTrigger(row.workspaceId, row.id, undefined, [action]);

        await this.db
          .update(automationTriggers)
          .set({ lastFiredAt: new Date() })
          .where(eq(automationTriggers.id, row.id));
      } catch (error) {
        // One trigger's failure must never abort the rest of the scan, nor
        // mark it as fired -- it is retried on the next tick. Mirrors
        // `MeetingRetentionSweeperService.sweepOnce()`'s per-row try/catch
        // discipline: logged with the opaque trigger id only, never the
        // trigger's own spec/title content (CLAUDE.md's "kullanıcı verisini
        // log'a yazma" rule).
        this.logger.error(
          `Scheduled trigger fire failed for automation_triggers row ${row.id}.`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }
}
