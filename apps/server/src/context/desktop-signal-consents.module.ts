import { Module } from '@nestjs/common';

import { DesktopSignalConsentsController } from './desktop-signal-consents.controller.js';
import { DesktopSignalConsentsService } from './desktop-signal-consents.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F2-T3 PR1 (ADR-0020 Karar a): wires the desktop-signal-consent HTTP surface
 * into `AppModule`. `WorkspaceMembershipGuard`/`WorkspaceMembershipService`
 * are redeclared as providers here rather than imported via
 * `WorkspacesModule` — mirroring `../availability/availability.module.ts`'s
 * established pattern — because `WorkspacesModule` only exports
 * `WorkspaceMembershipService`, not the guard.
 */
@Module({
  imports: [DbModule, AuthModule, EventStoreModule],
  controllers: [DesktopSignalConsentsController],
  providers: [DesktopSignalConsentsService, WorkspaceMembershipGuard, WorkspaceMembershipService],
  // Exported (F2-T3 PR2) so `DesktopSignalsModule` can inject
  // `DesktopSignalConsentsService` directly for its ingestion consent-gate
  // check, without duplicating this module's own DB/event-store wiring.
  exports: [DesktopSignalConsentsService],
})
export class DesktopSignalConsentsModule {}
