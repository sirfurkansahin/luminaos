import { Module } from '@nestjs/common';

import { MemoryAccessPolicyController } from './memory-access-policies.controller.js';
import { MemoryAccessPolicyService } from './memory-access-policies.service.js';
import { MemoryRecordsController } from './memory-records.controller.js';
import { MemoryRecordsService } from './memory-records.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F2-T5 PR2 (ADR-0022): wires the Memory Passport HTTP surface into
 * `AppModule`, mirroring `desktop-signal-consents.module.ts`'s exact
 * shape. `WorkspaceMembershipGuard`/`WorkspaceMembershipService` are
 * redeclared as providers here rather than imported via `WorkspacesModule`
 * (which only exports the service, not the guard) — same established
 * pattern.
 */
@Module({
  imports: [DbModule, AuthModule, EventStoreModule],
  controllers: [MemoryRecordsController, MemoryAccessPolicyController],
  providers: [
    MemoryRecordsService,
    MemoryAccessPolicyService,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
  ],
  exports: [MemoryRecordsService, MemoryAccessPolicyService],
})
export class MemoryModule {}
