import { Module } from '@nestjs/common';

import { FieldDefinitionsService } from './field-definitions.service.js';
import { FieldsController } from './fields.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

@Module({
  imports: [EventStoreModule, DbModule, AuthModule],
  controllers: [FieldsController],
  providers: [FieldDefinitionsService, WorkspaceMembershipGuard],
})
export class FieldsModule {}
