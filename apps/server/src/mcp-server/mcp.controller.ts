import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import type { Role } from '@luminaos/core-objects';
import { ForbiddenError } from '@luminaos/shared';

import { InboundMcpRateLimitService } from './inbound-mcp-rate-limit.service.js';
import { McpTokenAuthGuard } from './mcp-token-auth.guard.js';
import { ContextService } from '../context/context.service.js';

import type { Request, Response } from 'express';

/**
 * F2-T12 PR1 (ADR-0028 §j/§m): `POST /mcp`, workspace-independent (Karar d) --
 * a fresh `McpServer` + `StreamableHTTPServerTransport` per request (Karar j,
 * no connection pooling), registering only the read-only `get_context` tool
 * (Karar e/f) wrapping the existing, unmodified `ContextService.getContext`.
 */
@Controller('mcp')
@UseGuards(McpTokenAuthGuard)
export class McpController {
  constructor(
    private readonly contextService: ContextService,
    private readonly rateLimit: InboundMcpRateLimitService,
  ) {}

  @Post()
  async handleMcp(@Req() req: Request, @Res() res: Response): Promise<void> {
    const { workspaceId, role, grantId } = this.requireMcpContext(req);

    await this.rateLimit.assertNotRateLimited(workspaceId, grantId, 1);

    const server = new McpServer({ name: 'luminaos', version: '1.0.0' });
    server.registerTool(
      'get_context',
      {
        description: 'Bir LuminaOS nesnesinin 1-hop bağlam grafiğini getirir.',
        inputSchema: { objectId: z.string() },
      },
      async ({ objectId }) => {
        const result = await this.contextService.getContext(workspaceId, objectId, role);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      },
    );

    // @ts-expect-error upstream @modelcontextprotocol/sdk <-> exactOptionalPropertyTypes
    // incompatibility, same documented class of issue as
    // `packages/integrations/src/mcp/streamable-http-mcp-connector.ts`'s `connect()`:
    // stateless mode's own doc-comment example passes `sessionIdGenerator: undefined`,
    // but the option's declared type is `() => string` (no `| undefined`), which
    // `exactOptionalPropertyTypes: true` rejects at the type level -- runtime behavior
    // is unaffected (this is the SDK's own documented stateless-mode construction, ADR-0028 §j/§m).
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // @ts-expect-error upstream @modelcontextprotocol/sdk <-> exactOptionalPropertyTypes
    // incompatibility: `StreamableHTTPServerTransport`'s `onclose`/similar optional
    // handler fields are typed `(() => void) | undefined`, which the `Transport`
    // interface's stricter optional-field typing rejects under
    // `exactOptionalPropertyTypes: true` -- a purely-structural upstream typing quirk.
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /**
   * `McpTokenAuthGuard` always populates `req.membership`/`req.mcpGrant`
   * before `canActivate` returns `true` -- this only fails closed (403) if
   * that guard somehow didn't run, mirroring `ContextController.requireRole`'s
   * exact reasoning/cast (`Role` is a structurally-identical string union).
   */
  private requireMcpContext(req: Request): {
    workspaceId: string;
    role: Role;
    grantId: string;
  } {
    const membership = req.membership;
    const mcpGrant = req.mcpGrant;
    if (!membership || !mcpGrant) {
      throw new ForbiddenError();
    }

    return {
      workspaceId: membership.workspaceId,
      role: membership.role as Role,
      grantId: mcpGrant.id,
    };
  }
}
