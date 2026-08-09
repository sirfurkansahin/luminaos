import { Module } from '@nestjs/common';

import { QAController } from './qa.controller.js';
import { QAService } from './qa.service.js';
import { AIProviderModule } from '../ai/ai-provider.module.js';
import { AIUsageModule } from '../ai/ai-usage.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { SearchModule } from '../search/search.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F1-T15 PR4 (ADR-0014 §a/§b): wires the `POST /workspaces/:workspaceId/qa`
 * route. `WorkspaceMembershipGuard`/`WorkspaceMembershipService` are provided
 * directly here rather than by importing `WorkspacesModule`, mirroring
 * `SearchModule`'s identical pattern.
 */
@Module({
  imports: [DbModule, AuthModule, SearchModule, AIProviderModule, AIUsageModule],
  controllers: [QAController],
  providers: [QAService, WorkspaceMembershipGuard, WorkspaceMembershipService],
})
export class QAModule {}
