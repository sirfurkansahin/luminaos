import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';

import { UnauthorizedError } from '@luminaos/shared';

import { setAvailabilitySchema } from './dto/set-availability.schema.js';
import { UserAvailabilityService } from './user-availability.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { SetAvailabilityInput } from './dto/set-availability.schema.js';
import type { UserAvailabilitySnapshot } from './user-availability.service.js';
import type { Request } from 'express';

@Controller('workspaces/:workspaceId/availability')
export class AvailabilityController {
  constructor(private readonly userAvailabilityService: UserAvailabilityService) {}

  @Put()
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  async setStatus(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(setAvailabilitySchema)) body: SetAvailabilityInput,
    @Req() req: Request,
  ): Promise<{ availability: UserAvailabilitySnapshot }> {
    // `WorkspaceMembershipGuard` always sets `req.membership` before this
    // handler runs (it throws otherwise) — fail closed rather than assert.
    if (!req.membership) {
      throw new UnauthorizedError();
    }

    // `SessionAuthGuard` always sets `req.user` before this handler runs —
    // fail closed (401) rather than assert it away, mirroring
    // `calendar-accounts.controller.ts`'s handling of the same guarantee.
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const availability = await this.userAvailabilityService.setStatus(
      req.user.id,
      workspaceId,
      body.status,
      body.until,
    );

    return { availability };
  }

  @Get()
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  async get(@Req() req: Request): Promise<{ availability: UserAvailabilitySnapshot | null }> {
    if (!req.membership) {
      throw new UnauthorizedError();
    }

    if (!req.user) {
      throw new UnauthorizedError();
    }

    const availability = await this.userAvailabilityService.get(req.user.id);

    return { availability };
  }
}
