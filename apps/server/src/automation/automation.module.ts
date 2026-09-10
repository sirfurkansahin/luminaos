import { forwardRef, Module } from '@nestjs/common';

import { AutomationTriggersController } from './automation-triggers.controller.js';
import { AutomationTriggersService } from './automation-triggers.service.js';
import { TriggerConditionEvaluatorService } from './trigger-condition-evaluator.service.js';
import { TriggerSchedulerService } from './trigger-scheduler.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { CommandsModule } from '../commands/commands.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * `CommandsModule` is imported via `forwardRef()` (F3-T5 PR2, ADR-0039) --
 * same reasoning as `NotetakerModule`'s identical fix: `CommandsModule`'s
 * new `CommentsModule` import (for `CommandsService.notifyAutonomousAction`)
 * opened a cycle reaching back here via `SkillsModule ->
 * TriggerSuggestionsModule -> AutomationModule -> CommandsModule`.
 */
@Module({
  imports: [EventStoreModule, DbModule, AuthModule, forwardRef(() => CommandsModule)],
  controllers: [AutomationTriggersController],
  providers: [
    AutomationTriggersService,
    TriggerSchedulerService,
    TriggerConditionEvaluatorService,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
  ],
  exports: [AutomationTriggersService],
})
export class AutomationModule {}
