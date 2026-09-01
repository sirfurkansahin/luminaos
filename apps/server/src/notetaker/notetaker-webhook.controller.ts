import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import { notetakerWebhookSchema } from './dto/notetaker-webhook.schema.js';
import { MeetingsService } from './meetings.service.js';
import { NotetakerWebhookAuthGuard } from './notetaker-webhook-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

import type { NotetakerWebhookInput } from './dto/notetaker-webhook.schema.js';

/**
 * `POST /webhooks/notetaker` (ADR-0030 §f/§g): NO `:workspaceId` in the path
 * -- the bot vendor's webhook has no user identity, only the shared HMAC
 * secret `NotetakerWebhookAuthGuard` verifies. Deliberately the ONLY guard
 * here (no `SessionAuthGuard`/`WorkspaceMembershipGuard`).
 */
@Controller('webhooks/notetaker')
@UseGuards(NotetakerWebhookAuthGuard)
export class NotetakerWebhookController {
  constructor(private readonly meetingsService: MeetingsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Body(new ZodValidationPipe(notetakerWebhookSchema)) body: NotetakerWebhookInput,
  ): Promise<{ received: boolean }> {
    const update: {
      status: 'kaydedildi' | 'basarisiz';
      transcriptText?: string | null;
      providerRecordingUrl?: string | null;
    } = { status: body.status };

    if ('transcriptText' in body && body.transcriptText !== undefined) {
      update.transcriptText = body.transcriptText;
    }

    if ('providerRecordingUrl' in body && body.providerRecordingUrl !== undefined) {
      update.providerRecordingUrl = body.providerRecordingUrl;
    }

    await this.meetingsService.applyWebhookUpdate(body.providerMeetingRef, update);

    return { received: true };
  }
}
