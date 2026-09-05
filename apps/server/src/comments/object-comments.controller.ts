import {
  Body,
  Controller,
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

import { createCommentSchema } from './dto/create-comment.schema.js';
import { CommentsService } from './object-comments.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { CreateCommentBody } from './dto/create-comment.schema.js';
import type { ObjectComment } from './object-comments.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `/workspaces/:workspaceId/objects/:objectId/comments` -- every route takes
 * both `:workspaceId` and `:objectId`, so the full guard stack applies
 * uniformly at the class level, mirroring `AgentDirectoryController` exactly
 * (F3-T3, ADR-0037 Karar c). RBAC is flat member+ for both routes, enforced
 * inside `CommentsService`, not here.
 */
@Controller('workspaces/:workspaceId/objects/:objectId/comments')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class ObjectCommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Body(new ZodValidationPipe(createCommentSchema))
    body: CreateCommentBody,
    @Req() req: Request,
  ): Promise<{ comment: ObjectComment }> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    const comment = await this.commentsService.create(workspaceId, actor, callerRole, {
      objectId,
      body: body.body,
    });

    return { comment };
  }

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Param('objectId') objectId: string,
    @Req() req: Request,
  ): Promise<{ comments: ObjectComment[] }> {
    const callerRole = this.requireRole(req);

    const comments = await this.commentsService.list(workspaceId, callerRole, objectId);

    return { comments };
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs --
   * fail closed (401) rather than assert it away, mirroring
   * `AgentDirectoryController.requireActorValue`'s exact reasoning.
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
   * reasoning as `AgentDirectoryController.requireRole`.
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
