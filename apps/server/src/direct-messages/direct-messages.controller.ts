import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { DirectMessagesService } from './direct-messages.service.js';
import { sendDmMessageSchema } from './dto/send-dm-message.schema.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { DmMessage } from './direct-messages.service.js';
import type { SendDmMessageInput } from './dto/send-dm-message.schema.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `/workspaces/:workspaceId/agents/:agentIdentifier/dm` -- every route takes
 * a `:workspaceId`, so the full guard stack applies uniformly at the class
 * level, mirroring `AgentDirectoryController` exactly (F3-T3 PR5, ADR-0037
 * §4). The member-vs-admin gating for the DM-triggered reconfiguration
 * request itself is enforced inside `CommandsService.proposeFromDirectMessage`,
 * not here -- a below-admin `member` caller still gets a 201 with a polite
 * `agentReply`, never a 403 at this HTTP layer.
 */
@Controller('workspaces/:workspaceId/agents/:agentIdentifier/dm')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class DirectMessagesController {
  constructor(private readonly directMessagesService: DirectMessagesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async send(
    @Param('workspaceId') workspaceId: string,
    @Param('agentIdentifier') agentIdentifier: string,
    @Body(new ZodValidationPipe(sendDmMessageSchema))
    body: SendDmMessageInput,
    @Req() req: Request,
  ): Promise<{ userMessage: DmMessage; agentReply: DmMessage }> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    return this.directMessagesService.send(
      workspaceId,
      actor,
      callerRole,
      agentIdentifier,
      body.body,
    );
  }

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Param('agentIdentifier') agentIdentifier: string,
    @Query('userId') userId: string | undefined,
    @Req() req: Request,
  ): Promise<{ messages: DmMessage[] }> {
    const requestingUserId = this.requireActorValue(req).id;
    const callerRole = this.requireRole(req);
    const targetUserId = userId ?? requestingUserId;

    const messages = await this.directMessagesService.list(
      workspaceId,
      requestingUserId,
      targetUserId,
      agentIdentifier,
      callerRole,
    );

    return { messages };
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
