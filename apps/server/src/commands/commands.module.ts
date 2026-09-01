import { Module } from '@nestjs/common';

import { CommandsController } from './commands.controller.js';
import { CommandsService } from './commands.service.js';
import { AIProviderModule } from '../ai/ai-provider.module.js';
import { AIUsageModule } from '../ai/ai-usage.module.js';
import { AuthModule } from '../auth/auth.module.js';
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
  ],
  controllers: [CommandsController],
  providers: [CommandsService, WorkspaceMembershipGuard, WorkspaceMembershipService],
  exports: [CommandsService],
})
export class CommandsModule {}
