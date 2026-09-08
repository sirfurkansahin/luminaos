import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';

import type { AgentActionRecord } from '@luminaos/agent-runtime';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@luminaos/shared';

import { AgentActionRecordsService } from './agent-action-records.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `/workspaces/:workspaceId/agent-action-records` — read-only (ADR-0038
 * Karar e/g): the ledger has NO write route at all, only `list`/`get`. Any
 * mutation happens exclusively via internal `AgentActionRecordsService.
 * record()` calls from `CommandsService`'s `executeXxx` methods (PR2) and
 * `MentionActionWorker` (PR3) — never through HTTP.
 */
@Controller('workspaces/:workspaceId/agent-action-records')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class AgentActionRecordsController {
  constructor(private readonly agentActionRecordsService: AgentActionRecordsService) {}

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
  ): Promise<{ records: AgentActionRecord[] }> {
    const callerRole = this.requireRole(req);

    const records = await this.agentActionRecordsService.list(workspaceId, callerRole);

    return { records };
  }

  @Get(':id')
  async get(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ record: AgentActionRecord }> {
    const callerRole = this.requireRole(req);

    const record = await this.agentActionRecordsService.get(workspaceId, id, callerRole);

    if (!record) {
      throw new NotFoundError('Agent action record not found');
    }

    return { record };
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
