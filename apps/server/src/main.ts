import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  // `bufferLogs: true` holds Nest's own bootstrap-time log lines until
  // `app.useLogger()` is called below, so they go through the real
  // structured/redacted pino pipeline too instead of Nest's default console
  // logger.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  await app.listen(3000);
}

void bootstrap();
