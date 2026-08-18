import { Module } from '@nestjs/common';

import { ConnectorCredentialsService } from './connector-credentials.service.js';
import { ConnectorRateLimitService } from './connector-rate-limit.service.js';
import { DbModule } from '../db/db.module.js';

/**
 * F2-T9 PR2 (ADR-0025 §n): wires `ConnectorCredentialsService`/
 * `ConnectorRateLimitService` for DI, mirroring `MemoryModule`'s/
 * `CalendarModule`'s import/provider wiring. No controllers -- this task
 * adds no public REST endpoint (Karar n); F2-T10 will consume these
 * providers directly. `ConnectorHealthService` is deliberately NOT
 * registered here as a Nest provider: it takes a `McpConnectorRegistry`
 * instance (constructed per-registry, not a singleton DI token) as its
 * constructor argument, which does not exist as a wireable dependency until
 * F2-T10 registers real connectors -- registering it here today would only
 * be able to inject an always-empty registry, which is not useful wiring.
 */
@Module({
  imports: [DbModule],
  providers: [ConnectorCredentialsService, ConnectorRateLimitService],
  exports: [ConnectorCredentialsService, ConnectorRateLimitService],
})
export class IntegrationsModule {}
