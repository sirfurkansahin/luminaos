import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  // `bufferLogs: true` holds Nest's own bootstrap-time log lines until
  // `app.useLogger()` is called below, so they go through the real
  // structured/redacted pino pipeline too instead of Nest's default console
  // logger.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));

  // Ensure `OnModuleDestroy` hooks fire on SIGTERM/SIGINT so the doc-collab
  // gateway can flush/close cleanly (PR4b adds the synchronous snapshot flush).
  app.enableShutdownHooks();

  await app.listen(3000);
}

void bootstrap();
