import { Module } from '@nestjs/common';

import { FederationLinkCredentialsService } from './federation-link-credentials.service.js';
import { FederationLinksService } from './federation-links.service.js';
import { FederationScopeService } from './federation-scope.service.js';
import { DbModule } from '../db/db.module.js';

/**
 * F3-T14 PR1 (ADR-0048): wires the federation domain services into
 * `AppModule` -- no controllers yet (PR2 adds `FederationMcpController` /
 * `FederationLinksController` / `FederationScopeController`), this PR only
 * needs DI to work so `app.get(...)` can resolve these services.
 */
@Module({
  imports: [DbModule],
  providers: [FederationLinksService, FederationScopeService, FederationLinkCredentialsService],
  exports: [FederationLinksService, FederationScopeService, FederationLinkCredentialsService],
})
export class FederationModule {}
