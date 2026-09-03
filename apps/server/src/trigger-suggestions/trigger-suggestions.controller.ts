import {
  Body,
  Controller,
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

import { decideTriggerSuggestionSchema } from './dto/decide-trigger-suggestion.schema.js';
import { TriggerSuggestionsService } from './trigger-suggestions.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { DecideTriggerSuggestionInput } from './dto/decide-trigger-suggestion.schema.js';
import type { TriggerTemplateSuggestionSummary } from './trigger-suggestions.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * `/workspaces/:workspaceId/trigger-suggestions` (F2-T17 PR2, ADR-0034) --
 * mirrors `AutomationTriggersController`'s exact shape (full guard stack at
 * the class level, `requireActorValue`/`requireRole` helpers copied
 * verbatim). Per ADR-0034 §a, `member`+ may read (`list`), `admin`+ may write
 * (`runAnalysis`/`decide`) -- a flat `hasAtLeastRole` check inside
 * `TriggerSuggestionsService`, not here.
 */
@Controller('workspaces/:workspaceId/trigger-suggestions')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class TriggerSuggestionsController {
  constructor(private readonly triggerSuggestionsService: TriggerSuggestionsService) {}

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
  ): Promise<{ suggestions: TriggerTemplateSuggestionSummary[] }> {
    const callerRole = this.requireRole(req);

    const suggestions = await this.triggerSuggestionsService.list(workspaceId, callerRole);

    return { suggestions };
  }

  @Post('analyze')
  @HttpCode(HttpStatus.CREATED)
  async runAnalysis(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
  ): Promise<{ suggestions: TriggerTemplateSuggestionSummary[] }> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    const suggestions = await this.triggerSuggestionsService.runAnalysis(
      workspaceId,
      actor,
      callerRole,
    );

    return { suggestions };
  }

  @Post(':suggestionId/decide')
  @HttpCode(HttpStatus.OK)
  async decide(
    @Param('workspaceId') workspaceId: string,
    @Param('suggestionId') suggestionId: string,
    @Body(new ZodValidationPipe(decideTriggerSuggestionSchema)) body: DecideTriggerSuggestionInput,
    @Req() req: Request,
  ): Promise<{ suggestion: TriggerTemplateSuggestionSummary }> {
    const actor = this.requireActorValue(req);
    const callerRole = this.requireRole(req);

    const suggestion = await this.triggerSuggestionsService.decide(
      workspaceId,
      actor,
      callerRole,
      suggestionId,
      body.decision,
    );

    return { suggestion };
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs --
   * fail closed (401) rather than assert it away, mirroring
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
