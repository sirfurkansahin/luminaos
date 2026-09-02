import { Module } from '@nestjs/common';

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

@Module({
  imports: [EventStoreModule, DbModule, AuthModule, CommandsModule],
  controllers: [AutomationTriggersController],
  providers: [
    AutomationTriggersService,
    TriggerSchedulerService,
    TriggerConditionEvaluatorService,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
  ],
})
export class AutomationModule {}
