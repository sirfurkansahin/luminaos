import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import { ForbiddenError, NotFoundError, UnauthorizedError } from '@luminaos/shared';

import { ConnectorCredentialsService } from './connector-credentials.service.js';
import {
  MCP_OAUTH_PROVIDER_CONFIGS,
  getMcpOAuthProviderConfig,
} from './mcp-oauth-provider-configs.js';
import { OAuthStateService } from './oauth-state.service.js';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
} from './oauth2-authorization-code-flow.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { env } from '../config/env.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { Request, Response } from 'express';

/**
 * F2-T10 PR1 (ADR-0026 §i/§j/§l/§m/§n): the FIRST public REST endpoints this
 * codebase adds for MCP connector OAuth. Two routes, deliberately at
 * DIFFERENT path shapes (ADR-0026 §j, a documented, human-approved deviation
 * from the spec's literal callback URL text):
 *
 * - `POST /workspaces/:workspaceId/integrations/:connectorType/oauth/authorize`
 *   -- guarded (`SessionAuthGuard` + `WorkspaceMembershipGuard`), starts the
 *   flow, issues an `OAuthStateService` state row.
 * - `GET /integrations/:connectorType/oauth/callback` -- deliberately NO
 *   `:workspaceId` segment and NO guards: the provider's own top-level
 *   browser redirect lands here; correlation is entirely via the opaque
 *   `state` value (ADR-0026 §i), never `req.user`/`req.membership`. Provider
 *   `redirect_uri` registration is workspace-independent by necessity
 *   (exact-match requirement, incompatible with a dynamic workspace count).
 *
 * Two additional minimal routes complete the ADR-0026 §n Kabul Kriteri
 * ("bağlı/bağlı-değil durumu görünüyor, bağlan/bağlantı-kes çalışıyor") that
 * `apps/web`'s `IntegrationsPanel` needs -- neither is pinned by a dedicated
 * failing test in this PR, so their exact shape is implementer discretion,
 * kept deliberately minimal:
 *
 * - `GET /workspaces/:workspaceId/integrations` -- lists every connectorType
 *   this deployment knows an OAuth provider config for (ADR-0026 §l's
 *   `MCP_OAUTH_PROVIDER_CONFIGS`), each with `connected` = whether THIS
 *   (workspaceId, userId) pair has stored credentials for it.
 * - `DELETE /workspaces/:workspaceId/integrations/:connectorType` -- removes
 *   the caller's stored credentials for that connectorType (idempotent, same
 *   as `ConnectorCredentialsService.remove`'s own contract).
 */
@Controller()
export class McpOAuthController {
  constructor(
    private readonly oauthStateService: OAuthStateService,
    private readonly connectorCredentialsService: ConnectorCredentialsService,
  ) {}

  @Post('workspaces/:workspaceId/integrations/:connectorType/oauth/authorize')
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  @HttpCode(HttpStatus.CREATED)
  async authorize(
    @Param('workspaceId') workspaceId: string,
    @Param('connectorType') connectorType: string,
    @Req() req: Request,
  ): Promise<{ authorizeUrl: string }> {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const providerConfig = getMcpOAuthProviderConfig(connectorType);
    if (!providerConfig) {
      // Kabul Kriteri (ADR-0026 §n): an unconfigured connectorType is
      // rejected, never silently succeeding with a broken authorizeUrl.
      throw new NotFoundError(`Connector "${connectorType}" is not configured`);
    }

    const state = await this.oauthStateService.issue(workspaceId, req.user.id, connectorType);
    const authorizeUrl = buildAuthorizationUrl(providerConfig, state);

    return { authorizeUrl };
  }

  @Get('integrations/:connectorType/oauth/callback')
  @HttpCode(HttpStatus.FOUND)
  async callback(
    @Param('connectorType') connectorType: string,
    @Query('state') state: unknown,
    @Query('code') code: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (typeof state !== 'string' || state.length === 0) {
      throw new ForbiddenError('OAuth state token is invalid.');
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw new ForbiddenError('OAuth state token is invalid.');
    }

    // Single-use, atomic: throws ForbiddenError for unknown/expired/already-
    // consumed state (ADR-0026 §i) -- correlation comes ONLY from this row,
    // never from any request-supplied workspace/user identifier.
    const consumed = await this.oauthStateService.consume(state);

    // The URL's `:connectorType` segment is unauthenticated request input
    // (an attacker holding a legitimate state+code for one connector could
    // alter it before the request reaches the server). Cross-check it
    // against the state row's OWN connectorType -- the one value ADR-0026
    // §i actually trusts -- before using it to pick a provider config or
    // store credentials. Same no-oracle message as every other state
    // failure, so this can't be used to probe which connectorType a state
    // token was really issued for.
    if (connectorType !== consumed.connectorType) {
      throw new ForbiddenError('OAuth state token is invalid.');
    }
    const { workspaceId, userId } = consumed;

    const providerConfig = getMcpOAuthProviderConfig(connectorType);
    if (!providerConfig) {
      throw new NotFoundError(`Connector "${connectorType}" is not configured`);
    }

    const tokenResult = await exchangeAuthorizationCode(providerConfig, code);

    await this.connectorCredentialsService.store(workspaceId, userId, connectorType, {
      accessToken: tokenResult.accessToken,
      ...(tokenResult.refreshToken !== undefined ? { refreshToken: tokenResult.refreshToken } : {}),
      ...(tokenResult.expiresAt !== undefined ? { expiresAt: tokenResult.expiresAt } : {}),
    });

    // Fixed, env-derived redirect target ONLY -- never a client-supplied
    // `?returnTo=` or similar (ADR-0026 §j anti-open-redirect design).
    res.redirect(HttpStatus.FOUND, `${env.webOrigin}/`);
  }

  @Get('workspaces/:workspaceId/integrations')
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  async list(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
  ): Promise<{ connectors: { connectorType: string; connected: boolean }[] }> {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    const userId = req.user.id;

    const connectors = await Promise.all(
      Object.keys(MCP_OAUTH_PROVIDER_CONFIGS).map(async (connectorType) => {
        const stored = await this.connectorCredentialsService.retrieve(
          workspaceId,
          userId,
          connectorType,
        );
        return { connectorType, connected: stored !== undefined };
      }),
    );

    return { connectors };
  }

  @Delete('workspaces/:workspaceId/integrations/:connectorType')
  @UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnect(
    @Param('workspaceId') workspaceId: string,
    @Param('connectorType') connectorType: string,
    @Req() req: Request,
  ): Promise<void> {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    await this.connectorCredentialsService.remove(workspaceId, req.user.id, connectorType);
  }
}
