import { Module } from '@nestjs/common';

import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';
import { EmbeddingProviderModule } from '../ai/embedding-provider.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F1-T13 PR5 (ADR-0013 §b/§f): wires the `POST /workspaces/:workspaceId/search`
 * route. `WorkspaceMembershipGuard`/`WorkspaceMembershipService` are provided
 * directly here rather than by importing `WorkspacesModule`, mirroring
 * `ObjectsModule`'s identical pattern.
 */
@Module({
  imports: [DbModule, AuthModule, EmbeddingProviderModule],
  controllers: [SearchController],
  providers: [SearchService, WorkspaceMembershipGuard, WorkspaceMembershipService],
})
export class SearchModule {}
