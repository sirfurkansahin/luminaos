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

import { askQuestionSchema } from './dto/ask-question.schema.js';
import { QAService } from './qa.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { AskQuestionInput } from './dto/ask-question.schema.js';
import type { QAPassage } from '../ai/answer-question.js';

/**
 * F1-T15 PR4 (ADR-0014 §a/§b): mirrors `SearchController`'s exact
 * class-level guard stack + PARAMETER-level `@Body(new ZodValidationPipe(...))`
 * convention — NOT a method-level `@UsePipes`, per the F1-T12 PR5a
 * pipe-scoping lesson.
 */
@Controller('workspaces/:workspaceId/qa')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class QAController {
  constructor(private readonly qaService: QAService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async ask(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(askQuestionSchema)) body: AskQuestionInput,
  ): Promise<{ answer: string; sources: QAPassage[] }> {
    return this.qaService.answer(workspaceId, body.question);
  }
}
