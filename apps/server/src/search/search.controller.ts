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

import { UnauthorizedError } from '@luminaos/shared';

import { ConnectedSearchService } from './connected-search.service.js';
import { searchExternalSchema } from './dto/search-external.schema.js';
import { searchWorkspaceSchema } from './dto/search-workspace.schema.js';
import { SearchService } from './search.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { ConnectedSearchResponse } from './connected-search.service.js';
import type { SearchExternalInput } from './dto/search-external.schema.js';
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
  constructor(
    private readonly searchService: SearchService,
    private readonly connectedSearchService: ConnectedSearchService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async search(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(searchWorkspaceSchema)) body: SearchWorkspaceInput,
  ): Promise<{ results: SearchResult[] }> {
    const results = await this.searchService.search(workspaceId, body.query, body.limit);

    return { results };
  }

  /**
   * F2-T11 (ADR-0027 §c): a SEPARATE route from the internal `/search`
   * above, deliberately not merged into one response (see ADR-0027 §c's
   * latency-isolation rationale). `userId` ALWAYS comes from the
   * authenticated session via `@CurrentUser()` -- never from the body/query
   * (the cross-user isolation Kabul Kriteri).
   */
  @Post('external')
  @HttpCode(HttpStatus.OK)
  async searchExternal(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() currentUser: { id: string; email: string } | undefined,
    @Body(new ZodValidationPipe(searchExternalSchema)) body: SearchExternalInput,
  ): Promise<ConnectedSearchResponse> {
    // `SessionAuthGuard` always sets `req.user` before this handler runs, so
    // `currentUser` is only `undefined` in the type system, never at
    // runtime — but we still fail closed (401) rather than assert it away
    // (mirrors `MeController.getMe`'s identical convention).
    if (!currentUser) {
      throw new UnauthorizedError();
    }

    return this.connectedSearchService.searchExternal(workspaceId, currentUser.id, body.query);
  }
}
