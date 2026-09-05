import { Module } from '@nestjs/common';

import { ConnectedSearchService } from './connected-search.service.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';
import { EmbeddingProviderModule } from '../ai/embedding-provider.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { ConnectorCredentialsService } from '../integrations/connector-credentials.service.js';
import { ConnectorRateLimitService } from '../integrations/connector-rate-limit.service.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

/**
 * F1-T13 PR5 (ADR-0013 §b/§f): wires the `POST /workspaces/:workspaceId/search`
 * route. `WorkspaceMembershipGuard`/`WorkspaceMembershipService` are provided
 * directly here rather than by importing `WorkspacesModule`, mirroring
 * `ObjectsModule`'s identical pattern.
 *
 * F2-T11 (ADR-0027 §a/§c): also wires the sibling `POST
 * /workspaces/:workspaceId/search/external` route's `ConnectedSearchService`.
 * `IntegrationsModule` is imported for `ConnectorCredentialsService`/
 * `ConnectorRateLimitService` (already exported from there for
 * `McpOAuthController`'s own use) -- an explicit `useFactory`/`inject`
 * provider is used (rather than plain constructor-injection registration of
 * `ConnectedSearchService` itself) because `./connected-search.service.ts`
 * deliberately imports those two services as TYPES ONLY (see that file's own
 * header comment: a real/value import would pull in `../config/env.js`'s
 * eager `readEnv()` at module-load time, crashing this module's own
 * plain-unit-test-free -- but `./connected-search.service.test.ts`'s -- module
 * graph). Real class references (needed as Nest DI tokens) live HERE
 * instead, in a file no plain unit test ever statically imports.
 */
@Module({
  imports: [DbModule, AuthModule, EmbeddingProviderModule, IntegrationsModule],
  controllers: [SearchController],
  providers: [
    SearchService,
    WorkspaceMembershipGuard,
    WorkspaceMembershipService,
    {
      provide: ConnectedSearchService,
      useFactory: (
        credentials: ConnectorCredentialsService,
        rateLimit: ConnectorRateLimitService,
      ): ConnectedSearchService => new ConnectedSearchService(credentials, rateLimit),
      inject: [ConnectorCredentialsService, ConnectorRateLimitService],
    },
  ],
  exports: [SearchService, ConnectedSearchService],
})
export class SearchModule {}
