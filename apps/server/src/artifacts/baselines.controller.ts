import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { Role } from '@luminaos/core-objects';
import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { BaselinesService } from './baselines.service.js';
import { captureBaselineSchema } from './dto/capture-baseline.schema.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { CaptureBaselineRequestInput } from './dto/capture-baseline.schema.js';
import type { ObjectWithFieldValues } from '../objects/objects.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `POST /workspaces/:workspaceId/artifacts/baselines` (F3-T10 PR2, ADR-0044
 * Karar a/c/d/g): mirrors `WidgetsController`'s EXACT class structure --
 * same guard stack, same `requireActor`/`requireRole` private-helper
 * pattern. RBAC (Karar g): guarded ONLY by `SessionAuthGuard` +
 * `WorkspaceMembershipGuard` -- the SAME base as `ArtifactsController`'s/
 * `WidgetsController`'s own gate, no stricter role required.
 */
@Controller('workspaces/:workspaceId/artifacts/baselines')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class BaselinesController {
  constructor(private readonly baselinesService: BaselinesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async capture(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(captureBaselineSchema)) body: CaptureBaselineRequestInput,
    @Req() req: Request,
  ): Promise<{ object: ObjectWithFieldValues }> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);

    const object = await this.baselinesService.capture(workspaceId, actor, callerRole, {
      title: body.title,
      querySpec: body.querySpec,
      aggregateFn: body.aggregateFn,
      ...(body.targetFieldKey !== undefined ? { targetFieldKey: body.targetFieldKey } : {}),
    });

    return { object };
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs —
   * fail closed (401) rather than assert it away, mirroring
   * `WidgetsController.requireActor`'s identical reasoning.
   */
  private requireActor(req: Request): Actor {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    return { type: 'user', id: req.user.id };
  }

  /**
   * `MembershipRole` (server) and `Role` (`@luminaos/core-objects`) are
   * structurally identical 4-value string unions, so this cast is a no-op —
   * mirrors `WidgetsController.requireRole`'s exact reasoning. Fails closed
   * (403) if `WorkspaceMembershipGuard` somehow didn't run.
   */
  private requireRole(req: Request): Role {
    const role = req.membership?.role as MembershipRole | undefined;

    if (!role) {
      throw new ForbiddenError();
    }

    return role;
  }
}
