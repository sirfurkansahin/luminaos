import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';

import { agentNotificationPreferenceSetPayloadSchema } from '@luminaos/agent-runtime';
import type {
  NotificationPreference,
  AgentNotificationPreferenceSetPayload,
} from '@luminaos/agent-runtime';
import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { AgentNotificationGovernorService } from './agent-notification-governor.service.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { NotificationUsageSummary } from './agent-notification-governor.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * F3-T13 PR3 (ADR-0047 Karar i, spec Kabul Kriterleri) --
 * `/workspaces/:workspaceId/notification-preferences/:userId` (+
 * `/usage-summary`), mirroring `AutonomyTierSettingsController`'s exact
 * guard-stack/RBAC-delegation-to-service shape. `get`/`usage-summary` are
 * self-OR-admin+ (delegated to/mirrored from
 * `NotificationPreferencesService.get`'s own RBAC); `set` (PUT) is
 * self-ONLY, admin included -- entirely enforced inside
 * `NotificationPreferencesService.set` itself, this controller only forwards
 * the caller's identity/role.
 */
@Controller('workspaces/:workspaceId/notification-preferences')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class NotificationPreferencesController {
  constructor(
    private readonly notificationPreferencesService: NotificationPreferencesService,
    private readonly agentNotificationGovernorService: AgentNotificationGovernorService,
  ) {}

  @Get(':userId')
  async get(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Req() req: Request,
  ): Promise<{ preference: NotificationPreference | null }> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    const preference = await this.notificationPreferencesService.get(
      workspaceId,
      userId,
      actor.id,
      callerRole,
    );

    return { preference };
  }

  @Put(':userId')
  async set(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(agentNotificationPreferenceSetPayloadSchema))
    body: AgentNotificationPreferenceSetPayload,
    @Req() req: Request,
  ): Promise<{ preference: NotificationPreference }> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    const preference = await this.notificationPreferencesService.set(
      workspaceId,
      userId,
      body,
      actor,
      callerRole,
    );

    return { preference };
  }

  /**
   * Self OR admin+ -- `NotificationPreferencesService.get`'s RBAC repeated
   * here (rather than delegated) because `AgentNotificationGovernorService.
   * getUsageSummary` itself takes no RBAC parameter at all (ADR-0047 Karar
   * b/i's "internal read-point" convention, mirrors
   * `AutonomyTierSettingsService.get`'s equivalent).
   */
  @Get(':userId/usage-summary')
  async usageSummary(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Req() req: Request,
  ): Promise<{ summary: NotificationUsageSummary }> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    if (!hasAtLeastRole(callerRole, 'member')) {
      throw new ForbiddenError();
    }

    if (actor.id !== userId && !hasAtLeastRole(callerRole, 'admin')) {
      throw new ForbiddenError();
    }

    const summary = await this.agentNotificationGovernorService.getUsageSummary(
      workspaceId,
      userId,
    );

    return { summary };
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs
   * -- fail closed (401) rather than assert it away, mirroring
   * `AutonomyTierSettingsController.requireActorValue`'s exact reasoning.
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
   * reasoning as `AutonomyTierSettingsController.requireRole`.
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
