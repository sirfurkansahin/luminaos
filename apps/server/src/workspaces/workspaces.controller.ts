import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';

import { UnauthorizedError } from '@luminaos/shared';

import { createWorkspaceSchema } from './dto/create-workspace.schema.js';
import { WorkspaceInconsistencyError } from './workspace-inconsistency.error.js';
import { WorkspaceMembershipGuard } from './workspace-membership.guard.js';
import { WorkspacesService } from './workspaces.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import type { CreateWorkspaceInput } from './dto/create-workspace.schema.js';
import type { WorkspaceResult } from './workspaces.service.js';
import type { Request } from 'express';

@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Post()
  @UseGuards(SessionAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(createWorkspaceSchema))
  async createWorkspace(
    @Body() body: CreateWorkspaceInput,
    @Req() req: Request,
  ): Promise<{ workspace: WorkspaceResult }> {
    // `SessionAuthGuard` always sets `req.user` before this handler runs —
    // fail closed (401) rather than assert it away, mirroring
    // `me.controller.ts`'s handling of the same guarantee.
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const workspace = await this.workspacesService.createWorkspace(body.name, req.user.id);

    return { workspace };
  }

  @Get(':workspaceId')
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  async getWorkspace(
    // Guards run before parameter pipes, so `WorkspaceMembershipGuard`
    // already rejects a malformed `workspaceId` before this pipe ever runs
    // (see its own UUID check) — `ParseUUIDPipe` here is defense in depth,
    // not the primary guard against a raw driver exception.
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Req() req: Request,
  ): Promise<{ workspace: WorkspaceResult; role: string }> {
    // `WorkspaceMembershipGuard` always sets `req.membership` before this
    // handler runs (it throws otherwise) — fail closed rather than assert.
    if (!req.membership) {
      throw new UnauthorizedError();
    }

    const workspace = await this.workspacesService.getWorkspaceById(workspaceId);

    // Shouldn't happen: `WorkspaceMembershipGuard` already proved a
    // membership row exists for this workspace id, and `workspaceId` is a
    // foreign key on `memberships`, so the workspace itself must exist.
    // Surfacing it as an internal-consistency failure (500) rather than a
    // silent 404/undefined is the defensive choice here — this indicates a
    // bug (e.g. a race with a concurrent delete), not a client error.
    if (!workspace) {
      throw new WorkspaceInconsistencyError();
    }

    return { workspace, role: req.membership.role };
  }
}
