import { Module } from '@nestjs/common';

import { AIUsageService } from './ai-usage.service.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';

/**
 * F1-T15 PR2 (ADR-0014 §a): `AIUsageService` is a plain injectable class
 * (unlike `AIProviderModule`'s `AI_PROVIDER`, no DI token/factory is needed
 * here) -- `providers`+`exports` is enough for any importing module
 * (`ObjectsModule` today; a future `QAModule`/conversation-command module
 * later) to inject it directly by class. `DbModule`/`EventStoreModule` are
 * imported here (rather than assumed to already be in scope from the
 * importing module) so `AIUsageModule` is self-contained and can be imported
 * on its own by any future module, mirroring `EventStoreModule`'s own
 * "import what your providers need" convention.
 */
@Module({
  imports: [DbModule, EventStoreModule],
  providers: [AIUsageService],
  exports: [AIUsageService],
})
export class AIUsageModule {}
