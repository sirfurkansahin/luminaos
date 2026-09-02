import {
  Body,
  Controller,
  Delete,
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

import { createWebhookSubscriptionSchema } from './dto/create-webhook-subscription.schema.js';
import {
  WebhookSubscriptionsService,
  type CreatedWebhookSubscription,
  type WebhookSubscriptionRecord,
} from './webhook-subscriptions.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { CreateWebhookSubscriptionInput } from './dto/create-webhook-subscription.schema.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `/workspaces/:workspaceId/webhooks` -- mirrors
 * `AutomationTriggersController`'s exact `requireActorValue`/`requireRole`
 * private-helper pattern. Per ADR-0033 §g, `admin`+ is required for BOTH
 * reads and writes (deliberately different from
 * `AutomationTriggersController`'s admin-write/member-read split), so the
 * gating is a flat `hasAtLeastRole` check inside
 * `WebhookSubscriptionsService`, not here.
 */
@Controller('workspaces/:workspaceId/webhooks')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class WebhookSubscriptionsController {
  constructor(private readonly webhookSubscriptionsService: WebhookSubscriptionsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(createWebhookSubscriptionSchema))
    body: CreateWebhookSubscriptionInput,
    @Req() req: Request,
  ): Promise<{ subscription: CreatedWebhookSubscription }> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    const subscription = await this.webhookSubscriptionsService.create(
      workspaceId,
      actor,
      callerRole,
      {
        targetUrl: body.targetUrl,
        eventTypes: body.eventTypes,
      },
    );

    return { subscription };
  }

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
  ): Promise<{ subscriptions: WebhookSubscriptionRecord[] }> {
    const callerRole = this.requireRole(req);

    const subscriptions = await this.webhookSubscriptionsService.list(workspaceId, callerRole);

    return { subscriptions };
  }

  @Delete(':subscriptionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('subscriptionId') subscriptionId: string,
    @Req() req: Request,
  ): Promise<void> {
    const callerRole = this.requireRole(req);

    await this.webhookSubscriptionsService.remove(workspaceId, subscriptionId, callerRole);
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs
   * -- fail closed (401) rather than assert it away, mirroring
   * `AutomationTriggersController.requireActorValue`'s exact reasoning.
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
   * reasoning as `AutomationTriggersController.requireRole`.
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
