import { Module } from '@nestjs/common';

import { ObjectsController } from './objects.controller.js';
import { ObjectsService } from './objects.service.js';
import { AIProviderModule } from '../ai/ai-provider.module.js';
import { AIRefreshScheduler } from '../ai/ai-refresh-scheduler.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { CalendarModule } from '../calendar/calendar.module.js';
import { env } from '../config/env.js';
import { DbModule } from '../db/db.module.js';
import { EventStoreModule } from '../event-store/event-store.module.js';
import { TaskRecurrenceService } from '../recurrence/task-recurrence.service.js';
import { SearchIndexModule } from '../search/search-index.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

@Module({
  imports: [
    EventStoreModule,
    DbModule,
    AuthModule,
    AIProviderModule,
    CalendarModule,
    SearchIndexModule,
  ],
  controllers: [ObjectsController],
  providers: [
    ObjectsService,
    TaskRecurrenceService,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
    // `AIRefreshScheduler`'s constructor takes a plain `number` (its debounce
    // delay), not an injectable class/token -- Nest's DI cannot resolve a
    // bare `Number` type from constructor-parameter reflection, so this MUST
    // be a factory provider (mirrors `AI_PROVIDER`'s own `useFactory` in
    // `ai-provider.module.ts`) rather than the bare class in this array.
    // This is also the only place `env.aiRefreshDebounceMs` is actually
    // consumed.
    {
      provide: AIRefreshScheduler,
      useFactory: () => new AIRefreshScheduler(env.aiRefreshDebounceMs),
    },
  ],
})
export class ObjectsModule {}
