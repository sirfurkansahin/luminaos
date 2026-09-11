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

import type { ObjectType, Role } from '@luminaos/core-objects';
import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { generateWidgetSchema } from './dto/generate-widget.schema.js';
import { WidgetsService } from './widgets.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { GenerateWidgetRequestInput } from './dto/generate-widget.schema.js';
import type { ObjectWithFieldValues } from '../objects/objects.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `POST /workspaces/:workspaceId/artifacts/widgets` (F3-T8 PR2, ADR-0042
 * Karar a/c/d/i): mirrors `ArtifactsController`'s EXACT class structure --
 * same guard stack, same `requireActor`/`requireRole` private-helper
 * pattern. RBAC (Karar i): guarded ONLY by `SessionAuthGuard` +
 * `WorkspaceMembershipGuard` -- the SAME base as `ArtifactsController`'s own
 * gate (ADR-0041 Karar g), no stricter role required.
 */
@Controller('workspaces/:workspaceId/artifacts/widgets')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class WidgetsController {
  constructor(private readonly widgetsService: WidgetsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async generate(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(generateWidgetSchema)) body: GenerateWidgetRequestInput,
    @Req() req: Request,
  ): Promise<{ object: ObjectWithFieldValues }> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);

    const object = await this.widgetsService.generate(workspaceId, actor, callerRole, {
      prompt: body.prompt,
      // `generateWidgetSchema.objectType` is a bounded string (1..100), not a
      // closed enum -- see that DTO's own doc comment. `ObjectsService.query`
      // (called deeper in `WidgetsService.generate`) is the real
      // "is this a known object type" gate (`isKnownObjectType`), fails
      // closed with a `ValidationError` for anything unrecognized.
      objectType: body.objectType as ObjectType,
      themePreset: body.themePreset,
    });

    return { object };
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs —
   * fail closed (401) rather than assert it away, mirroring
   * `ArtifactsController.requireActor`'s identical reasoning.
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
   * mirrors `ArtifactsController.requireRole`'s exact reasoning. Fails closed
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
