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

import type { AgentPermissionManifest } from '@luminaos/agent-runtime';
import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { AgentPermissionManifestsService } from './agent-permission-manifests.service.js';
import { grantPermissionManifestSchema } from './dto/grant-permission-manifest.schema.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { GrantPermissionManifestInput } from './dto/grant-permission-manifest.schema.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `/workspaces/:workspaceId/agent-runtime/permission-manifests` -- every
 * route takes a `:workspaceId`, so the full guard stack applies uniformly at
 * the class level, mirroring `AutomationTriggersController` exactly. Per
 * ADR-0035 Karar d, the admin-vs-member gating is uniform per route (flat
 * RBAC, not ownership-dependent) -- `admin`+ for writes, `member`+ for reads
 * -- enforced inside `AgentPermissionManifestsService`, not here.
 */
@Controller('workspaces/:workspaceId/agent-runtime/permission-manifests')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class AgentPermissionManifestsController {
  constructor(private readonly agentPermissionManifestsService: AgentPermissionManifestsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async grant(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(grantPermissionManifestSchema))
    body: GrantPermissionManifestInput,
    @Req() req: Request,
  ): Promise<{ manifest: AgentPermissionManifest }> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    const manifest = await this.agentPermissionManifestsService.grant(
      workspaceId,
      actor,
      callerRole,
      {
        agentIdentifier: body.agentIdentifier,
        dataScope: body.dataScope,
        actionTypes: body.actionTypes,
        timeWindow: {
          startsAt: body.timeWindow.startsAt === null ? null : new Date(body.timeWindow.startsAt),
          expiresAt:
            body.timeWindow.expiresAt === null ? null : new Date(body.timeWindow.expiresAt),
        },
      },
    );

    return { manifest };
  }

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
  ): Promise<{ manifests: AgentPermissionManifest[] }> {
    const callerRole = this.requireRole(req);

    const manifests = await this.agentPermissionManifestsService.list(workspaceId, callerRole);

    return { manifests };
  }

  @Delete(':agentIdentifier')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param('workspaceId') workspaceId: string,
    @Param('agentIdentifier') agentIdentifier: string,
    @Req() req: Request,
  ): Promise<void> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    await this.agentPermissionManifestsService.revoke(
      workspaceId,
      agentIdentifier,
      actor,
      callerRole,
    );
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs --
   * fail closed (401) rather than assert it away, mirroring
   * `AutomationTriggersController.requireActorValue`'s exact reasoning.
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
   * reasoning as `AutomationTriggersController.requireRole`.
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
