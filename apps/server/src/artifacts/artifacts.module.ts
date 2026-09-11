import { Module } from '@nestjs/common';

import { ArtifactsController } from './artifacts.controller.js';
import { ArtifactsService } from './artifacts.service.js';
import { AIProviderModule } from '../ai/ai-provider.module.js';
import { AIUsageModule } from '../ai/ai-usage.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { ObjectsModule } from '../objects/objects.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F3-T7 PR2 (ADR-0041 Karar a/g/h): wires the
 * `POST /workspaces/:workspaceId/artifacts` route. `WorkspaceMembershipGuard`/
 * `WorkspaceMembershipService` are provided directly here rather than by
 * importing a shared workspaces module, mirroring `CommandsModule`'s
 * identical pattern. `ObjectsModule` is imported (not just its service
 * provided directly) so `ObjectsService` is constructed with its own full
 * dependency graph. `AIProviderModule`/`AIUsageModule` provide `AI_PROVIDER`/
 * `AIUsageService` for `ArtifactsService`.
 */
@Module({
  imports: [DbModule, AuthModule, EventStoreModule, AIProviderModule, AIUsageModule, ObjectsModule],
  controllers: [ArtifactsController],
  providers: [ArtifactsService, WorkspaceMembershipGuard, WorkspaceMembershipService],
  exports: [ArtifactsService],
})
export class ArtifactsModule {}
