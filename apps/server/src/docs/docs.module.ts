import { Module } from '@nestjs/common';

import { DocCollabGateway } from './doc-collab.gateway.js';
import { DocumentReconstructionService } from './document-reconstruction.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';

/**
 * F1-T11 PR2: document snapshot persistence. Provides the read-side
 * `DocumentReconstructionService`; the `DocumentSnapshotsProjection` itself is
 * a plain class driven by `ProjectionRunner`, not a DI provider.
 *
 * F1-T11 PR4a: adds `DocCollabGateway`, the raw-`ws` Yjs collaboration gateway.
 * It reuses `SessionService` (from `AuthModule`) and `WorkspaceMembershipService`
 * (from `WorkspacesModule`) to authorize WS upgrades exactly as the HTTP layer
 * does (ADR-0011 §(d)).
 */
@Module({
  imports: [DbModule, AuthModule, WorkspacesModule],
  providers: [DocumentReconstructionService, DocCollabGateway],
  exports: [DocumentReconstructionService],
})
export class DocsModule {}
