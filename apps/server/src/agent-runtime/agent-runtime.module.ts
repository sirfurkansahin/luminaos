import { Module } from '@nestjs/common';

import { AgentActionRecordsController } from './agent-action-records.controller.js';
import { AgentActionRecordsService } from './agent-action-records.service.js';
import { AgentConcurrencyGuard } from './agent-concurrency-guard.js';
import { AgentDirectoryController } from './agent-directory.controller.js';
import { AgentDirectoryService } from './agent-directory.service.js';
import { AgentPermissionManifestsController } from './agent-permission-manifests.controller.js';
import { AgentPermissionManifestsService } from './agent-permission-manifests.service.js';
import { AgentResourceLimitsService } from './agent-resource-limits.service.js';
import { AutonomyTierSettingsController } from './autonomy-tier-settings.controller.js';
import { AutonomyTierSettingsService } from './autonomy-tier-settings.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { env } from '../config/env.js';
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
 *
 * PR3 (ADR-0035 Karar g) additionally wires `AgentResourceLimitsService` and
 * its injected `AgentConcurrencyGuard` -- the latter is not a zero-arg
 * injectable (its constructor takes `maxConcurrentPerAgent`), so it is
 * registered via a factory provider reading `env.agentSandboxMaxConcurrentPerAgent`.
 * No controller/route for either -- internal-only per ADR-0035 Karar h.
 */
@Module({
  imports: [EventStoreModule, DbModule, AuthModule],
  controllers: [
    AgentPermissionManifestsController,
    AgentDirectoryController,
    AgentActionRecordsController,
    AutonomyTierSettingsController,
  ],
  providers: [
    AgentPermissionManifestsService,
    AgentResourceLimitsService,
    AgentDirectoryService,
    AgentActionRecordsService,
    AutonomyTierSettingsService,
    {
      provide: AgentConcurrencyGuard,
      useFactory: () => new AgentConcurrencyGuard(env.agentSandboxMaxConcurrentPerAgent),
    },
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
  ],
  exports: [
    AgentPermissionManifestsService,
    AgentResourceLimitsService,
    AgentDirectoryService,
    AgentActionRecordsService,
    AutonomyTierSettingsService,
  ],
})
export class AgentRuntimeModule {}
