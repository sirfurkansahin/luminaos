import { Module } from '@nestjs/common';

import { DocumentReconstructionService } from './document-reconstruction.service.js';
import { DbModule } from '../db/db.module.js';

/**
 * F1-T11 PR2: document snapshot persistence. Provides the read-side
 * `DocumentReconstructionService`; the `DocumentSnapshotsProjection` itself is
 * a plain class driven by `ProjectionRunner`, not a DI provider.
 */
@Module({
  imports: [DbModule],
  providers: [DocumentReconstructionService],
  exports: [DocumentReconstructionService],
})
export class DocsModule {}
