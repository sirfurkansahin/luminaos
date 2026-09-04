import { Module } from '@nestjs/common';

import { TriggerSuggestionsController } from './trigger-suggestions.controller.js';
import { TriggerSuggestionsService } from './trigger-suggestions.service.js';
import { AIProviderModule } from '../ai/ai-provider.module.js';
import { AIUsageModule } from '../ai/ai-usage.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AutomationModule } from '../automation/automation.module.js';
import { CommandsModule } from '../commands/commands.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F2-T17 PR2 (ADR-0034): wires the
 * `GET/POST /workspaces/:workspaceId/trigger-suggestions...` routes.
 * `AutomationModule`/`CommandsModule` are imported (not just their services
 * provided directly) so `TriggerSuggestionsService` receives the real,
 * already-exported `AutomationTriggersService`/`CommandsService` instances
 * with their own full dependency graphs, mirroring `AutomationModule`'s own
 * "import CommandsModule for CommandsService" precedent.
 */
@Module({
  imports: [
    DbModule,
    AuthModule,
    EventStoreModule,
    AIProviderModule,
    AIUsageModule,
    AutomationModule,
    CommandsModule,
  ],
  controllers: [TriggerSuggestionsController],
  providers: [TriggerSuggestionsService, WorkspaceMembershipGuard, WorkspaceMembershipService],
  exports: [TriggerSuggestionsService],
})
export class TriggerSuggestionsModule {}
