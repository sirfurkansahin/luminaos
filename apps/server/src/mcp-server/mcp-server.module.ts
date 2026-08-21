import { Module } from '@nestjs/common';

import { InboundMcpRateLimitService } from './inbound-mcp-rate-limit.service.js';
import { McpClientGrantsController } from './mcp-client-grants.controller.js';
import { McpClientGrantsService } from './mcp-client-grants.service.js';
import { McpTokenAuthGuard } from './mcp-token-auth.guard.js';
import { McpController } from './mcp.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { ContextModule } from '../context/context.module.js';
import { DbModule } from '../db/db.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F2-T12 PR1 (ADR-0028): wires the inbound MCP surface into `AppModule` --
 * `McpController` (`POST /mcp`, workspace-independent, Karar d), guarded by
 * `McpTokenAuthGuard` (Karar i/m), plus `McpClientGrantsController` (Karar k,
 * the browser-session-authenticated token-management routes, unrelated to
 * the MCP protocol endpoint itself).
 */
@Module({
  imports: [DbModule, AuthModule, ContextModule],
  controllers: [McpController, McpClientGrantsController],
  providers: [
    McpClientGrantsService,
    InboundMcpRateLimitService,
    McpTokenAuthGuard,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
  ],
})
export class McpServerModule {}
