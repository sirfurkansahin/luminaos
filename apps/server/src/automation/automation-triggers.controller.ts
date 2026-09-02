import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { Trigger } from '@luminaos/automation';
import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { AutomationTriggersService } from './automation-triggers.service.js';
import { createTriggerSchema } from './dto/create-trigger.schema.js';
import { updateTriggerSchema } from './dto/update-trigger.schema.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { UpdateTriggerCommandInput } from './automation-triggers.service.js';
import type { CreateTriggerInput } from './dto/create-trigger.schema.js';
import type { UpdateTriggerInput } from './dto/update-trigger.schema.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `/workspaces/:workspaceId/triggers` -- every route takes a `:workspaceId`,
 * so the full guard stack applies uniformly at the class level, mirroring
 * `SavedViewsController`. Per ADR-0032 §h, the admin-vs-member gating IS
 * uniform per route (unlike `SavedViewsController`'s ownership-dependent
 * branch) -- `admin`+ for writes, `member`+ for reads -- so it's a flat
 * `hasAtLeastRole` check inside `AutomationTriggersService`, not here.
 */
@Controller('workspaces/:workspaceId/triggers')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class AutomationTriggersController {
  constructor(private readonly automationTriggersService: AutomationTriggersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(createTriggerSchema)) body: CreateTriggerInput,
    @Req() req: Request,
  ): Promise<{ trigger: Trigger }> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    const trigger = await this.automationTriggersService.create(workspaceId, actor, callerRole, {
      name: body.name,
      spec: body.spec,
    });

    return { trigger };
  }

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
  ): Promise<{ triggers: Trigger[] }> {
    const callerRole = this.requireRole(req);

    const triggers = await this.automationTriggersService.list(workspaceId, callerRole);

    return { triggers };
  }

  @Patch(':triggerId')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('triggerId') triggerId: string,
    @Body(new ZodValidationPipe(updateTriggerSchema)) body: UpdateTriggerInput,
    @Req() req: Request,
  ): Promise<{ trigger: Trigger }> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    const trigger = await this.automationTriggersService.update(
      workspaceId,
      triggerId,
      actor,
      callerRole,
      this.toUpdateInput(body),
    );

    return { trigger };
  }

  @Delete(':triggerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('triggerId') triggerId: string,
    @Req() req: Request,
  ): Promise<void> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    await this.automationTriggersService.delete(workspaceId, triggerId, actor, callerRole);
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs --
   * fail closed (401) rather than assert it away, mirroring
   * `SavedViewsController.requireActor`'s exact reasoning. Returns the real
   * `Actor` (security-review finding, F2-T15 PR2) so every mutation records
   * WHO performed it, not just that a sufficiently-privileged role did.
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
   * reasoning as `SavedViewsController.requireRole`.
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

  /**
   * Builds an `AutomationTriggersService.update` input that only carries the
   * keys the caller actually supplied -- `exactOptionalPropertyTypes` means
   * a present-but-`undefined` key must be omitted entirely rather than
   * assigned `undefined`, mirroring `SavedViewsController.toUpdateInput`'s
   * exact reasoning.
   */
  private toUpdateInput(body: UpdateTriggerInput): UpdateTriggerCommandInput {
    const input: UpdateTriggerCommandInput = {};

    if (body.name !== undefined) {
      input.name = body.name;
    }

    if (body.spec !== undefined) {
      input.spec = body.spec;
    }

    return input;
  }
}
