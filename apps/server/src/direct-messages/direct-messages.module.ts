import { Module } from '@nestjs/common';

import { DirectMessagesController } from './direct-messages.controller.js';
import { DirectMessagesService } from './direct-messages.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { CommandsModule } from '../commands/commands.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F3-T3 PR5 (ADR-0037 §4): wires the `POST`/`GET
 * /workspaces/:workspaceId/agents/:agentIdentifier/dm` routes.
 * `WorkspaceMembershipGuard`/`WorkspaceMembershipService` are provided
 * directly here rather than by importing a shared workspaces module,
 * mirroring `CommandsModule`'s own identical pattern -- there is no shared
 * workspaces module to import instead. `CommandsModule` (not
 * `CommandsService` directly) is imported so `CommandsService` resolves via
 * DI with its own full dependency graph already wired.
 */
@Module({
  imports: [DbModule, AuthModule, EventStoreModule, CommandsModule],
  controllers: [DirectMessagesController],
  providers: [DirectMessagesService, WorkspaceMembershipGuard, WorkspaceMembershipService],
})
export class DirectMessagesModule {}
