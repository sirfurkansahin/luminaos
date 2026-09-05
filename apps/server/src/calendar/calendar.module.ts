import { Module } from '@nestjs/common';

import { CalendarAccountsController } from './calendar-accounts.controller.js';
import { CalendarAccountsService } from './calendar-accounts.service.js';
import { CalendarConnectorModule } from './calendar-connector.module.js';
import { CalendarEventsController } from './calendar-events.controller.js';
import { CalendarEventsService } from './calendar-events.service.js';
import { CalendarSyncPollerService } from './calendar-sync-poller.service.js';
import { CalendarTokenEncryptionService } from './calendar-token-encryption.service.js';
import { CalendarTokenRefreshService } from './calendar-token-refresh.service.js';
import { ConflictDetectionService } from './conflict-detection.service.js';
import { ConflictsController } from './conflicts.controller.js';
import { TimeBlockPushService } from './timeblock-push.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * `WorkspaceMembershipGuard`/`WorkspaceMembershipService` are redeclared as
 * providers here rather than imported via `WorkspacesModule` — mirroring the
 * established pattern in `../relations/relations.module.ts` and
 * `../saved-views/saved-views.module.ts` — because `WorkspacesModule` only
 * exports `WorkspaceMembershipService`, not the guard, so importing it alone
 * would leave `WorkspaceMembershipGuard` unresolvable in this module's DI
 * context for `@UseGuards(...)`.
 */
@Module({
  imports: [DbModule, AuthModule, CalendarConnectorModule],
  controllers: [CalendarAccountsController, CalendarEventsController, ConflictsController],
  providers: [
    CalendarTokenEncryptionService,
    CalendarAccountsService,
    CalendarTokenRefreshService,
    CalendarSyncPollerService,
    CalendarEventsService,
    ConflictDetectionService,
    TimeBlockPushService,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
  ],
  exports: [TimeBlockPushService, CalendarEventsService],
})
export class CalendarModule {}
