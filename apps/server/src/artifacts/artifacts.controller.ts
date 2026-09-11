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

import { ArtifactsService } from './artifacts.service.js';
import { generateArtifactSchema } from './dto/generate-artifact.schema.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { GenerateArtifactRequestInput } from './dto/generate-artifact.schema.js';
import type { ObjectWithFieldValues } from '../objects/objects.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `POST /workspaces/:workspaceId/artifacts` (F3-T7 PR2, ADR-0041 Karar g/h):
 * mirrors `ObjectsController`/`CommandsController`'s exact class-level guard
 * stack + parameter-level `@Body(new ZodValidationPipe(...))` convention,
 * and `ObjectsController`'s `requireActor`/`requireRole` private-helper
 * pattern verbatim. RBAC (Karar g): guarded ONLY by `SessionAuthGuard` +
 * `WorkspaceMembershipGuard` -- NO additional role gate beyond plain
 * membership, same as `CommandsController.parse`'s own gate.
 */
@Controller('workspaces/:workspaceId/artifacts')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class ArtifactsController {
  constructor(private readonly artifactsService: ArtifactsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async generate(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(generateArtifactSchema)) body: GenerateArtifactRequestInput,
    @Req() req: Request,
  ): Promise<{ object: ObjectWithFieldValues }> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);

    const object = await this.artifactsService.generate(workspaceId, actor, callerRole, {
      prompt: body.prompt,
      artifactType: body.artifactType,
      themePreset: body.themePreset,
    });

    return { object };
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs —
   * fail closed (401) rather than assert it away, mirroring
   * `ObjectsController.requireActor`'s identical reasoning.
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
   * mirrors `ObjectsController.requireRole`'s exact reasoning. Fails closed
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
