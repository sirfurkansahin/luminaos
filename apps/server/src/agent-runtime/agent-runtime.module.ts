import { Module } from '@nestjs/common';

import { AgentConcurrencyGuard } from './agent-concurrency-guard.js';
import { AgentPermissionManifestsController } from './agent-permission-manifests.controller.js';
import { AgentPermissionManifestsService } from './agent-permission-manifests.service.js';
import { AgentResourceLimitsService } from './agent-resource-limits.service.js';
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
  controllers: [AgentPermissionManifestsController],
  providers: [
    AgentPermissionManifestsService,
    AgentResourceLimitsService,
    {
      provide: AgentConcurrencyGuard,
      useFactory: () => new AgentConcurrencyGuard(env.agentSandboxMaxConcurrentPerAgent),
    },
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
  ],
  exports: [AgentPermissionManifestsService, AgentResourceLimitsService],
})
export class AgentRuntimeModule {}
