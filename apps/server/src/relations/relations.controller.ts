import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { Relation } from '@luminaos/core-objects';
import { UnauthorizedError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { createRelationSchema } from './dto/create-relation.schema.js';
import { RelationsService } from './relations.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { CreateRelationInput } from './dto/create-relation.schema.js';
import type { Request } from 'express';

/**
 * Every route under this controller already takes a `:workspaceId`, so the
 * full guard stack applies uniformly at the class level, mirroring
 * `ObjectsController` exactly — NO admin/role gating (unlike
 * `FieldsController`'s admin-gated schema-management routes): any workspace
 * member (including `guest`) may create/remove relations.
 */
@Controller('workspaces/:workspaceId/relations')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class RelationsController {
  constructor(private readonly relationsService: RelationsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(createRelationSchema)) body: CreateRelationInput,
    @Req() req: Request,
  ): Promise<{ relation: Relation }> {
    const actor = this.requireActor(req);

    const relation = await this.relationsService.create(workspaceId, actor, {
      fromId: body.fromId,
      toId: body.toId,
      kind: body.kind,
    });

    return { relation };
  }

  @Delete(':relationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('relationId') relationId: string,
    @Req() req: Request,
  ): Promise<void> {
    const actor = this.requireActor(req);

    await this.relationsService.remove(workspaceId, relationId, actor);
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs —
   * fail closed (401) rather than assert it away, mirroring
   * `ObjectsController.requireActor`'s exact reasoning.
   */
  private requireActor(req: Request): Actor {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    return { type: 'user', id: req.user.id };
  }
}
