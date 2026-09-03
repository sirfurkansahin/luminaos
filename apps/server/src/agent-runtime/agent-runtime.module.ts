import { Module } from '@nestjs/common';

import { AgentPermissionManifestsController } from './agent-permission-manifests.controller.js';
import { AgentPermissionManifestsService } from './agent-permission-manifests.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F3-T1 (ADR-0035): wires the agent permission manifest server bindings
 * (`AgentPermissionManifestsService`/`Controller`) into Nest DI, mirroring
 * `AutomationModule`'s exact import/provider shape. `AgentPermissionManifestsService`
 * is exported for future PR3 (resource limits + sandbox execution)/consumers
 * (F3-T2/F3-T3) that will call `checkPermission`.
 */
@Module({
  imports: [EventStoreModule, DbModule, AuthModule],
  controllers: [AgentPermissionManifestsController],
  providers: [
    AgentPermissionManifestsService,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
  ],
  exports: [AgentPermissionManifestsService],
})
export class AgentRuntimeModule {}
