import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { UnauthorizedError } from '@luminaos/shared';

import { createMcpClientGrantSchema } from './dto/create-mcp-client-grant.schema.js';
import { McpClientGrantsService } from './mcp-client-grants.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { CreateMcpClientGrantInput } from './dto/create-mcp-client-grant.schema.js';
import type { McpClientGrant } from './mcp-client-grants.service.js';
import type { Request } from 'express';

/**
 * F2-T12 PR1 (ADR-0028 §k): the browser-session-authenticated token
 * management routes -- `SessionAuthGuard`+`WorkspaceMembershipGuard`, the
 * SAME guard stack `ContextController` uses, unrelated to the MCP protocol
 * endpoint itself (`McpTokenAuthGuard`, a completely separate guard).
 */
@Controller('workspaces/:workspaceId/mcp/grants')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class McpClientGrantsController {
  constructor(private readonly grantsService: McpClientGrantsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(createMcpClientGrantSchema)) body: CreateMcpClientGrantInput,
    @Req() req: Request,
  ): Promise<{ grant: McpClientGrant; rawToken: string }> {
    const userId = this.requireUserId(req);

    return this.grantsService.grant(workspaceId, userId, body.name, body.expiresAtDays);
  }

  @Get()
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Req() req: Request,
  ): Promise<{ grants: McpClientGrant[] }> {
    const userId = this.requireUserId(req);
    const grants = await this.grantsService.list(workspaceId, userId);

    return { grants };
  }

  @Delete(':grantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('grantId', ParseUUIDPipe) grantId: string,
    @Req() req: Request,
  ): Promise<void> {
    const userId = this.requireUserId(req);
    await this.grantsService.revoke(workspaceId, userId, grantId);
  }

  /** `SessionAuthGuard` always sets `req.user` before any handler here runs
   * -- fail closed (401) rather than assert it away, mirroring
   * `CalendarAccountsController`'s identical guarantee-check pattern. */
  private requireUserId(req: Request): string {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    return req.user.id;
  }
}
