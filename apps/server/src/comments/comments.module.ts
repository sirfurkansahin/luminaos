import { Module } from '@nestjs/common';

import { ObjectCommentsController } from './object-comments.controller.js';
import { CommentsService } from './object-comments.service.js';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F3-T3 (ADR-0037 Karar c): wires the `object_comments` @mention surface's
 * server bindings (`CommentsService`/`Controller`) into Nest DI, mirroring
 * `AgentRuntimeModule`'s exact import/provider shape. Imports
 * `AgentRuntimeModule` for its already-exported `AgentDirectoryService`
 * (mention resolution) rather than re-registering it as a second provider.
 */
@Module({
  imports: [EventStoreModule, DbModule, AuthModule, AgentRuntimeModule],
  controllers: [ObjectCommentsController],
  providers: [CommentsService, WorkspaceMembershipGuard, WorkspaceMembershipService],
  exports: [CommentsService],
})
export class CommentsModule {}
