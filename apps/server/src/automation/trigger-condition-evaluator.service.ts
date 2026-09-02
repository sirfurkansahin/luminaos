import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';

import { evaluateCondition } from '@luminaos/automation';
import type { ConditionSpec } from '@luminaos/automation';

import { CommandsService } from '../commands/commands.service.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { automationTriggerMatches } from '../db/schema/automation-trigger-matches.js';
import { automationTriggers } from '../db/schema/automation-triggers.js';
import { fieldDefinitions } from '../db/schema/field-definitions.js';
import { objectsView } from '../db/schema/objects-view.js';

import type { ProposedAction } from '../ai/parse-command.js';
import type { Database } from '../db/client.js';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/**
 * How often `evaluateOnce()` is invoked via the background interval,
 * ADR-0032 Karar (a) — 2 minutes, fixed and non-configurable.
 */
const EVALUATOR_INTERVAL_MS = 120_000;

/**
 * ADR-0032 Karar (j) — a tick that would newly-match more than this many
 * objects for a single trigger is entirely rejected (human-approved N=50).
 */
const MAX_NEW_MATCHES_PER_TICK = 50;

interface ConditionTriggerRow {
  id: string;
  workspaceId: string;
  spec: unknown;
}

interface ObjectRow {
  id: string;
  fieldValues: unknown;
}

/**
 * `TriggerConditionEvaluatorService` (F2-T15 PR5, ADR-0032 Karar
 * (a)/(b)/(g)/(j)/(k)): the background service that fires `kind:'condition'`
 * (regex) triggers by polling `objects_view` on a fixed interval, diffing the
 * current matching object-id set against the previously-recorded one in
 * `automation_trigger_matches` (a falling edge re-arms the trigger). Mirrors
 * `TriggerSchedulerService`'s (PR4) exact shape: `OnModuleInit`/
 * `OnModuleDestroy` with `setInterval`/`clearInterval`, a public
 * `evaluateOnce()` directly callable by tests, per-row `try/catch` so one
 * trigger's failure never aborts the rest of the scan.
 */
@Injectable()
export class TriggerConditionEvaluatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TriggerConditionEvaluatorService.name);
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly commandsService: CommandsService,
  ) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      void this.evaluateOnce();
    }, EVALUATOR_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
    }
  }

  async evaluateOnce(): Promise<void> {
    const triggers: ConditionTriggerRow[] = await this.db
      .select({
        id: automationTriggers.id,
        workspaceId: automationTriggers.workspaceId,
        spec: automationTriggers.spec,
      })
      .from(automationTriggers)
      .where(
        and(eq(automationTriggers.kind, 'condition'), eq(automationTriggers.lifecycle, 'active')),
      );

    for (const trigger of triggers) {
      try {
        await this.evaluateTrigger(trigger);
      } catch (error) {
        // One trigger's total failure must never abort evaluation of other
        // triggers in the same tick -- logged with only the opaque trigger
        // id, never the trigger's own spec/field content.
        this.logger.error(
          `Condition trigger evaluation failed for automation_triggers row ${trigger.id}.`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  private async evaluateTrigger(trigger: ConditionTriggerRow): Promise<void> {
    const spec = trigger.spec as ConditionSpec;

    const [fieldDefinitionRow] = await this.db
      .select({ id: fieldDefinitions.id })
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.workspaceId, trigger.workspaceId),
          eq(fieldDefinitions.objectType, spec.objectType),
          eq(fieldDefinitions.key, spec.fieldKey),
          eq(fieldDefinitions.lifecycle, 'active'),
        ),
      );
    if (!fieldDefinitionRow) {
      // Karar (g): no live field definition -- skip this trigger entirely
      // for this tick, no crash.
      return;
    }

    const objectRows: ObjectRow[] = await this.db
      .select({ id: objectsView.id, fieldValues: objectsView.fieldValues })
      .from(objectsView)
      .where(
        and(
          eq(objectsView.workspaceId, trigger.workspaceId),
          eq(objectsView.type, spec.objectType),
          ne(objectsView.lifecycle, 'deleted'),
        ),
      );

    const currentMatchingIds = new Set<string>();
    for (const row of objectRows) {
      const fieldValue = (row.fieldValues as Record<string, unknown>)[spec.fieldKey];
      if (evaluateCondition(spec, fieldValue)) {
        currentMatchingIds.add(row.id);
      }
    }

    const previousMatchRows = await this.db
      .select({ objectId: automationTriggerMatches.objectId })
      .from(automationTriggerMatches)
      .where(eq(automationTriggerMatches.triggerId, trigger.id));
    const previousMatchingIds = new Set(previousMatchRows.map((row) => row.objectId));

    const newlyMatching = [...currentMatchingIds].filter((id) => !previousMatchingIds.has(id));
    const noLongerMatching = [...previousMatchingIds].filter((id) => !currentMatchingIds.has(id));

    if (newlyMatching.length > MAX_NEW_MATCHES_PER_TICK) {
      // Karar (j): reject the ENTIRE tick for this trigger -- no match rows,
      // no proposals for any of the newly-matching objects. The trigger
      // stays active, unaffected, and is retried from scratch next tick.
      this.logger.warn(
        `Trigger ${trigger.id} would newly-match ${String(newlyMatching.length)} objects in one tick (>${String(MAX_NEW_MATCHES_PER_TICK)}) -- entire tick rejected, will retry next tick.`,
      );
      return;
    }

    for (const objectId of noLongerMatching) {
      await this.db
        .delete(automationTriggerMatches)
        .where(
          and(
            eq(automationTriggerMatches.triggerId, trigger.id),
            eq(automationTriggerMatches.objectId, objectId),
          ),
        );
    }

    for (const objectId of newlyMatching) {
      try {
        const action: ProposedAction = {
          actionId: randomUUID(),
          type: 'createTaskFromTrigger',
          intent: 'Create a task from a fired condition trigger',
          rationale: 'The condition trigger matched this object on this tick',
          resources: [],
          rollbackNote: 'Delete the created task',
          params: { title: spec.actionTemplate.title },
        };

        await this.commandsService.proposeFromTrigger(trigger.workspaceId, trigger.id, objectId, [
          action,
        ]);

        await this.db.insert(automationTriggerMatches).values({
          triggerId: trigger.id,
          objectId,
        });
      } catch (error) {
        // One object's failure must not block other newly-matching objects
        // of the SAME trigger -- logged with only the opaque trigger/object
        // ids, never field/title content. The match row is deliberately not
        // inserted so this object is retried as newly-matching next tick.
        this.logger.error(
          `Condition trigger fire failed for automation_triggers row ${trigger.id}, object ${objectId}.`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }
}
