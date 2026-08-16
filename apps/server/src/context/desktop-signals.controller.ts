import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';

import { UnauthorizedError } from '@luminaos/shared';

import { DesktopSignalsService } from './desktop-signals.service.js';
import { captureDesktopSignalSchema } from './dto/capture-desktop-signal.schema.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { CaptureDesktopSignalInput } from './dto/capture-desktop-signal.schema.js';
import type { Request } from 'express';

/**
 * F2-T3 PR2 (ADR-0020 Karar b/c/d): self-service by construction, same as
 * PR1's consent routes — `req.user.id` (the SESSION user, set by
 * `SessionAuthGuard`) is the ONLY source of user identity. A `userId` key in
 * the POST body, if present, is validated away by `captureDesktopSignalSchema`
 * (not `.strict()`, so it's silently stripped rather than rejected) and never
 * consulted here.
 */
@Controller('workspaces/:workspaceId/context/desktop-signals')
export class DesktopSignalsController {
  constructor(private readonly desktopSignalsService: DesktopSignalsService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  async capture(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(captureDesktopSignalSchema))
    body: CaptureDesktopSignalInput,
    @Req() req: Request,
  ): Promise<{ captured: true }> {
    // `WorkspaceMembershipGuard` always sets `req.membership` before this
    // handler runs (it throws otherwise) — fail closed rather than assert.
    if (!req.membership) {
      throw new UnauthorizedError();
    }

    // `SessionAuthGuard` always sets `req.user` before this handler runs —
    // fail closed (401) rather than assert it away, mirroring
    // `DesktopSignalConsentsController`'s handling of the same guarantee.
    if (!req.user) {
      throw new UnauthorizedError();
    }

    await this.desktopSignalsService.capture(workspaceId, req.user.id, body.signalType, body.value);

    return { captured: true };
  }
}
