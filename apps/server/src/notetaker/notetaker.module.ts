import { forwardRef, Module } from '@nestjs/common';

import { MockMeetingBotClient } from '@luminaos/integrations';
import type { MeetingBotClient } from '@luminaos/integrations';

import { MEETING_BOT_CLIENT } from './meeting-bot-client.token.js';
import { MeetingInviteController } from './meeting-invite.controller.js';
import { MeetingRetentionPreferenceController } from './meeting-retention-preference.controller.js';
import { MeetingRetentionPreferenceService } from './meeting-retention-preference.service.js';
import { MeetingRetentionSweeperService } from './meeting-retention-sweeper.service.js';
import { MeetingsService } from './meetings.service.js';
import { NotetakerWebhookAuthGuard } from './notetaker-webhook-auth.guard.js';
import { NotetakerWebhookController } from './notetaker-webhook.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { CommandsModule } from '../commands/commands.module.js';
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
/**
 * `CommandsModule` is imported via `forwardRef()` (F3-T5 PR2, ADR-0039): once
 * `CommandsModule` started importing `CommentsModule` (for
 * `CommandsService.notifyAutonomousAction`'s `CommentsService`), a genuine
 * 4-module ES-import cycle opened up through this module too --
 * `CommandsModule -> CommentsModule -> SkillsModule -> NotetakerModule ->
 * CommandsModule` (`SkillsModule` imports both `NotetakerModule` and
 * `CommandsModule`) -- verified by actually booting the full `AppModule`,
 * which threw a `TDZ`/`undefined`-module error at this exact edge without
 * this `forwardRef()`.
 */
@Module({
  imports: [DbModule, AuthModule, ObjectsModule, forwardRef(() => CommandsModule)],
  controllers: [
    MeetingInviteController,
    NotetakerWebhookController,
    MeetingRetentionPreferenceController,
  ],
  providers: [
    MeetingsService,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
    NotetakerWebhookAuthGuard,
    MeetingRetentionPreferenceService,
    MeetingRetentionSweeperService,
    {
      provide: MEETING_BOT_CLIENT,
      useFactory: (): MeetingBotClient => new MockMeetingBotClient(),
    },
  ],
  exports: [MeetingsService],
})
export class NotetakerModule {}
