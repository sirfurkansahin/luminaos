import { Module } from '@nestjs/common';

import { SavedViewsController } from './saved-views.controller.js';
import { SavedViewsService } from './saved-views.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

@Module({
  imports: [EventStoreModule, DbModule, AuthModule],
  controllers: [SavedViewsController],
  providers: [SavedViewsService, WorkspaceMembershipGuard],
})
export class SavedViewsModule {}
