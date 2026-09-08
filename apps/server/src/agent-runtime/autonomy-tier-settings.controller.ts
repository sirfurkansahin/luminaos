import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';

import type { TaskAutonomySetting } from '@luminaos/agent-runtime';
import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { AutonomyTierSettingsService } from './autonomy-tier-settings.service.js';
import { setAutonomyTierSchema } from './dto/set-autonomy-tier.schema.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { SetAutonomyTierInput } from './dto/set-autonomy-tier.schema.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `/workspaces/:workspaceId/task-autonomy-settings` — ONLY `GET`/`PUT`
 * (ADR-0039 Karar i, spec Kabul Kriteri) — no POST/DELETE/PATCH anywhere on
 * this controller. Mirrors `AgentPermissionManifestsController`'s exact
 * guard-stack/RBAC-delegation-to-service shape.
 */
@Controller('workspaces/:workspaceId/task-autonomy-settings')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class AutonomyTierSettingsController {
  constructor(private readonly autonomyTierSettingsService: AutonomyTierSettingsService) {}

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
  ): Promise<{ settings: TaskAutonomySetting[] }> {
    const callerRole = this.requireRole(req);

    const settings = await this.autonomyTierSettingsService.list(workspaceId, callerRole);

    return { settings };
  }

  @Put(':actionType')
  async set(
    @Param('workspaceId') workspaceId: string,
    @Param('actionType') actionType: string,
    @Body(new ZodValidationPipe(setAutonomyTierSchema))
    body: SetAutonomyTierInput,
    @Req() req: Request,
  ): Promise<{ setting: TaskAutonomySetting }> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    const setting = await this.autonomyTierSettingsService.set(
      workspaceId,
      actionType,
      body.tier,
      actor,
      callerRole,
    );

    return { setting };
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs
   * -- fail closed (401) rather than assert it away, mirroring
   * `AgentPermissionManifestsController.requireActorValue`'s exact
   * reasoning.
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
