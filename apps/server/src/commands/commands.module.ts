import { forwardRef, Module } from '@nestjs/common';

import { CommandsController } from './commands.controller.js';
import { CommandsService } from './commands.service.js';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';
import { AIProviderModule } from '../ai/ai-provider.module.js';
import { AIUsageModule } from '../ai/ai-usage.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CommentsModule } from '../comments/comments.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { ObjectsModule } from '../objects/objects.module.js';
import { RelationsModule } from '../relations/relations.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F1-T16 PR6 (ADR-0015 §f): wires the `POST /workspaces/:workspaceId/commands/parse`
 * and `POST /workspaces/:workspaceId/commands/:proposalId/decide` routes.
 * `WorkspaceMembershipGuard`/`WorkspaceMembershipService` are provided
 * directly here rather than by importing a shared workspaces module,
 * mirroring `QAModule`'s identical pattern. `ObjectsModule`/`RelationsModule`
 * are imported (not just their services provided directly) so `ObjectsService`/
 * `RelationsService` are constructed with their own full dependency graphs.
 *
 * `AgentRuntimeModule` (F3-T3 PR4, ADR-0037 §4) is imported so
 * `AgentPermissionManifestsService` resolves via DI for
 * `CommandsService.executeReconfigureAgentPermissions`.
 *
 * `CommentsModule` (F3-T5 PR2, ADR-0039) is imported so `CommentsService`
 * resolves via DI for `CommandsService.notifyAutonomousAction` — wrapped in
 * `forwardRef()` because it closes a genuine 3-module ES-import cycle:
 * `CommandsModule -> CommentsModule -> SkillsModule -> CommandsModule`
 * (`SkillsModule` already imports `CommandsModule` for `CommandsService`,
 * wrapped in its own matching `forwardRef()`).
 *
 * `AgentRuntimeModule` itself is wrapped in `forwardRef()` too (F3-T6 PR2,
 * ADR-0040 Karar g): it now imports `CommandsModule` back (so
 * `AgentActionRecordsController.undo` can inject `CommandsService`), closing
 * a genuine 2-module cycle — `forwardRef()` on BOTH edges, mirroring the
 * `CommentsModule` precedent above.
 */
@Module({
  imports: [
    DbModule,
    AuthModule,
    EventStoreModule,
    AIProviderModule,
    AIUsageModule,
    ObjectsModule,
    RelationsModule,
    forwardRef(() => AgentRuntimeModule),
    forwardRef(() => CommentsModule),
  ],
  controllers: [CommandsController],
  providers: [CommandsService, WorkspaceMembershipGuard, WorkspaceMembershipService],
  exports: [CommandsService],
})
export class CommandsModule {}
