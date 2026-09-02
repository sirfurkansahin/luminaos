import { Module } from '@nestjs/common';

import { WebhookDeliveryWorker } from './webhook-delivery-worker.service.js';
import { WebhookDeliveryService } from './webhook-delivery.service.js';
import { WebhookSubscriptionsController } from './webhook-subscriptions.controller.js';
import { WebhookSubscriptionsService } from './webhook-subscriptions.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { env } from '../config/env.js';
import { DbModule } from '../db/db.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

@Module({
  imports: [DbModule, AuthModule],
  controllers: [WebhookSubscriptionsController],
  providers: [
    WebhookSubscriptionsService,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
    {
      // Security-review finding (F2-T16 PR2): passes `env.encryptionKey`
      // straight through WITHOUT an eager "throw if unset" check -- mirrors
      // `env.ts`'s own documented convention ("a deployment without calendar
      // features configured must not crash boot over this"). NestJS
      // instantiates every provider in an unconditionally-imported module
      // (this one, from `AppModule`) eagerly at bootstrap, so a factory that
      // throws here would fail the ENTIRE server's startup over a
      // webhook-only config gap. `WebhookDeliveryService.deliver()` checks
      // for `undefined` itself and fails that one delivery attempt lazily
      // instead (already absorbed by `WebhookDeliveryWorker`'s per-row
      // try/catch).
      provide: WebhookDeliveryService,
      useFactory: (): WebhookDeliveryService =>
        new WebhookDeliveryService({ encryptionKey: env.encryptionKey }),
    },
    WebhookDeliveryWorker,
  ],
})
export class WebhooksModule {}
