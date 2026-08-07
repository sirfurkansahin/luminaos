import { Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';

import { UnauthorizedError } from '@luminaos/shared';

import { ConflictDetectionService } from './conflict-detection.service.js';
import { listConflictsSchema } from './dto/list-conflicts.schema.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { ConflictPair } from './conflict-detection.service.js';
import type { ListConflictsQuery } from './dto/list-conflicts.schema.js';
import type { Request } from 'express';

@Controller('workspaces/:workspaceId/calendar/conflicts')
export class ConflictsController {
  constructor(private readonly conflictDetectionService: ConflictDetectionService) {}

  @Get()
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query(new ZodValidationPipe(listConflictsSchema)) query: ListConflictsQuery,
    @Req() req: Request,
  ): Promise<{ conflicts: ConflictPair[] }> {
    // `WorkspaceMembershipGuard` always sets `req.membership` before this
    // handler runs (it throws otherwise) -- fail closed rather than assert.
    if (!req.membership || !req.user) {
      throw new UnauthorizedError();
    }

    const conflicts = await this.conflictDetectionService.findConflicts(
      workspaceId,
      req.user.id,
      query,
    );

    return { conflicts };
  }
}
