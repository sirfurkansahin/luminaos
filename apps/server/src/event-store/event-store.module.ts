import { Module } from '@nestjs/common';

import { EventStoreService } from './event-store.service.js';
import { ProjectionRunner } from './projections/projection-runner.service.js';
import { DbModule } from '../db/db.module.js';

/**
 * Wires the F0-T6 event store (`EventStoreService`) and projection runner
 * (`ProjectionRunner`) into Nest DI. Neither was previously bound to any
 * module/`AppModule` — only integration tests constructed them directly (see
 * `EventStoreService`'s own doc comment on `DATABASE_CONNECTION`). F1-T1 is
 * the first feature to need them from within a real Nest request pipeline
 * (per ADR-0003 "Devralınan altyapı ve sınır").
 *
 * Deliberately does NOT provide/wire `WorkspaceEventCounterProjection` —
 * that example projection stays out of the running application (out of
 * scope for this task).
 */
@Module({
  imports: [DbModule],
  providers: [EventStoreService, ProjectionRunner],
  exports: [EventStoreService, ProjectionRunner],
})
export class EventStoreModule {}
