import { Module } from '@nestjs/common';

import { MockMeetingBotClient } from '@luminaos/integrations';
import type { MeetingBotClient } from '@luminaos/integrations';

import { MEETING_BOT_CLIENT } from './meeting-bot-client.token.js';
import { MeetingInviteController } from './meeting-invite.controller.js';
import { MeetingsService } from './meetings.service.js';
import { NotetakerWebhookAuthGuard } from './notetaker-webhook-auth.guard.js';
import { NotetakerWebhookController } from './notetaker-webhook.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { ObjectsModule } from '../objects/objects.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * PLACEHOLDER wiring (F2-T13 PR3, mirrors `calendar-connector.module.ts`'s
 * exact reasoning): no real vendor adapter exists yet (ADR-0030 §e's
 * "dürüstlük payı" note), so `MEETING_BOT_CLIENT` always resolves to a bare
 * `new MockMeetingBotClient()`. A real adapter (e.g. `RecallMeetingBotClient`)
 * lands as a later, isolated change to this factory only.
 */
@Module({
  imports: [DbModule, AuthModule, ObjectsModule],
  controllers: [MeetingInviteController, NotetakerWebhookController],
  providers: [
    MeetingsService,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
    NotetakerWebhookAuthGuard,
    {
      provide: MEETING_BOT_CLIENT,
      useFactory: (): MeetingBotClient => new MockMeetingBotClient(),
    },
  ],
})
export class NotetakerModule {}
