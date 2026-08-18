import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { toMemoryRecordJsonLd } from '@luminaos/memory';
import type { MemoryRecord, MemoryRecordJsonLd } from '@luminaos/memory';
import { UnauthorizedError } from '@luminaos/shared';

import {
  memoryRecordContentSchema,
  type MemoryRecordContentInput,
} from './dto/memory-record-content.schema.js';
import {
  memoryRecordExportQuerySchema,
  type MemoryRecordExportQueryInput,
} from './dto/memory-record-export-query.schema.js';
import { MemoryRecordsService } from './memory-records.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { Request } from 'express';

/**
 * F2-T5 PR2 (ADR-0022 Karar f): `workspaces/:workspaceId/memory` — all four
 * routes are self-service by construction. `req.user.id` (the SESSION user,
 * set by `SessionAuthGuard`) is the ONLY source of user identity; a `userId`
 * key in the POST/PATCH body, if present, is validated away by
 * `memoryRecordContentSchema` (not `.strict()`, so it's silently stripped
 * rather than rejected) and never consulted here — mirrors
 * `desktop-signal-consents.controller.ts`'s exact guard/pipe wiring.
 */
@Controller('workspaces/:workspaceId/memory')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class MemoryRecordsController {
  constructor(private readonly memoryRecordsService: MemoryRecordsService) {}

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
  ): Promise<{ records: MemoryRecord[] }> {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const records = await this.memoryRecordsService.list(workspaceId, req.user.id);

    return { records };
  }

  @Get('export')
  async export(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(memoryRecordExportQuerySchema))
    _query: MemoryRecordExportQueryInput,
    @Req() req: Request,
  ): Promise<{ records: MemoryRecordJsonLd[] }> {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const records = await this.memoryRecordsService.list(workspaceId, req.user.id);

    return { records: records.map(toMemoryRecordJsonLd) };
  }

  @Post()
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(memoryRecordContentSchema)) body: MemoryRecordContentInput,
    @Req() req: Request,
  ): Promise<{ record: MemoryRecord }> {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const record = await this.memoryRecordsService.create(workspaceId, req.user.id, body.content);

    return { record };
  }

  @Patch(':id')
  async edit(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(memoryRecordContentSchema)) body: MemoryRecordContentInput,
    @Req() req: Request,
  ): Promise<{ record: MemoryRecord }> {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const record = await this.memoryRecordsService.edit(workspaceId, req.user.id, id, body.content);

    return { record };
  }

  @Delete(':id')
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<Record<string, never>> {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    await this.memoryRecordsService.delete(workspaceId, req.user.id, id);

    return {};
  }
}
