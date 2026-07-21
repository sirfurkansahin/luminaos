import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import cookieParser from 'cookie-parser';

import { AppController } from './app.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { AppErrorFilter } from './common/app-error.filter.js';
import { DbModule } from './db/db.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';

import type { MiddlewareConsumer, NestModule } from '@nestjs/common';

/**
 * Cookie parsing and the global error filter are registered here (not just in
 * `main.ts`) so any host that builds `AppModule` directly — including
 * `Test.createTestingModule` in integration tests — gets the same request
 * pipeline as the real server. Registering them only in `main.ts`'s
 * `bootstrap()` silently skips them for any other entry point.
 */
@Module({
  imports: [DbModule, AuthModule, WorkspacesModule],
  controllers: [AppController],
  providers: [{ provide: APP_FILTER, useClass: AppErrorFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(cookieParser()).forRoutes('*');
  }
}
