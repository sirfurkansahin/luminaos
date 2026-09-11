import {
  Controller,
  forwardRef,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { AgentActionRecord } from '@luminaos/agent-runtime';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { AgentActionRecordsService } from './agent-action-records.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { CommandsService } from '../commands/commands.service.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `/workspaces/:workspaceId/agent-action-records` — read-only (ADR-0038
 * Karar e/g): the ledger has NO write route at all, only `list`/`get`. Any
 * mutation happens exclusively via internal `AgentActionRecordsService.
 * record()` calls from `CommandsService`'s `executeXxx` methods (PR2) and
 * `MentionActionWorker` (PR3) — never through HTTP.
 *
 * F3-T6 PR2 (ADR-0040 Karar g) adds the ONE deliberate write-route exception:
 * `POST :id/undo`, delegating to `CommandsService.undoAction`.
 * `CommandsService` is injected via `forwardRef()` since `CommandsModule`
 * imports `AgentRuntimeModule` (for `AgentPermissionManifestsService`/
 * `AutonomyTierSettingsService`), creating a genuine
 * `AgentRuntimeModule <-> CommandsModule` cycle — mirrors the already-merged
 * `CommandsModule <-> CommentsModule` `forwardRef()` precedent.
 */
@Controller('workspaces/:workspaceId/agent-action-records')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class AgentActionRecordsController {
  constructor(
    private readonly agentActionRecordsService: AgentActionRecordsService,
    @Inject(forwardRef(() => CommandsService))
    private readonly commandsService: CommandsService,
  ) {}

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
   * `POST .../:id/undo` (F3-T6 PR2, ADR-0040 Karar d/e/f/g) — the one
   * deliberate write-route exception on this otherwise read-only controller.
   * `requireRole` (member+, else `ForbiddenError`) is checked BEFORE
   * delegating to `CommandsService.undoAction`, which then re-derives its own
   * `NotFoundError`/`ValidationError`/`ConflictError` from the record itself.
   */
  @Post(':id/undo')
  @HttpCode(HttpStatus.OK)
  async undo(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ status: 'undone' }> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);

    return this.commandsService.undoAction(workspaceId, id, actor, callerRole);
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

  /** `SessionAuthGuard` always sets `req.user` before any handler here runs -- fail closed (401) rather than assert it away. */
  private requireActor(req: Request): Actor {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    return { type: 'user', id: req.user.id };
  }
}
