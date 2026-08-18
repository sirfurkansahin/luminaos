import { Module } from '@nestjs/common';

import { ConnectorCredentialsService } from './connector-credentials.service.js';
import { ConnectorRateLimitService } from './connector-rate-limit.service.js';
import { McpConnectorsModule } from './mcp-connectors.module.js';
import { McpOAuthController } from './mcp-oauth.controller.js';
import { OAuthStateService } from './oauth-state.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F2-T9 PR2 (ADR-0025 §n) + F2-T10 PR1 (ADR-0026 §i/§n): wires
 * `ConnectorCredentialsService`/`ConnectorRateLimitService`/
 * `OAuthStateService` for DI, mirroring `MemoryModule`'s/`CalendarModule`'s
 * import/provider wiring, and registers the FIRST public REST endpoints for
 * MCP connector OAuth (`McpOAuthController`). `WorkspaceMembershipGuard`/
 * `WorkspaceMembershipService` are redeclared as providers here (rather than
 * imported via `WorkspacesModule`) mirroring `../calendar/calendar.module.ts`'s
 * established pattern -- `WorkspacesModule` only exports the service, not
 * the guard. `ConnectorHealthService` remains deliberately NOT registered
 * here as a Nest provider (unchanged from F2-T9 PR2's reasoning) -- it takes
 * a `McpConnectorRegistry` instance as a constructor argument, which
 * `McpConnectorsModule` (imported below) now provides, but nothing in THIS
 * task's scope consumes `ConnectorHealthService` through Nest DI yet.
 */
@Module({
  imports: [DbModule, AuthModule, McpConnectorsModule],
  controllers: [McpOAuthController],
  providers: [
    ConnectorCredentialsService,
    ConnectorRateLimitService,
    OAuthStateService,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
  ],
  exports: [ConnectorCredentialsService, ConnectorRateLimitService, OAuthStateService],
})
export class IntegrationsModule {}
