import { Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';

import type { Role } from '@luminaos/core-objects';
import { ForbiddenError } from '@luminaos/shared';

import { ContextService } from './context.service.js';
import { getContextQuerySchema } from './dto/get-context-query.schema.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { ContextResponse } from './context.service.js';
import type { GetContextQuery } from './dto/get-context-query.schema.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `GET /workspaces/:workspaceId/context/:objectId` (F2-T2, ADR-0018 Karar
 * d). Same guard stack and `requireRole` fails-closed pattern as
 * `ExportController` -- this is a read of data the caller already has
 * workspace access to, filtered field-by-field, not an admin-gated route.
 */
@Controller('workspaces/:workspaceId/context')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class ContextController {
  constructor(private readonly contextService: ContextService) {}

  @Get(':objectId')
  async getContext(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('objectId') objectId: string,
    @Query(new ZodValidationPipe(getContextQuerySchema)) query: GetContextQuery,
    @Req() req: Request,
  ): Promise<ContextResponse> {
    const callerRole = this.requireRole(req);

    return this.contextService.getContext(
      workspaceId,
      objectId,
      callerRole,
      query.sort ? { sort: query.sort } : {},
    );
  }

  /**
   * Mirrors `ExportController.requireRole`'s exact reasoning and cast
   * (`MembershipRole`/`Role` are structurally identical 4-value string
   * unions). Fails closed (403) if `WorkspaceMembershipGuard` somehow
   * didn't run.
   */
  private requireRole(req: Request): Role {
    const role = req.membership?.role as MembershipRole | undefined;
    if (!role) {
      throw new ForbiddenError();
    }
    return role;
  }
}
