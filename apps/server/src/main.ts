import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import { resolveListenPort } from './config/listen-port.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap(): Promise<void> {
  const port = resolveListenPort(process.env['PORT']);
  // `bufferLogs: true` holds Nest's own bootstrap-time log lines until
  // `app.useLogger()` is called below, so they go through the real
  // structured/redacted pino pipeline too instead of Nest's default console
  // logger.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(app.get(Logger));

  // Production traffic reaches Express through a loopback reverse proxy
  // (Caddy in the zero-cost deployment). Trusting only loopback lets req.ip
  // use Caddy's appended client address without trusting a header supplied by
  // a direct remote caller.
  app.set('trust proxy', 'loopback');

  // Ensure `OnModuleDestroy` hooks fire on SIGTERM/SIGINT so the doc-collab
  // gateway can flush/close cleanly (PR4b adds the synchronous snapshot flush).
  app.enableShutdownHooks();

  await app.listen(port, '0.0.0.0');
}

void bootstrap();
