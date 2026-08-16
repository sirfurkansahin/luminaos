import { Module } from '@nestjs/common';

import { DesktopSignalConsentsModule } from './desktop-signal-consents.module.js';
import { DesktopSignalsController } from './desktop-signals.controller.js';
import { DesktopSignalsService } from './desktop-signals.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F2-T3 PR2 (ADR-0020 Karar b/c/d): wires the desktop-signal ingestion HTTP
 * surface into `AppModule`. Imports `DesktopSignalConsentsModule` for
 * `DesktopSignalConsentsService` (consent-gate check on every capture).
 * `WorkspaceMembershipGuard`/`WorkspaceMembershipService` are redeclared as
 * providers here rather than pulled in transitively — mirrors
 * `DesktopSignalConsentsModule`'s own established pattern exactly.
 */
@Module({
  imports: [DbModule, AuthModule, EventStoreModule, DesktopSignalConsentsModule],
  controllers: [DesktopSignalsController],
  providers: [DesktopSignalsService, WorkspaceMembershipGuard, WorkspaceMembershipService],
})
export class DesktopSignalsModule {}
