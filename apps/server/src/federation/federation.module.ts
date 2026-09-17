import { Module } from '@nestjs/common';

import { FederationAuditService } from './federation-audit.service.js';
import { FederationLinkCredentialsService } from './federation-link-credentials.service.js';
import { FederationLinksController } from './federation-links.controller.js';
import { FederationLinksService } from './federation-links.service.js';
import { FederationMcpController } from './federation-mcp.controller.js';
import { FederationRateLimitService } from './federation-rate-limit.service.js';
import { FederationScopeController } from './federation-scope.controller.js';
import { FederationScopeService } from './federation-scope.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { ContextModule } from '../context/context.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F3-T14 PR1/PR2 (ADR-0048): wires the federation domain services AND (as of
 * PR2) the MCP tool controller + human-facing REST controllers into
 * `AppModule`. `WorkspaceMembershipGuard`/`WorkspaceMembershipService` are
 * provided DIRECTLY (not via importing `WorkspacesModule`) -- the SAME
 * cycle-avoidance precedent `AuthModule`/`AgentRuntimeModule` already
 * establish (`AuthModule`'s own doc comment: `WorkspacesModule` imports
 * `AuthModule`, so importing it back here would risk a cycle; the service
 * is stateless, a second instance is harmless). `FederationTokenAuthGuard`
 * (the MCP controller's guard) only needs `DbModule`, already imported.
 */
@Module({
  imports: [DbModule, EventStoreModule, ContextModule, AuthModule],
  controllers: [FederationMcpController, FederationLinksController, FederationScopeController],
  providers: [
    FederationLinksService,
    FederationScopeService,
    FederationLinkCredentialsService,
    FederationAuditService,
    FederationRateLimitService,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
  ],
  exports: [FederationLinksService, FederationScopeService, FederationLinkCredentialsService],
})
export class FederationModule {}
