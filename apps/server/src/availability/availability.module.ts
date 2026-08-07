import { Module } from '@nestjs/common';

import { AvailabilityController } from './availability.controller.js';
import { UserAvailabilityService } from './user-availability.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * `WorkspaceMembershipGuard`/`WorkspaceMembershipService` are redeclared as
 * providers here rather than imported via `WorkspacesModule` — mirroring the
 * established pattern in `../calendar/calendar.module.ts`/
 * `../relations/relations.module.ts` — because `WorkspacesModule` only
 * exports `WorkspaceMembershipService`, not the guard.
 */
@Module({
  imports: [DbModule, AuthModule, EventStoreModule],
  controllers: [AvailabilityController],
  providers: [UserAvailabilityService, WorkspaceMembershipGuard, WorkspaceMembershipService],
})
export class AvailabilityModule {}
