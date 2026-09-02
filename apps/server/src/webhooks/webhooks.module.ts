import { Module } from '@nestjs/common';

import { WebhookSubscriptionsController } from './webhook-subscriptions.controller.js';
import { WebhookSubscriptionsService } from './webhook-subscriptions.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

@Module({
  imports: [DbModule, AuthModule],
  controllers: [WebhookSubscriptionsController],
  providers: [WebhookSubscriptionsService, WorkspaceMembershipGuard, WorkspaceMembershipService],
})
export class WebhooksModule {}
