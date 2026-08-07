import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { UnauthorizedError } from '@luminaos/shared';

import { CalendarAccountsService } from './calendar-accounts.service.js';
import { connectCalendarAccountSchema } from './dto/connect-calendar-account.schema.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { CalendarAccountSummary } from './calendar-accounts.service.js';
import type { ConnectCalendarAccountInput } from './dto/connect-calendar-account.schema.js';
import type { Request } from 'express';

@Controller('workspaces/:workspaceId/calendar/accounts')
export class CalendarAccountsController {
  constructor(private readonly calendarAccountsService: CalendarAccountsService) {}

  @Post()
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  @HttpCode(HttpStatus.CREATED)
  async connect(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(connectCalendarAccountSchema)) body: ConnectCalendarAccountInput,
    @Req() req: Request,
  ): Promise<{ account: CalendarAccountSummary }> {
    // `WorkspaceMembershipGuard` always sets `req.membership` before this
    // handler runs (it throws otherwise) — fail closed rather than assert.
    if (!req.membership) {
      throw new UnauthorizedError();
    }

    // `SessionAuthGuard` always sets `req.user` before this handler runs —
    // fail closed (401) rather than assert it away, mirroring
    // `workspaces.controller.ts`'s handling of the same guarantee.
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const account = await this.calendarAccountsService.connect(
      workspaceId,
      req.user.id,
      body.provider,
    );

    return { account };
  }

  @Get()
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Req() req: Request,
  ): Promise<{ accounts: CalendarAccountSummary[] }> {
    if (!req.membership) {
      throw new UnauthorizedError();
    }

    const accounts = await this.calendarAccountsService.list(workspaceId);

    return { accounts };
  }

  @Delete(':accountId')
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnect(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Req() req: Request,
  ): Promise<void> {
    if (!req.membership) {
      throw new UnauthorizedError();
    }

    await this.calendarAccountsService.disconnect(workspaceId, accountId);
  }
}
