import { Module } from '@nestjs/common';

import { WorkspaceMembershipGuard } from './workspace-membership.guard.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { FieldsModule } from '../fields/fields.module.js';

@Module({
  imports: [DbModule, AuthModule, FieldsModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceMembershipGuard],
})
export class WorkspacesModule {}
