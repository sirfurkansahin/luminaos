import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';

import { UnauthorizedError } from '@luminaos/shared';

import { DesktopSignalConsentsService } from './desktop-signal-consents.service.js';
import {
  desktopSignalTypeSchema,
  grantDesktopSignalConsentSchema,
} from './dto/grant-desktop-signal-consent.schema.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { DesktopSignalConsentSnapshot } from './desktop-signal-consents.service.js';
import type { GrantDesktopSignalConsentInput } from './dto/grant-desktop-signal-consent.schema.js';
import type { Request } from 'express';

/**
 * F2-T3 PR1 (ADR-0020 Karar a): all three routes are self-service by
 * construction — `req.user.id` (the SESSION user, set by `SessionAuthGuard`)
 * is the ONLY source of user identity. A `userId` key in the POST body, if
 * present, is validated away by `grantDesktopSignalConsentSchema` (not
 * `.strict()`, so it's silently stripped rather than rejected) and never
 * consulted here.
 */
@Controller('workspaces/:workspaceId/context/desktop-signal-consents')
export class DesktopSignalConsentsController {
  constructor(private readonly desktopSignalConsentsService: DesktopSignalConsentsService) {}

  @Post()
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  async grant(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(grantDesktopSignalConsentSchema))
    body: GrantDesktopSignalConsentInput,
    @Req() req: Request,
  ): Promise<{ consent: DesktopSignalConsentSnapshot }> {
    // `WorkspaceMembershipGuard` always sets `req.membership` before this
    // handler runs (it throws otherwise) — fail closed rather than assert.
    if (!req.membership) {
      throw new UnauthorizedError();
    }

    // `SessionAuthGuard` always sets `req.user` before this handler runs —
    // fail closed (401) rather than assert it away, mirroring
    // `AvailabilityController`'s handling of the same guarantee.
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const consent = await this.desktopSignalConsentsService.grant(
      workspaceId,
      req.user.id,
      body.signalType,
    );

    return { consent };
  }

  @Delete(':signalType')
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  async revoke(
    @Param('workspaceId') workspaceId: string,
    @Param('signalType', new ZodValidationPipe(desktopSignalTypeSchema)) signalType: string,
    @Req() req: Request,
  ): Promise<{ consent: DesktopSignalConsentSnapshot }> {
    if (!req.membership) {
      throw new UnauthorizedError();
    }

    if (!req.user) {
      throw new UnauthorizedError();
    }

    const consent = await this.desktopSignalConsentsService.revoke(
      workspaceId,
      req.user.id,
      signalType,
    );

    return { consent };
  }

  @Get(':signalType')
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  async get(
    @Param('workspaceId') workspaceId: string,
    @Param('signalType', new ZodValidationPipe(desktopSignalTypeSchema)) signalType: string,
    @Req() req: Request,
  ): Promise<{ consent: DesktopSignalConsentSnapshot | null }> {
    if (!req.membership) {
      throw new UnauthorizedError();
    }

    if (!req.user) {
      throw new UnauthorizedError();
    }

    const consent = await this.desktopSignalConsentsService.get(
      workspaceId,
      req.user.id,
      signalType,
    );

    return { consent };
  }
}
