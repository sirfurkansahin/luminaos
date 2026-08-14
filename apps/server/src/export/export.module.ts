import { Module } from '@nestjs/common';

import { ExportController } from './export.controller.js';
import { ExportService } from './export.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { DocsModule } from '../docs/docs.module.js';
import { FieldsModule } from '../fields/fields.module.js';
import { ObjectsModule } from '../objects/objects.module.js';
import { RelationsModule } from '../relations/relations.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * `DbModule` is imported directly (mirroring `RelationsModule`/
 * `FieldsModule`) because `WorkspaceMembershipGuard`'s own
 * `WorkspaceMembershipService` dependency needs `DATABASE_CONNECTION`
 * resolvable in this module's injector context, even though `ExportService`
 * itself never touches the DB directly (per ADR-0016 §b, it only composes
 * `ObjectsModule`/`RelationsModule`/`FieldsModule`'s exported services).
 *
 * F1-T18 PR2: `DocsModule` is imported for its exported
 * `DocumentReconstructionService` (`ExportService.exportMarkdown`'s/
 * `exportJson`'s doc-content enrichment read the latest Yjs snapshot the
 * same way `DocsModule`'s own read paths do).
 */
@Module({
  imports: [AuthModule, DbModule, DocsModule, ObjectsModule, RelationsModule, FieldsModule],
  controllers: [ExportController],
  providers: [ExportService, WorkspaceMembershipGuard, WorkspaceMembershipService],
})
export class ExportModule {}
