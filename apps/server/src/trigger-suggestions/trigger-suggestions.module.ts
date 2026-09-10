import { forwardRef, Module } from '@nestjs/common';

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
 *
 * `CommandsModule`/`AutomationModule` are BOTH imported via `forwardRef()`
 * (F3-T5 PR2, ADR-0039) -- `CommandsModule`'s new `CommentsModule` import
 * opened a cycle reaching back here TWICE: directly (`SkillsModule ->
 * TriggerSuggestionsModule -> CommandsModule`) and via `AutomationModule`
 * itself (`SkillsModule -> TriggerSuggestionsModule -> AutomationModule ->
 * CommandsModule -> ... -> TriggerSuggestionsModule -> AutomationModule`,
 * closing back on itself) -- both edges need deferred resolution.
 */
@Module({
  imports: [
    DbModule,
    AuthModule,
    EventStoreModule,
    AIProviderModule,
    AIUsageModule,
    forwardRef(() => AutomationModule),
    forwardRef(() => CommandsModule),
  ],
  controllers: [TriggerSuggestionsController],
  providers: [TriggerSuggestionsService, WorkspaceMembershipGuard, WorkspaceMembershipService],
  exports: [TriggerSuggestionsService],
})
export class TriggerSuggestionsModule {}
