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

import { CommandsService } from './commands.service.js';
import { decideActionsSchema } from './dto/decide-actions.schema.js';
import { parseCommandSchema } from './dto/parse-command.schema.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { CommandsServiceParseResult, DecideActionResult } from './commands.service.js';
import type { DecideActionsInput } from './dto/decide-actions.schema.js';
import type { ParseCommandInput } from './dto/parse-command.schema.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * F1-T16 PR6 (ADR-0015 §f): wires the already-complete `CommandsService`
 * (PR4/PR5) into HTTP. Mirrors `QAController`/`ObjectsController`'s exact
 * class-level guard stack + PARAMETER-level `@Body(new ZodValidationPipe(...))`
 * convention — NOT a method-level `@UsePipes`, per the F1-T12 PR5a
 * pipe-scoping lesson — and `ObjectsController`'s `requireActor`/`requireRole`
 * private-helper pattern verbatim.
 */
@Controller('workspaces/:workspaceId/commands')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class CommandsController {
  constructor(private readonly commandsService: CommandsService) {}

  @Post('parse')
  @HttpCode(HttpStatus.OK)
  async parse(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(parseCommandSchema)) body: ParseCommandInput,
    @Req() req: Request,
  ): Promise<CommandsServiceParseResult> {
    const actor = this.requireActor(req);

    return this.commandsService.parse(workspaceId, actor, body.command, body.sourceObjectId);
  }

  @Post(':proposalId/decide')
  @HttpCode(HttpStatus.OK)
  async decide(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('proposalId') proposalId: string,
    @Body(new ZodValidationPipe(decideActionsSchema)) body: DecideActionsInput,
    @Req() req: Request,
  ): Promise<{ results: DecideActionResult[] }> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);

    return this.commandsService.decide(workspaceId, proposalId, actor, callerRole, body.decisions);
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
