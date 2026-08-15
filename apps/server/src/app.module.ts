import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import cookieParser from 'cookie-parser';

import { AppController } from './app.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { AvailabilityModule } from './availability/availability.module.js';
import { CalendarModule } from './calendar/calendar.module.js';
import { CommandsModule } from './commands/commands.module.js';
import { AppErrorFilter } from './common/app-error.filter.js';
import { corsMiddleware } from './common/cors.middleware.js';
import { ContextModule } from './context/context.module.js';
import { DbModule } from './db/db.module.js';
import { DocsModule } from './docs/docs.module.js';
import { ExportModule } from './export/export.module.js';
import { FieldsModule } from './fields/fields.module.js';
import { HealthModule } from './health/health.module.js';
import { ObjectsModule } from './objects/objects.module.js';
import { HttpTracingInterceptor } from './observability/http-tracing.interceptor.js';
import { LoggingModule } from './observability/logging.module.js';
import { TracingModule } from './observability/tracing.module.js';
import { QAModule } from './qa/qa.module.js';
import { RedisModule } from './redis/redis.module.js';
import { RelationsModule } from './relations/relations.module.js';
import { SavedViewsModule } from './saved-views/saved-views.module.js';
import { SearchModule } from './search/search.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';

import type { MiddlewareConsumer, NestModule } from '@nestjs/common';

/**
 * Cookie parsing and the global error filter are registered here (not just in
 * `main.ts`) so any host that builds `AppModule` directly — including
 * `Test.createTestingModule` in integration tests — gets the same request
 * pipeline as the real server. Registering them only in `main.ts`'s
 * `bootstrap()` silently skips them for any other entry point. `LoggingModule`/
 * `TracingModule` follow the same reasoning: they must be importable/
 * overridable from a testing module built directly off `AppModule`.
 */
@Module({
  imports: [
    LoggingModule,
    TracingModule,
    DbModule,
    RedisModule,
    HealthModule,
    AuthModule,
    WorkspacesModule,
    CalendarModule,
    AvailabilityModule,
    ObjectsModule,
    ContextModule,
    DocsModule,
    ExportModule,
    FieldsModule,
    RelationsModule,
    SavedViewsModule,
    SearchModule,
    QAModule,
    CommandsModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_FILTER, useClass: AppErrorFilter },
    { provide: APP_INTERCEPTOR, useClass: HttpTracingInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(corsMiddleware, cookieParser()).forRoutes('*');
  }
}
