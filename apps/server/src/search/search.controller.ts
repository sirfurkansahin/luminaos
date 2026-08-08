import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';

import { searchWorkspaceSchema } from './dto/search-workspace.schema.js';
import { SearchService } from './search.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { SearchWorkspaceInput } from './dto/search-workspace.schema.js';
import type { SearchResult } from './search.service.js';

/**
 * F1-T13 PR5 (ADR-0013 §b/§f): mirrors `ObjectsController`'s exact
 * class-level guard stack + PARAMETER-level `@Body(new ZodValidationPipe(...))`
 * convention — NOT a method-level `@UsePipes`, per the F1-T12 PR5a
 * pipe-scoping lesson (a method-level `@UsePipes` would also wrongly apply to
 * `@Param`).
 */
@Controller('workspaces/:workspaceId/search')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async search(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(searchWorkspaceSchema)) body: SearchWorkspaceInput,
  ): Promise<{ results: SearchResult[] }> {
    const results = await this.searchService.search(workspaceId, body.query, body.limit);

    return { results };
  }
}
