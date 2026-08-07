import { Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';

import { UnauthorizedError } from '@luminaos/shared';

import { CalendarEventsService } from './calendar-events.service.js';
import { listCalendarEventsSchema } from './dto/list-calendar-events.schema.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { CachedCalendarEvent } from './calendar-events.service.js';
import type { ListCalendarEventsQuery } from './dto/list-calendar-events.schema.js';
import type { Request } from 'express';

@Controller('workspaces/:workspaceId/calendar/events')
export class CalendarEventsController {
  constructor(private readonly calendarEventsService: CalendarEventsService) {}

  @Get()
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query(new ZodValidationPipe(listCalendarEventsSchema)) query: ListCalendarEventsQuery,
    @Req() req: Request,
  ): Promise<{ events: CachedCalendarEvent[] }> {
    // `WorkspaceMembershipGuard` always sets `req.membership` before this
    // handler runs (it throws otherwise) — fail closed rather than assert.
    if (!req.membership) {
      throw new UnauthorizedError();
    }

    const events = await this.calendarEventsService.listCachedEvents(workspaceId, query);

    return { events };
  }
}
