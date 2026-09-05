import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { AgentDirectoryService } from './agent-directory.service.js';
import { registerAgentSchema } from './dto/register-agent.schema.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { Agent } from './agent-directory.service.js';
import type { RegisterAgentInput } from './dto/register-agent.schema.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `/workspaces/:workspaceId/agents` -- every route takes a `:workspaceId`,
 * so the full guard stack applies uniformly at the class level, mirroring
 * `AgentPermissionManifestsController` exactly (F3-T3, ADR-0037 Karar b/d).
 * The admin-vs-member gating is uniform per route (flat RBAC) -- `admin`+
 * for writes, `member`+ for reads -- enforced inside `AgentDirectoryService`,
 * not here.
 */
@Controller('workspaces/:workspaceId/agents')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class AgentDirectoryController {
  constructor(private readonly agentDirectoryService: AgentDirectoryService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(registerAgentSchema))
    body: RegisterAgentInput,
    @Req() req: Request,
  ): Promise<{ agent: Agent }> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    const agent = await this.agentDirectoryService.register(workspaceId, actor, callerRole, {
      name: body.name,
      agentIdentifier: body.agentIdentifier,
    });

    return { agent };
  }

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
  ): Promise<{ agents: Agent[] }> {
    const callerRole = this.requireRole(req);

    const agents = await this.agentDirectoryService.list(workspaceId, callerRole);

    return { agents };
  }

  @Delete(':agentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivate(
    @Param('workspaceId') workspaceId: string,
    @Param('agentId') agentId: string,
    @Req() req: Request,
  ): Promise<void> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    await this.agentDirectoryService.deactivate(workspaceId, agentId, actor, callerRole);
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs --
   * fail closed (401) rather than assert it away, mirroring
   * `AgentPermissionManifestsController.requireActorValue`'s exact reasoning.
   */
  private requireActorValue(req: Request): Actor {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    return { type: 'user', id: req.user.id };
  }

  /**
   * `WorkspaceMembershipGuard` always sets `req.membership` before any
   * handler here runs -- fail closed (403) rather than assert it away, same
   * reasoning as `AgentPermissionManifestsController.requireRole`.
   */
  private requireRole(req: Request): MembershipRole {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const role = req.membership?.role as MembershipRole | undefined;

    if (!role) {
      throw new ForbiddenError();
    }

    return role;
  }
}
