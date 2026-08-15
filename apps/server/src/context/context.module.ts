import { Module } from '@nestjs/common';

import { ContextGraphSyncWorker } from './context-graph-sync.worker.js';
import { ContextController } from './context.controller.js';
import { ContextService } from './context.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { ObjectsModule } from '../objects/objects.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * Wires F2-T2 (ADR-0018) into `AppModule`: `ContextController` (the read
 * endpoint), `ContextService` (query/RBAC-filter logic, reuses
 * `ObjectsService` from `ObjectsModule` for the root entity's own
 * `title`/`fieldValues`), and `ContextGraphSyncWorker` (the periodic
 * `ContextGraphProjection` catch-up worker, Karar a) -- mirrors
 * `RelationsModule`'s wiring pattern.
 */
@Module({
  imports: [EventStoreModule, DbModule, AuthModule, ObjectsModule],
  controllers: [ContextController],
  providers: [
    ContextService,
    ContextGraphSyncWorker,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
  ],
})
export class ContextModule {}
