import { forwardRef, Module } from '@nestjs/common';

import { AgentActionRecordsController } from './agent-action-records.controller.js';
import { AgentActionRecordsService } from './agent-action-records.service.js';
import { AgentConcurrencyGuard } from './agent-concurrency-guard.js';
import { AgentDirectoryController } from './agent-directory.controller.js';
import { AgentDirectoryService } from './agent-directory.service.js';
import { AgentNotificationGovernorService } from './agent-notification-governor.service.js';
import { AgentPermissionManifestsController } from './agent-permission-manifests.controller.js';
import { AgentPermissionManifestsService } from './agent-permission-manifests.service.js';
import { AgentResourceLimitsService } from './agent-resource-limits.service.js';
import { AutonomyTierSettingsController } from './autonomy-tier-settings.controller.js';
import { AutonomyTierSettingsService } from './autonomy-tier-settings.service.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { CommandsModule } from '../commands/commands.module.js';
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
 *
 * F3-T6 PR2 (ADR-0040 Karar g) additionally imports `CommandsModule` so
 * `AgentActionRecordsController.undo` can inject `CommandsService` — wrapped
 * in `forwardRef()` since `CommandsModule` itself imports `AgentRuntimeModule`
 * (for `AgentPermissionManifestsService`/`AutonomyTierSettingsService`),
 * closing a genuine 2-module cycle. Mirrors `CommandsModule`'s own
 * `CommentsModule` `forwardRef()` precedent.
 *
 * F3-T13 PR1 (ADR-0047 Karar a) additionally registers
 * `NotificationPreferencesService` — no controller/route yet (PR1 scope is
 * service-layer only, mirrors this module's own `AgentResourceLimitsService`
 * "no HTTP surface" precedent), exported for PR2's
 * `AgentNotificationGovernorService` to consume.
 *
 * F3-T13 PR2 (ADR-0047 Karar h) additionally registers
 * `AgentNotificationGovernorService` — also no controller/route (internal-
 * only, same precedent), exported so `CommandsModule` (already importing
 * this module via `forwardRef()`) can inject it into `CommandsService`'s
 * widened constructor.
 */
@Module({
  imports: [EventStoreModule, DbModule, AuthModule, forwardRef(() => CommandsModule)],
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
    NotificationPreferencesService,
    AgentNotificationGovernorService,
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
    NotificationPreferencesService,
    AgentNotificationGovernorService,
  ],
})
export class AgentRuntimeModule {}
